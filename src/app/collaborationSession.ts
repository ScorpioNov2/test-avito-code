import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { Awareness } from 'y-protocols/awareness';

export interface RoomMember {
  clientId: number;
  name: string;
  color: string;
  isMe: boolean;
}

const ROOM_URL_PARAM = 'room';
const ROOM_ID_PATTERN = /^[\w-]{4,64}$/;
const MEMBER_COLORS = ['#6b3fa0', '#b4413a', '#1f7a5a', '#2563eb', '#b45309', '#0e7490', '#9d174d', '#4d5b0c'];

const customSignalingUrls: string[] = ((import.meta.env.VITE_SIGNALING_URLS as string | undefined) ?? '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

export class CollaborationSession {
  readonly document = new Y.Doc();
  readonly sharedCode = this.document.getText('code');
  readonly sharedSettings = this.document.getMap<string>('settings');
  readonly awareness = new Awareness(this.document);

  private provider: WebrtcProvider | null = null;
  private roomId: string | null = null;
  private lastMembersKey = '';

  constructor(displayName: string) {
    this.awareness.setLocalStateField('user', {
      name: displayName,
      color: MEMBER_COLORS[this.awareness.clientID % MEMBER_COLORS.length],
    });
  }

  static readRoomIdFromUrl(): string | null {
    const roomId = new URLSearchParams(window.location.hash.slice(1)).get(ROOM_URL_PARAM);
    return roomId && ROOM_ID_PATTERN.test(roomId) ? roomId : null;
  }

  static parseRoomId(input: string): string | null {
    const text = input.trim();
    if (ROOM_ID_PATTERN.test(text)) return text;
    const match = /(?:^|[#?&])room=([\w-]{4,64})(?![\w-])/.exec(text);
    return match ? match[1] : null;
  }

  static buildRoomLink(roomId: string): string {
    return `${window.location.origin}${window.location.pathname}#${ROOM_URL_PARAM}=${roomId}`;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

    private async initializeIceServers(): Promise<any[]> {
    // Kiểm tra xem mảng biến môi trường có link Supabase nào không
    if (customSignalingUrls.length === 0) return [];

    try {
      // 1. Lấy ra chuỗi link đầu tiên từ mảng: "wss://...supabase.co/functions/v1/signaling"
      const firstSignalingUrl = customSignalingUrls[0];
      
      // 2. Chuyển đổi an toàn từ wss:// sang https:// và nối thêm /ice-servers vào cuối
      const apiHttpUrl = `${firstSignalingUrl.replace(/^wss:/, 'https:')}/ice-servers`;
      
      console.log(`[ICE] Requesting secure tokens from: ${apiHttpUrl}`);

      const response = await fetch(apiHttpUrl);
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      console.error('Failed to fetch dynamic secure ICE servers from backend:', error);
    }

    return [];
  }

  joinRoom(roomId: string): void {
    if (this.provider) return;
    this.roomId = roomId;

    // Khởi tạo nhanh với mảng trống để giữ luồng đồng bộ cho UI
    this.provider = new WebrtcProvider(`avito-code:${roomId}`, this.document, {
      awareness: this.awareness,
      ...(customSignalingUrls.length > 0 ? { signaling: customSignalingUrls } : {}),
      peerOpts: {
        config: {
          iceServers: []
        }
      }
    });

    // Chạy ngầm nạp mảng Xirsys (gồm cả STUN và TURN sạch) từ Supabase vào luồng kết nối P2P
    this.initializeIceServers().then((dynamicIceServers) => {
      if (this.provider && this.provider.peerOpts && this.provider.peerOpts.config && dynamicIceServers.length > 0) {
        this.provider.peerOpts.config.iceServers = dynamicIceServers;
        console.log('[ICE] Secure Xirsys STUN/TURN servers injected successfully.');
      }
    });
  }

  createRoom(): string {
    const randomBytes = crypto.getRandomValues(new Uint8Array(6));
    const roomId = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    this.joinRoom(roomId);
    window.history.replaceState(null, '', CollaborationSession.buildRoomLink(roomId));
    return roomId;
  }

  setLocalName(name: string): void {
    const currentUser = this.awareness.getLocalState()?.user as { name: string; color: string } | undefined;
    this.awareness.setLocalStateField('user', { ...currentUser, name });
  }

  getMembers(): RoomMember[] {
    const members: RoomMember[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      const user = state.user as { name?: string; color?: string } | undefined;
      if (!user?.name) return;
      members.push({ clientId, name: user.name, color: user.color ?? MEMBER_COLORS[0], isMe: clientId === this.awareness.clientID });
    });
    return members.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.clientId - b.clientId);
  }

  onMembersChanged(listener: (members: RoomMember[]) => void): void {
    const notifyIfChanged = (): void => {
      const members = this.getMembers();
      const key = JSON.stringify(members);
      if (key === this.lastMembersKey) return;
      this.lastMembersKey = key;
      listener(members);
    };
    this.awareness.on('change', notifyIfChanged);
    notifyIfChanged();
  }
}
