import type { AssetLoader } from './types';

/** Tăng số này khi bạn thay file trong public/wasm/ để trình duyệt tải lại thay vì dùng bản cache cũ. */
const ASSET_CACHE_VERSION = 1;
export const WASM_ASSET_CACHE_NAME_PREFIX = 'avito-code-wasm-assets-v';
const CACHE_NAME = `${WASM_ASSET_CACHE_NAME_PREFIX}${ASSET_CACHE_VERSION}`;

/** Tải file từ public/wasm/ và lưu vào Cache Storage (file hàng chục MB chỉ tải một lần). */
export function createBrowserAssetLoader(): AssetLoader {
  return async (relativePath) => {
    const url = `${import.meta.env.BASE_URL}wasm/${relativePath}`;
    const cache = typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);

    const cachedResponse = await cache?.match(url);
    if (cachedResponse) return cachedResponse.arrayBuffer();

    const response = await fetch(url);
    // Dev server trả index.html (HTTP 200) cho file không tồn tại, nên phải kiểm tra thêm content-type.
    const isMissing = !response.ok || (response.headers.get('content-type') ?? '').includes('text/html');
    if (isMissing) {
      throw new Error(`Missing ${relativePath}. Run "npm run fetch-wasm" to download the toolchain into public/wasm/.`);
    }
    await cache?.put(url, response.clone());
    return response.arrayBuffer();
  };
}
