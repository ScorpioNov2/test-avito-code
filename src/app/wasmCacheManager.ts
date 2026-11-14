import { requireElement } from './domElements';
import { WASM_ASSET_CACHE_NAME_PREFIX } from '../languages/toolchains/browserAssetLoader';

type LibraryId = 'clang' | 'rust' | 'java';

interface LibraryDefinition {
  id: LibraryId;
  label: string;
  detail: string;
  color: string;
}

interface LibraryUsage extends LibraryDefinition {
  bytes: number;
  entries: number;
}

interface CacheSummary {
  libraries: LibraryUsage[];
  totalBytes: number;
}

const LIBRARIES: LibraryDefinition[] = [
  { id: 'clang', label: 'C / C++', detail: 'Clang compiler and sysroot', color: '#61A9BD' },
  { id: 'rust', label: 'Rust', detail: 'Miri interpreter and sysroot', color: '#E98E2E' },
  { id: 'java', label: 'Java', detail: 'TeaVM compiler and runtime', color: '#44986D' },
];

function getLibraryId(requestUrl: string): LibraryId | null {
  try {
    const pathname = new URL(requestUrl).pathname;
    const wasmPathIndex = pathname.indexOf('/wasm/');
    if (wasmPathIndex < 0) return null;
    const directory = pathname.slice(wasmPathIndex + '/wasm/'.length).split('/')[0]?.toLowerCase();
    return LIBRARIES.find((library) => library.id === directory)?.id ?? null;
  } catch {
    return null;
  }
}

async function measureResponseBytes(response: Response): Promise<number> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.arrayBuffer()).byteLength;

  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes;
}

async function readCacheSummary(): Promise<CacheSummary> {
  if (typeof caches === 'undefined') throw new Error('Cache Storage is not available in this browser.');

  const usageByLibrary = new Map<LibraryId, { bytes: number; entries: number }>(
    LIBRARIES.map((library) => [library.id, { bytes: 0, entries: 0 }]),
  );
  const cacheNames = (await caches.keys()).filter((name) => name.startsWith(WASM_ASSET_CACHE_NAME_PREFIX));

  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      const libraryId = getLibraryId(request.url);
      if (!libraryId) continue;

      const response = await cache.match(request);
      if (!response) continue;
      const usage = usageByLibrary.get(libraryId);
      if (!usage) continue;
      usage.entries += 1;
      try {
        usage.bytes += await measureResponseBytes(response);
      } catch {
        // Một file không đọc được không làm hỏng phần thống kê của các thư viện khác.
      }
    }
  }

  const libraries = LIBRARIES.map((library) => ({
    ...library,
    ...(usageByLibrary.get(library.id) ?? { bytes: 0, entries: 0 }),
  }));
  return {
    libraries,
    totalBytes: libraries.reduce((total, library) => total + library.bytes, 0),
  };
}

async function clearLibraryEntries(libraryId: LibraryId): Promise<number> {
  if (typeof caches === 'undefined') throw new Error('Cache Storage is not available in this browser.');

  let deletedEntries = 0;
  const cacheNames = (await caches.keys()).filter((name) => name.startsWith(WASM_ASSET_CACHE_NAME_PREFIX));
  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      if (getLibraryId(request.url) === libraryId && await cache.delete(request)) deletedEntries += 1;
    }
  }
  return deletedEntries;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 10 ? 1 : 2 }).format(value)} ${units[unitIndex]}`;
}

export class WasmCacheManager {
  private readonly refreshButton = requireElement<HTMLButtonElement>('wasm-cache-refresh-button');
  private readonly totalElement = requireElement<HTMLElement>('wasm-cache-total');
  private readonly barElement = requireElement<HTMLElement>('wasm-cache-bar');
  private readonly libraryList = requireElement<HTMLElement>('wasm-cache-libraries');
  private readonly statusElement = requireElement<HTMLElement>('wasm-cache-status');
  private readonly confirmDialog = requireElement<HTMLDialogElement>('wasm-cache-confirm-dialog');
  private readonly confirmMessage = requireElement<HTMLElement>('wasm-cache-confirm-message');
  private readonly confirmCancelButton = requireElement<HTMLButtonElement>('wasm-cache-confirm-cancel-button');
  private readonly confirmClearButton = requireElement<HTMLButtonElement>('wasm-cache-confirm-clear-button');
  private isBusy = false;
  private pendingLibraryId: LibraryId | null = null;

  constructor() {
    this.refreshButton.addEventListener('click', () => void this.refresh());
    this.confirmCancelButton.addEventListener('click', () => {
      this.pendingLibraryId = null;
      this.confirmDialog.close();
    });
    this.confirmDialog.addEventListener('cancel', () => {
      this.pendingLibraryId = null;
    });
    this.confirmClearButton.addEventListener('click', () => this.confirmClearLibrary());
    this.libraryList.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('button[data-library-id]');
      const libraryId = button?.dataset.libraryId;
      if (libraryId === 'clang' || libraryId === 'rust' || libraryId === 'java') {
        this.requestClearConfirmation(libraryId);
      }
    });
  }

  async refresh(): Promise<void> {
    if (this.isBusy) return;
    this.isBusy = true;
    this.setControlsDisabled(true);
    this.totalElement.textContent = 'Calculating…';
    this.statusElement.textContent = 'Scanning saved WebAssembly files…';

    try {
      this.render(await readCacheSummary());
      this.statusElement.textContent = '';
    } catch (error) {
      this.totalElement.textContent = 'Unavailable';
      this.barElement.replaceChildren();
      this.libraryList.replaceChildren();
      this.statusElement.textContent = error instanceof Error ? error.message : 'Unable to read browser cache.';
    } finally {
      this.isBusy = false;
      this.setControlsDisabled(false);
    }
  }

  private render(summary: CacheSummary): void {
    this.totalElement.textContent = formatBytes(summary.totalBytes);
    this.barElement.replaceChildren();

    for (const library of summary.libraries) {
      const segment = document.createElement('span');
      segment.className = 'wasm-cache-bar__segment';
      segment.style.width = summary.totalBytes > 0 ? `${(library.bytes / summary.totalBytes) * 100}%` : '0%';
      segment.style.backgroundColor = library.color;
      segment.setAttribute('aria-hidden', 'true');
      this.barElement.append(segment);
    }
    this.barElement.setAttribute(
      'aria-label',
      `Managed WebAssembly cache: ${summary.libraries.map((library) => `${library.label} ${formatBytes(library.bytes)}`).join(', ')}`,
    );

    this.renderLibraries(summary);
  }

  private renderLibraries(summary: CacheSummary): void {
    this.libraryList.replaceChildren();
    for (const library of summary.libraries) {
      const share = summary.totalBytes > 0 ? Math.round((library.bytes / summary.totalBytes) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'wasm-cache-library';

      const info = document.createElement('div');
      info.className = 'wasm-cache-library__info';
      const name = document.createElement('div');
      name.className = 'wasm-cache-library__name';
      const swatch = document.createElement('span');
      swatch.className = 'wasm-cache-library__swatch';
      swatch.style.backgroundColor = library.color;
      swatch.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong');
      label.textContent = library.label;
      name.append(swatch, label);

      const detail = document.createElement('div');
      detail.className = 'wasm-cache-library__detail';
      detail.textContent = `${library.detail} · ${formatBytes(library.bytes)} · ${library.entries} files · ${share}%`;
      info.append(name, detail);

      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'button button--secondary wasm-cache-clear';
      clearButton.dataset.libraryId = library.id;
      clearButton.dataset.hasEntries = String(library.entries > 0);
      clearButton.textContent = 'Clear';
      clearButton.setAttribute('aria-label', `Clear ${library.label} cache`);
      clearButton.disabled = this.isBusy || library.entries === 0;

      row.append(info, clearButton);
      this.libraryList.append(row);
    }
  }

  private requestClearConfirmation(libraryId: LibraryId): void {
    if (this.isBusy) return;
    const library = LIBRARIES.find((item) => item.id === libraryId);
    if (!library) return;
    this.pendingLibraryId = libraryId;
    this.confirmMessage.textContent = `Clear the cached ${library.label} files? They will be downloaded again when needed.`;
    this.confirmDialog.showModal();
  }

  private confirmClearLibrary(): void {
    const libraryId = this.pendingLibraryId;
    this.pendingLibraryId = null;
    this.confirmDialog.close();
    if (libraryId) void this.clearLibrary(libraryId);
  }

  private async clearLibrary(libraryId: LibraryId): Promise<void> {
    if (this.isBusy) return;
    const library = LIBRARIES.find((item) => item.id === libraryId);
    if (!library) return;
    this.isBusy = true;
    this.setControlsDisabled(true);
    this.statusElement.textContent = `Clearing ${library.label} cache…`;
    try {
      const deletedEntries = await clearLibraryEntries(libraryId);
      this.render(await readCacheSummary());
      this.statusElement.textContent = `${library.label} cache cleared (${deletedEntries} files removed). It will download again when needed.`;
    } catch (error) {
      this.statusElement.textContent = error instanceof Error ? error.message : `Unable to clear ${library.label} cache.`;
    } finally {
      this.isBusy = false;
      this.setControlsDisabled(false);
    }
  }

  private setControlsDisabled(disabled: boolean): void {
    this.refreshButton.disabled = disabled;
    this.libraryList.querySelectorAll<HTMLButtonElement>('button[data-library-id]').forEach((button) => {
      button.disabled = disabled || button.dataset.hasEntries !== 'true';
    });
  }
}
