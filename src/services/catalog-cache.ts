import { waitUntil } from 'cloudflare:workers';
const CACHE_VERSION = 'v1';
const CATALOG_TTL_SECONDS = 3600;
type CatalogSnapshot<T> = { value: T[]; expiresAt: number };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function cacheKey(path: string): string {
  // Only public normalized catalogs enter this namespace; never request/player data.
  // Bump the version when the normalized representation or its interpretation changes.
  return `https://api.tarkovtracker.org/.internal/catalog-cache/${CACHE_VERSION}/${path}`;
}
async function readSnapshot<T>(
  cache: Cache,
  key: string,
  validEntry: (value: Record<string, unknown>) => boolean
): Promise<CatalogSnapshot<T> | null> {
  const response = await cache.match(key);
  if (!response) return null;
  const snapshot: unknown = await response.json();
  if (!isRecord(snapshot)) return null;
  const { value, expiresAt } = snapshot;
  if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) return null;
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + CATALOG_TTL_SECONDS * 1000)
    return null;
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every((entry) => isRecord(entry) && validEntry(entry))) return null;
  return { value: value as T[], expiresAt };
}
/** Reuse compact public data across isolates without extending its original one-hour lifetime. */
export async function loadCatalogSnapshot<T>(
  path: string,
  load: () => Promise<T[]>,
  validEntry: (value: Record<string, unknown>) => boolean
): Promise<CatalogSnapshot<T>> {
  const cache = typeof caches === 'undefined' ? undefined : caches.default;
  const key = cacheKey(path);
  if (cache) {
    try {
      const snapshot = await readSnapshot<T>(cache, key, validEntry);
      if (snapshot) return snapshot;
    } catch {
      // Cache availability is optional; required upstream rules still fail closed.
    }
  }
  const value = await load();
  const snapshot = {
    value,
    expiresAt: Date.now() + CATALOG_TTL_SECONDS * 1000,
  };
  if (cache) {
    const response = Response.json(snapshot, {
      headers: { 'Cache-Control': `public, max-age=${CATALOG_TTL_SECONDS}` },
    });
    waitUntil(cache.put(key, response).catch(() => {}));
  }
  return snapshot;
}
