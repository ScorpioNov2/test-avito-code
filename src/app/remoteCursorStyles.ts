import type { Awareness } from 'y-protocols/awareness';

const SAFE_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_LABEL_LENGTH = 24;

/** Dữ liệu từ máy khác gửi tới là không đáng tin: chỉ cho phép màu dạng #rrggbb. */
const toSafeColor = (color: unknown): string => (typeof color === 'string' && SAFE_COLOR_PATTERN.test(color) ? color : '#6b7280');
const toSafeCssText = (text: unknown): string => String(text ?? 'Guest').replace(/[\\"\n\r]/g, '').slice(0, MAX_LABEL_LENGTH);

/** Tìm các awareness cũ trùng tab session để ẩn con trỏ, không xóa trạng thái của client khác. */
function getDuplicatePageSessionClients(awareness: Awareness): Set<number> {
  const latestByPageSession = new Map<string, { clientId: number; lastUpdated: number }>();
  const pageSessionByClient = new Map<number, string>();

  awareness.getStates().forEach((state, clientId) => {
    const user = state.user as { pageSessionId?: string } | undefined;
    const pageSessionId = user?.pageSessionId;
    if (typeof pageSessionId !== 'string' || pageSessionId.length === 0 || pageSessionId.length > 128) return;

    pageSessionByClient.set(clientId, pageSessionId);
    const lastUpdated = awareness.meta.get(clientId)?.lastUpdated ?? 0;
    const existing = latestByPageSession.get(pageSessionId);
    if (
      !existing ||
      clientId === awareness.clientID ||
      (existing.clientId !== awareness.clientID && lastUpdated >= existing.lastUpdated)
    ) {
      latestByPageSession.set(pageSessionId, { clientId, lastUpdated });
    }
  });

  const duplicates = new Set<number>();
  pageSessionByClient.forEach((pageSessionId, clientId) => {
    if (latestByPageSession.get(pageSessionId)?.clientId !== clientId) duplicates.add(clientId);
  });
  return duplicates;
}

/**
 * y-monaco gắn class `yRemoteSelection-<clientId>` / `yRemoteSelectionHead-<clientId>` cho con trỏ người khác.
 * Hàm này sinh CSS màu + nhãn tên cho từng người, tự cập nhật khi có người vào/ra/đổi tên.
 */
export function keepRemoteCursorStylesInSync(awareness: Awareness): void {
  const styleElement = document.createElement('style');
  document.head.append(styleElement);

  const renderStyles = (): void => {
    const rules: string[] = [];
    const duplicateClients = getDuplicatePageSessionClients(awareness);
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return;
      const user = state.user as { name?: string; color?: string } | undefined;
      if (!user) return;
      if (duplicateClients.has(clientId)) {
        rules.push(`.yRemoteSelection-${clientId}, .yRemoteSelectionHead-${clientId} { display: none !important; }`);
        return;
      }
      const color = toSafeColor(user.color);
      rules.push(
        `.yRemoteSelection-${clientId} { background-color: ${color}33; }`,
        `.yRemoteSelectionHead-${clientId} { border-left: 2px solid ${color}; }`,
        `.yRemoteSelectionHead-${clientId}::after { content: "${toSafeCssText(user.name)}"; background: ${color}; }`,
      );
    });
    styleElement.textContent = rules.join('\n');
  };

  awareness.on('change', renderStyles);
  renderStyles();
}
