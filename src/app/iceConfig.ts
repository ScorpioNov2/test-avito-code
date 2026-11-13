/**
 * Cấu hình ICE (STUN/TURN) cho WebRTC.
 *
 * Mặc định simple-peer (thư viện dưới y-webrtc) CHỈ có STUN. STUN chỉ giúp hai máy tìm ra địa chỉ công khai của nhau, nên
 * kết nối trực tiếp được khi cùng WiFi hoặc khi NAT "dễ tính", nhưng KHÔNG được khi một bên dùng dữ liệu di động (nhà mạng thường
 * dùng CGNAT/NAT đối xứng). Khi đó bắt buộc phải có TURN: máy chủ trung gian chuyển tiếp dữ liệu.
 */
export interface IceConfig {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
}

export interface IceConfigSources {
  /** Danh sách signaling server; /turn-credentials được suy ra từ server đầu tiên nếu không có turnCredentialsUrl. */
  signalingUrls: string[];
  /** JSON mảng ICE server cố định (ví dụ coturn tự dựng). Lưu ý: tên đăng nhập/mật khẩu sẽ nằm trong mã gửi tới trình duyệt. */
  staticIceServersJson?: string;
  /** URL lấy thông tin TURN ngắn hạn từ Worker. */
  turnCredentialsUrl?: string;
  /** "relay" = chỉ đi qua TURN (để kiểm tra TURN có hoạt động không). Mặc định "all". */
  transportPolicy?: string;
}

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];
const FETCH_TIMEOUT_MS = 4000;
const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):\S+$/i;
const TURN_URL_PATTERN = /^turns?:/i;

/** Chỉ giữ lại ICE server hợp lệ. Một mục sai (ví dụ turn: thiếu mật khẩu) làm RTCPeerConnection ném lỗi và hỏng MỌI kết nối. */
export function sanitizeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];
  const result: RTCIceServer[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { urls, username, credential } = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urlList = (Array.isArray(urls) ? urls : [urls]).filter((url): url is string => typeof url === 'string' && ICE_URL_PATTERN.test(url));
    if (urlList.length === 0) continue;
    const needsLogin = urlList.some((url) => TURN_URL_PATTERN.test(url));
    const hasLogin = typeof username === 'string' && typeof credential === 'string';
    if (needsLogin && !hasLogin) continue;
    result.push(hasLogin ? { urls: urlList, username, credential } : { urls: urlList });
  }
  return result;
}

/** Convert the signaling URL to the matching TURN-credentials endpoint. */
export function deriveTurnCredentialsUrl(signalingUrls: string[]): string | null {
  for (const signalingUrl of signalingUrls) {
    try {
      const url = new URL(signalingUrl);
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') continue;
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      const path = url.pathname.replace(/\/+$/, '');
      // Supabase Edge Functions expose this app's ICE endpoint beside /signaling.
      // Preserve the /functions/v1/<function> prefix instead of replacing it.
      url.pathname = /\/functions\/v1\/[^/]+$/i.test(path)
        ? `${path}/ice-servers`
        : '/turn-credentials';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // URL sai định dạng: thử cái tiếp theo
    }
  }
  return null;
}

function parseStaticIceServers(json: string | undefined): RTCIceServer[] {
  if (!json?.trim()) return [];
  try {
    return sanitizeIceServers(JSON.parse(json));
  } catch {
    console.warn('[avito-code] VITE_ICE_SERVERS is not valid JSON; ignoring it.');
    return [];
  }
}

async function fetchTurnServers(url: string, fetchImplementation: typeof fetch): Promise<RTCIceServer[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const iceServers = Array.isArray(payload)
      ? payload
      : (payload as { iceServers?: unknown } | null)?.iceServers;
    return sanitizeIceServers(iceServers);
  } catch (error) {
    // Không có TURN thì vẫn dùng được khi cùng mạng / NAT dễ tính, nên chỉ cảnh báo chứ không dừng.
    console.warn(`[avito-code] Could not get TURN credentials (${error instanceof Error ? error.message : String(error)}). Falling back to STUN only: people on mobile data or strict networks may be unable to connect.`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadIceConfig(sources: IceConfigSources, fetchImplementation: typeof fetch = fetch): Promise<IceConfig> {
  const turnUrl = sources.turnCredentialsUrl?.trim() || deriveTurnCredentialsUrl(sources.signalingUrls);
  const fetched = turnUrl ? await fetchTurnServers(turnUrl, fetchImplementation) : [];

  // Cùng một server có thể được liệt kê dưới dạng chuỗi hoặc mảng, nên so sánh theo nội dung đã chuẩn hoá.
  const unique = new Map<string, RTCIceServer>();
  for (const server of [...DEFAULT_STUN_SERVERS, ...parseStaticIceServers(sources.staticIceServersJson), ...fetched]) {
    const urls = (Array.isArray(server.urls) ? [...server.urls] : [server.urls]).sort();
    unique.set(JSON.stringify([urls, server.username, server.credential]), server);
  }
  return {
    iceServers: [...unique.values()],
    iceTransportPolicy: sources.transportPolicy?.trim() === 'relay' ? 'relay' : 'all',
  };
}
