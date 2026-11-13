/**
 * Signaling server cho y-webrtc chạy trên Cloudflare Workers (Durable Object + WebSocket hibernation).
 * Nó chỉ chuyển tiếp thông tin kết nối WebRTC giữa các máy trong cùng một phòng; KHÔNG thấy nội dung code.
 *
 * Giao thức (giống y-webrtc/bin/server.js):
 *   { type: 'subscribe',   topics: string[] }   đăng ký nhận tin của phòng
 *   { type: 'unsubscribe', topics: string[] }
 *   { type: 'publish',     topic: string, ... } gửi cho mọi máy đã đăng ký phòng đó (kèm `clients` = số máy)
 *   { type: 'ping' }  ->  { type: 'pong' }
 *
 * Ngoài ra có GET /turn-credentials: cấp thông tin TURN ngắn hạn cho trình duyệt (bí mật API nằm ở đây, không lộ ra trình duyệt).
 */

interface Env {
  SIGNALING_HUB: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
  /** Cloudflare Realtime TURN (tuỳ chọn, xem README mục "TURN"). Thiếu một trong hai thì /turn-credentials trả 501. */
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  /** Chỉ đặt khi kiểm thử cục bộ với một API giả. */
  TURN_API_BASE?: string;
}

interface SocketState {
  topics: string[];
}

// Dữ liệu đính kèm WebSocket bị giới hạn ~2KB, nên giới hạn số phòng mỗi kết nối.
const MAX_TOPICS_PER_SOCKET = 16;
const MAX_TOPIC_LENGTH = 100;

function isOriginAllowed(request: Request, allowedOrigins: string): boolean {
  const allowList = allowedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (allowList.length === 0) return true;
  const origin = request.headers.get('Origin');
  return origin !== null && allowList.includes(origin);
}

const TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TURN_CREDENTIAL_TTL_SECONDS = 86400;
/** Dùng lại cùng một bộ thông tin cho mọi người trong nửa thời hạn của nó, để không gọi API của Cloudflare liên tục. */
const TURN_CACHE_MS = (TURN_CREDENTIAL_TTL_SECONDS / 2) * 1000;

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

let cachedIceServers: { expiresAt: number; iceServers: IceServer[] } | null = null;

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } });
}

/** Cloudflare trả cả cổng 53; trình duyệt chặn/chậm với cổng này, nên bỏ đi. */
function withoutPort53(servers: IceServer[]): IceServer[] {
  return servers
    .map((server) => ({ ...server, urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => !/:53(?:\?|$)/.test(url)) }))
    .filter((server) => server.urls.length > 0);
}

async function requestIceServersFromCloudflare(env: Env): Promise<IceServer[]> {
  const response = await fetch(`${env.TURN_API_BASE ?? TURN_API_BASE}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
  });
  if (!response.ok) throw new Error(`Cloudflare TURN API returned HTTP ${response.status}`);
  const data = (await response.json()) as { iceServers?: IceServer | IceServer[] };
  const servers = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
  return withoutPort53(servers);
}

async function handleTurnCredentials(request: Request, env: Env): Promise<Response> {
  if (!isOriginAllowed(request, env.ALLOWED_ORIGINS)) return jsonResponse({ error: 'Origin not allowed' }, 403);
  const cors = { 'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '*', Vary: 'Origin' };

  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return jsonResponse({ error: 'TURN is not configured on this server' }, 501, cors);

  if (!cachedIceServers || cachedIceServers.expiresAt <= Date.now()) {
    try {
      cachedIceServers = { iceServers: await requestIceServersFromCloudflare(env), expiresAt: Date.now() + TURN_CACHE_MS };
    } catch (error) {
      console.error('TURN credentials request failed:', error);
      return jsonResponse({ error: 'Could not get TURN credentials' }, 502, cors);
    }
  }
  return jsonResponse({ iceServers: cachedIceServers.iceServers }, 200, { ...cors, 'Cache-Control': 'private, max-age=300' });
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    if (new URL(request.url).pathname === '/turn-credentials') return handleTurnCredentials(request, env);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('okay');
    if (!isOriginAllowed(request, env.ALLOWED_ORIGINS)) return new Response('Origin not allowed', { status: 403 });

    // Một Durable Object duy nhất giữ mọi phòng; đủ cho nhu cầu nhỏ và giúp các máy tìm thấy nhau.
    return env.SIGNALING_HUB.get(env.SIGNALING_HUB.idFromName('global')).fetch(request);
  },
};

export class SignalingHub implements DurableObject {
  constructor(private readonly ctx: DurableObjectState) {}

  fetch(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics: [] } satisfies SocketState);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): void {
    let message: { type?: string; topics?: unknown; topic?: unknown; [key: string]: unknown };
    try {
      message = JSON.parse(typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage));
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'subscribe':
        this.updateTopics(socket, (topics) => {
          for (const topic of this.validTopics(message.topics)) {
            if (!topics.includes(topic) && topics.length < MAX_TOPICS_PER_SOCKET) topics.push(topic);
          }
          return topics;
        });
        break;
      case 'unsubscribe':
        this.updateTopics(socket, (topics) => topics.filter((topic) => !this.validTopics(message.topics).includes(topic)));
        break;
      case 'publish':
        if (typeof message.topic === 'string') this.publish(message.topic, message);
        break;
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  webSocketClose(socket: WebSocket, code: number): void {
    // Mã 1005/1006 không được phép truyền lại khi đóng.
    socket.close(code >= 1000 && code < 1005 ? code : 1000);
  }

  private validTopics(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((topic): topic is string => typeof topic === 'string' && topic.length <= MAX_TOPIC_LENGTH) : [];
  }

  private updateTopics(socket: WebSocket, change: (topics: string[]) => string[]): void {
    const state = (socket.deserializeAttachment() as SocketState | null) ?? { topics: [] };
    socket.serializeAttachment({ topics: change([...state.topics]) } satisfies SocketState);
  }

  private publish(topic: string, message: Record<string, unknown>): void {
    const receivers = this.ctx.getWebSockets().filter((socket) => {
      const state = socket.deserializeAttachment() as SocketState | null;
      return state?.topics.includes(topic) ?? false;
    });
    const payload = JSON.stringify({ ...message, clients: receivers.length });
    for (const receiver of receivers) {
      try {
        receiver.send(payload);
      } catch {
        receiver.close();
      }
    }
  }
}
