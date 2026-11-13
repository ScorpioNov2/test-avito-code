import { createClient } from '@supabase/supabase-js';

/**
 * y-webrtc signaling relay backed by Supabase Realtime Broadcast.
 *
 * Each browser keeps its WebSocket to this Edge Function. The function relays
 * each room's messages through Supabase Realtime, so peers do not have to land
 * on the same Edge Function instance.
 */
const MAX_TOPICS_PER_SOCKET = 16;
const MAX_TOPIC_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const BROADCAST_EVENT = 'y-webrtc-signal';
const XIRSYS_URL = 'https://global.xirsys.net/_turn/AvitoCodeRuntime';

type SignalingMessage = {
  type: string;
  topic?: unknown;
  topics?: unknown;
  [key: string]: unknown;
};

type RealtimeClient = ReturnType<typeof createClient>;
type RealtimeChannel = ReturnType<RealtimeClient['channel']>;

type RoomRelay = {
  channel: RealtimeChannel;
  pending: SignalingMessage[];
  subscribed: boolean;
  closed: boolean;
  sending: boolean;
};

function getSupabaseKey(): string | null {
  const secretKeysJson = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretKeysJson) {
    try {
      const secretKeys = JSON.parse(secretKeysJson) as Record<string, unknown>;
      const defaultKey = secretKeys.default;
      if (typeof defaultKey === 'string' && defaultKey.length > 0) return defaultKey;
    } catch {
      // Fall through to the standard Edge Function secret variables.
    }
  }

  return Deno.env.get('SUPABASE_SECRET_KEY')
    ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    ?? null;
}

function isOriginAllowed(request: Request): boolean {
  const allowList = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowList.length === 0) return false;
  const origin = request.headers.get('origin');
  return origin !== null && allowList.includes(origin);
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function getXirsysIceServers(): Promise<unknown[]> {
  const authToken = Deno.env.get('XIRSYS_AUTH_TOKEN');
  if (!authToken) throw new Error('XIRSYS_AUTH_TOKEN is not configured');

  const response = await fetch(XIRSYS_URL, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${btoa(authToken)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ format: 'urls' }),
  });
  if (!response.ok) throw new Error(`Xirsys returned HTTP ${response.status}`);

  const payload = await response.json() as {
    v?: { iceServers?: unknown | unknown[] };
  };
  const servers = payload?.v?.iceServers;
  if (!servers) throw new Error('Xirsys response did not include ICE servers');
  return Array.isArray(servers) ? servers : [servers];
}

function makeRealtimeClient(): RealtimeClient | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const key = getSupabaseKey();
  if (!supabaseUrl || !key) return null;

  return createClient(supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

function validTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (topic): topic is string =>
      typeof topic === 'string'
      && topic.length > 0
      && topic.length <= MAX_TOPIC_LENGTH
      && /^[\w:-]+$/.test(topic),
  );
}

function sendJson(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function startRoomRelay(
  realtime: RealtimeClient,
  socket: WebSocket,
  topic: string,
  rooms: Map<string, RoomRelay>,
): void {
  const state: RoomRelay = {
    channel: realtime.channel(topic, {
      config: { broadcast: { self: false }, private: false },
    }),
    pending: [],
    subscribed: false,
    closed: false,
    sending: false,
  };
  rooms.set(topic, state);

  state.channel
    .on('broadcast', { event: BROADCAST_EVENT }, ({ payload }) => {
      if (!state.closed) sendJson(socket, payload);
    })
    .subscribe((status) => {
      if (state.closed) return;
      if (status === 'SUBSCRIBED') {
        state.subscribed = true;
        void flushPending(state, socket);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        socket.close(1011, 'Realtime relay unavailable');
      }
    });
}

async function flushPending(state: RoomRelay, socket: WebSocket): Promise<void> {
  if (state.sending || state.closed || !state.subscribed) return;
  state.sending = true;
  try {
    while (state.pending.length > 0 && !state.closed) {
      const message = state.pending.shift();
      if (!message) continue;
      const result = await state.channel.send({
        type: 'broadcast',
        event: BROADCAST_EVENT,
        payload: message,
      });
      if (result !== 'ok') throw new Error(`Realtime send failed: ${result}`);
    }
  } catch {
    socket.close(1011, 'Realtime relay unavailable');
  } finally {
    state.sending = false;
  }
}

async function removeRoom(
  realtime: RealtimeClient,
  topic: string,
  rooms: Map<string, RoomRelay>,
): Promise<void> {
  const state = rooms.get(topic);
  if (!state) return;
  state.closed = true;
  state.pending.length = 0;
  rooms.delete(topic);
  await realtime.removeChannel(state.channel);
}

async function handleSocketMessage(
  rawData: unknown,
  socket: WebSocket,
  realtime: RealtimeClient,
  rooms: Map<string, RoomRelay>,
): Promise<void> {
  if (typeof rawData !== 'string' || rawData.length > MAX_MESSAGE_LENGTH) return;

  let message: SignalingMessage;
  try {
    message = JSON.parse(rawData) as SignalingMessage;
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'subscribe') {
    for (const topic of validTopics(message.topics)) {
      if (rooms.has(topic)) continue;
      if (rooms.size >= MAX_TOPICS_PER_SOCKET) break;
      startRoomRelay(realtime, socket, topic, rooms);
    }
    return;
  }

  if (message.type === 'unsubscribe') {
    for (const topic of validTopics(message.topics)) {
      await removeRoom(realtime, topic, rooms);
    }
    return;
  }

  if (message.type === 'publish') {
    if (typeof message.topic !== 'string') return;
    const state = rooms.get(message.topic);
    if (!state || state.closed) return;
    state.pending.push(message);
    void flushPending(state, socket);
    return;
  }

  if (message.type === 'ping') sendJson(socket, { type: 'pong' });
}

async function handleIceServers(request: Request): Promise<Response> {
  const headers = corsHeaders(request);
  if (!isOriginAllowed(request)) return jsonResponse({ error: 'Origin not allowed' }, 403, headers);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, headers);

  try {
    return jsonResponse(await getXirsysIceServers(), 200, headers);
  } catch {
    // Do not log or return the Xirsys token or short-lived TURN credentials.
    return jsonResponse({ error: 'Could not get TURN credentials' }, 502, headers);
  }
}

Deno.serve((request) => {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/ice-servers')) return handleIceServers(request);
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Signaling relay is online', { status: 200 });
  }
  if (!isOriginAllowed(request)) return new Response('Origin not allowed', { status: 403 });

  const realtime = makeRealtimeClient();
  if (!realtime) return new Response('Supabase Realtime credentials are not configured', { status: 503 });

  const { socket, response } = Deno.upgradeWebSocket(request);
  const rooms = new Map<string, RoomRelay>();
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      await Promise.allSettled([...rooms.keys()].map((topic) => removeRoom(realtime, topic, rooms)));
      try {
        await realtime.removeAllChannels();
      } catch {
        // The client is already closing; there is no live relay to recover.
      }
    })();
    return cleanupPromise;
  };

  socket.onmessage = (event) => {
    void handleSocketMessage(event.data, socket, realtime, rooms).catch(() => {
      socket.close(1011, 'Realtime relay unavailable');
    });
  };
  socket.onclose = () => {
    void cleanup();
  };
  socket.onerror = () => {
    socket.close(1011, 'Realtime relay unavailable');
    void cleanup();
  };

  // Supabase recommends keeping the Edge Function alive until the upgraded
  // browser socket closes; otherwise the worker can retire the relay early.
  const connectionClosed = new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.addEventListener('error', () => resolve(), { once: true });
  });
  const edgeRuntime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;
  edgeRuntime?.waitUntil(connectionClosed.then(() => cleanup()));

  return response;
});
