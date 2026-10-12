// TarkovTracker Pages binds this Worker's Durable Object across repositories:
//   [[durable_objects.bindings]] name = "API_GATEWAY_LIMITER",
//   class_name = "ApiGatewayRateLimiter", script_name = "api-gateway"
// and calls it from app/server/utils/sharedEdgeStore.ts (consumeDurableRateLimit). That caller
// is not tested here, so this file pins the exact identity and wire protocol it depends on.
// Changing anything asserted below breaks Pages rate limiting (it fails open to its weaker
// Cache API path) and needs a coordinated TarkovTracker change.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as workerModule from '../index';
import { ApiGatewayRateLimiter } from '../index';
import type { Env } from '../types';
const wranglerConfig = readFileSync(
  fileURLToPath(new URL('../../wrangler.toml', import.meta.url)),
  'utf8'
);
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
type StoredAlarm = { value: number | null };
const makeState = (alarm: StoredAlarm) => {
  const store = new Map<string, unknown>();
  return {
    id: { toString: () => 'pages-contract' },
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      getAlarm: async () => alarm.value,
      setAlarm: async (at: number) => {
        alarm.value = at;
      },
      deleteAlarm: async () => {
        alarm.value = null;
      },
      deleteAll: async () => {
        store.clear();
      },
    },
  } as unknown as DurableObjectState;
};
// Byte-for-byte the request consumeDurableRateLimit sends.
const pagesRequest = (limit: number, windowSec: number) =>
  new Request('https://rate-limit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit, windowSec }),
  });
// Mirrors the Pages payload guard: anything else is treated as a limiter failure.
const isPagesPayload = (data: unknown): data is { allowed: boolean; resetAt: number } => {
  if (!data || typeof data !== 'object') return false;
  const { allowed, resetAt } = data as { allowed?: unknown; resetAt?: unknown };
  return typeof allowed === 'boolean' && typeof resetAt === 'number' && Number.isFinite(resetAt);
};
describe('Pages rate limiter binding identity', () => {
  it('keeps the Worker name Pages binds through script_name', () => {
    expect(wranglerConfig).toMatch(/^name = "api-gateway"$/m);
  });
  it('keeps the binding name and class Pages declares', () => {
    expect(wranglerConfig).toContain(
      '{ name = "API_GATEWAY_LIMITER", class_name = "ApiGatewayRateLimiter" }'
    );
    expect(workerModule).toHaveProperty('ApiGatewayRateLimiter', ApiGatewayRateLimiter);
  });
  it('keeps migration v1 so the existing namespace and state survive', () => {
    expect(wranglerConfig).toMatch(
      /\[\[migrations\]\]\s+tag = "v1"\s+new_sqlite_classes = \["ApiGatewayRateLimiter"\]/
    );
  });
});
describe('Pages rate limiter wire protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('answers the Pages request with a payload Pages accepts, then denies at the limit', async () => {
    const alarm: StoredAlarm = { value: null };
    const limiter = new ApiGatewayRateLimiter(makeState(alarm), {} as Env);
    const expectedReset = NOW + 60_000;
    const results = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await limiter.fetch(pagesRequest(2, 60));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      const payload: unknown = await response.json();
      expect(isPagesPayload(payload)).toBe(true);
      results.push(payload);
    }
    expect(results).toEqual([
      { allowed: true, remaining: 1, resetAt: expectedReset },
      { allowed: true, remaining: 0, resetAt: expectedReset },
      { allowed: false, remaining: 0, resetAt: expectedReset },
    ]);
  });
  it('treats Pages keys as ephemeral and schedules their cleanup', async () => {
    const alarm: StoredAlarm = { value: null };
    const limiter = new ApiGatewayRateLimiter(makeState(alarm), {} as Env);
    await limiter.fetch(pagesRequest(5, 60));
    expect(alarm.value).toBe(NOW + 60_000 + 1000);
  });
  it('rejects non-POST and malformed requests with a non-2xx status Pages fails open on', async () => {
    const limiter = new ApiGatewayRateLimiter(makeState({ value: null }), {} as Env);
    const get = await limiter.fetch(new Request('https://rate-limit'));
    expect(get.status).toBe(405);
    const malformed = await limiter.fetch(
      new Request('https://rate-limit', { method: 'POST', body: JSON.stringify({ limit: 5 }) })
    );
    expect(malformed.status).toBe(400);
  });
});
