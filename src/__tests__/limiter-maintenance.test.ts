import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import { ApiGatewayRateLimiter } from '../rateLimiter';
import { inspectLimiterState } from '../limiterMaintenance';
import { LimiterMaintenance } from '../limiterMaintenanceService';
import type { Env } from '../types';
const NOW = 100_000;
const fixed = (resetAt = NOW) => ({ count: 2, resetAt, windowSec: 60 });
const sliding = (timestamps = [1000, 2000]) => ({
  count: timestamps.length, resetAt: timestamps[0] + 60_000, windowSec: 60,
  mode: 'sliding', timestamps,
});
function fixture(value: unknown = fixed()) {
  const store = new Map<string, unknown>([['state', structuredClone(value)]]);
  let alarm: number | null = NOW + 10_000;
  const storage = {
    list: vi.fn(async () => structuredClone(store)),
    get: vi.fn(async (key: string) => structuredClone(store.get(key))),
    put: vi.fn(async (key: string, value: unknown) => { store.set(key, structuredClone(value)); }),
    deleteAll: vi.fn(async () => { store.clear(); }),
    deleteAlarm: vi.fn(async () => { alarm = null; }),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (at: number) => { alarm = at; }),
    sql: { exec: vi.fn(() => ({ toArray: () => [] as { name: string }[] })) },
  };
  const limiter = new ApiGatewayRateLimiter({ storage } as unknown as DurableObjectState, {} as Env);
  return { limiter, storage, store, alarm: () => alarm };
}
const consume = (limiter: ApiGatewayRateLimiter, retain = true) => limiter.fetch(new Request(
  'https://rate-limit', { method: 'POST', body: JSON.stringify({ limit: 10, windowSec: 60, retain }) }
));
afterEach(() => vi.restoreAllMocks());
describe('expiry eligibility', () => {
  it('accepts equality for fixed and fully expired sliding state', () => {
    expect(inspectLimiterState(fixed(), NOW)).toEqual({ category: 'fixed', status: 'expired' });
    expect(inspectLimiterState(sliding([39_000, 40_000]), NOW)).toEqual({ category: 'sliding', status: 'expired' });
  });
  it('preserves younger sliding timestamps after the oldest reset elapsed', () => {
    expect(inspectLimiterState(sliding([1000, 50_000]), NOW)).toEqual({ category: 'sliding', status: 'active' });
  });
  it.each([
    null, [], {}, { ...fixed(), unknown: true }, { ...fixed(), timestamps: [] },
    { ...fixed(), mode: 'fixed' }, { ...fixed(), count: -1 }, { ...fixed(), count: 0.5 },
    { ...fixed(), resetAt: NaN }, { ...fixed(), resetAt: Infinity },
    { ...fixed(), windowSec: 0 }, { ...fixed(), windowSec: Number.MAX_VALUE },
    { ...fixed(), anchor: 'other' }, { ...fixed(), ephemeral: 'true' },
    { ...sliding(), anchor: 'utc-day' }, { ...sliding(), mode: undefined },
    { ...sliding(), count: 3 }, { ...sliding(), timestamps: [2000, 1000] },
    { ...sliding(), timestamps: [1000, NaN] }, { ...sliding(), resetAt: 0 },
  ])('keeps unknown/malformed state %#', (value) => {
    expect(inspectLimiterState(value, NOW).status).toBe('unknown');
  });
});
describe('binding-only maintenance RPC', () => {
  it('dry-runs with zero writes, alarms, cache changes or quota consumption', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const f = fixture();
    expect(await f.limiter.maintainExpiredState()).toEqual({ category: 'fixed', status: 'eligible' });
    expect(f.store.get('state')).toEqual(fixed());
    expect(f.alarm()).toBe(NOW + 10_000);
    expect(f.storage.get).not.toHaveBeenCalled();
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.storage.deleteAlarm).not.toHaveBeenCalled();
    expect(f.storage.deleteAll).not.toHaveBeenCalled();
    expect(f.storage.setAlarm).not.toHaveBeenCalled();
  });
  it.each([{ ...fixed(NOW + 1), anchor: 'utc-day' }, { ...fixed(NOW + 1), ephemeral: true }, sliding([1000, 50_000])])(
    'preserves active daily, Pages and sliding state %#', async (value) => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const f = fixture(value);
      expect((await f.limiter.maintainExpiredState({ apply: true })).status).toBe('active');
      expect(f.store.get('state')).toEqual(value);
      expect(f.storage.deleteAll).not.toHaveBeenCalled();
      expect(f.storage.deleteAlarm).not.toHaveBeenCalled();
    }
  );
  it('rechecks after dry-run and never deletes new consumption', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const f = fixture();
    expect((await f.limiter.maintainExpiredState()).status).toBe('eligible');
    await consume(f.limiter);
    expect((await f.limiter.maintainExpiredState({ apply: true })).status).toBe('active');
    expect(f.store.get('state')).toMatchObject({ count: 1, resetAt: NOW + 60_000 });
  });
  it('holds concurrent consumption until the maintenance decision has finished', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const f = fixture();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    f.storage.list.mockImplementationOnce(async () => {
      const snapshot = structuredClone(f.store);
      arrived();
      await gate;
      return snapshot;
    });
    const maintenance = f.limiter.maintainExpiredState({ apply: true });
    await started;
    const consumption = consume(f.limiter);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.storage.put).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([maintenance, consumption]);
    }
    expect(f.store.get('state')).toMatchObject({ count: 1, resetAt: NOW + 60_000 });
  });
  it('invalidates an already loaded cache and cancels the alarm before deleting', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const f = fixture(fixed(NOW + 60_000));
    await consume(f.limiter);
    now.mockReturnValue(NOW + 60_000);
    expect((await f.limiter.maintainExpiredState({ apply: true })).status).toBe('deleted');
    expect(f.store.size).toBe(0);
    expect(f.alarm()).toBeNull();
    expect(f.storage.deleteAlarm.mock.invocationCallOrder[0]).toBeLessThan(f.storage.deleteAll.mock.invocationCallOrder[0]);
    // A storage update after cleanup must be reloaded, even in the same instance.
    f.store.set('state', fixed(NOW + 120_000));
    const result = await (await consume(f.limiter)).json() as { remaining: number };
    expect(result.remaining).toBe(7);
  });
  it('holds alarm cleanup behind an in-flight maintenance decision', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const f = fixture();
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    f.storage.list.mockImplementationOnce(async () => {
      arrived();
      await gate;
      return structuredClone(f.store);
    });
    const maintenance = f.limiter.maintainExpiredState();
    await started;
    const alarm = f.limiter.alarm();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.storage.get).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([maintenance, alarm]);
    }
    expect(f.store.size).toBe(0);
  });
  it('skips empty, unknown and extra KV/SQL state', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    for (const kind of ['empty', 'unknown', 'kv', 'sql'] as const) {
      const f = fixture(kind === 'unknown' ? { alien: true } : fixed());
      if (kind === 'empty') f.store.clear();
      if (kind === 'kv') f.store.set('other', 'keep');
      if (kind === 'sql') f.storage.sql.exec.mockReturnValue({ toArray: () => [{ name: 'other' }] });
      const result = await f.limiter.maintainExpiredState({ apply: true });
      expect(result.status).toBe(kind === 'kv' || kind === 'sql' ? 'extra-storage' : kind);
      expect(f.storage.deleteAll).not.toHaveBeenCalled();
      expect(f.storage.deleteAlarm).not.toHaveBeenCalled();
    }
  });
  it('fails closed if catalog inspection fails and permits later requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const f = fixture();
    f.storage.sql.exec.mockImplementationOnce(() => { throw new Error('catalog unavailable'); });
    await expect(f.limiter.maintainExpiredState({ apply: true })).rejects.toThrow('catalog unavailable');
    expect(f.storage.deleteAll).not.toHaveBeenCalled();
    expect((await consume(f.limiter)).status).toBe(200);
  });
  it.each([null, [], true, { apply: 'true' }, { apply: true, other: true }])('rejects malformed options %#', async (value) => {
    const f = fixture();
    await expect(f.limiter.maintainExpiredState(value as never)).rejects.toThrow('Invalid maintenance options');
    expect(f.storage.list).not.toHaveBeenCalled();
  });
  it('does not expose maintenance through public HTTP or the normal DO fetch protocol', async () => {
    const f = fixture();
    expect((await f.limiter.fetch(new Request('https://rate-limit/maintainExpiredState', {
      method: 'POST', headers: { 'User-Agent': 'MaintenanceTest/1.0', Authorization: 'Bearer PVP_test' }, body: JSON.stringify({ apply: true }),
    }))).status).toBe(400);
    const env = { API_GATEWAY_LIMITER: { get: vi.fn() }, ALLOWED_ORIGIN: '*' } as unknown as Env;
    const response = await worker.fetch(new Request('https://api.tarkovtracker.org/maintainExpiredState', {
      method: 'POST', headers: { 'User-Agent': 'MaintenanceTest/1.0', Authorization: 'Bearer PVP_test' }, body: JSON.stringify({ apply: true }),
    }), env);
    expect(response.status).toBe(404);
    expect(env.API_GATEWAY_LIMITER.get).not.toHaveBeenCalled();
    expect(f.storage.deleteAll).not.toHaveBeenCalled();
  });
});
describe('service bridge guards', () => {
  const id = 'c'.repeat(64);
  function bridge() {
    const maintenance = vi.fn(async () => ({ category: 'fixed', status: 'eligible' }));
    const get = vi.fn(() => ({ maintainExpiredState: maintenance }));
    const idFromString = vi.fn((value: string) => value);
    const env = { API_GATEWAY_LIMITER: { get, idFromString } } as unknown as Env;
    return { service: new LimiterMaintenance({} as ExecutionContext, env), get, idFromString, maintenance };
  }
  it.each([null, [], true, { apply: 'true' }, { apply: true, extra: true }])('rejects corrupted options %#', async (options) => {
    const f = bridge();
    await expect(f.service.runBatch([id], options as never)).rejects.toThrow('Invalid maintenance options');
    expect(f.get).not.toHaveBeenCalled();
  });
  it.each([[], [id, id], ['bad'], Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, '0'))].map((ids) => [ids]))('rejects invalid batches %#', async (ids) => {
    const f = bridge();
    await expect(f.service.runBatch(ids)).rejects.toThrow('Invalid maintenance batch');
    expect(f.get).not.toHaveBeenCalled();
  });
  it('validates namespace IDs before making calls and stops on the first object error', async () => {
    const f = bridge();
    f.idFromString.mockImplementationOnce(() => { throw new Error('Wrong namespace'); });
    await expect(f.service.runBatch([id])).rejects.toThrow('Wrong namespace');
    expect(f.get).not.toHaveBeenCalled();
    f.maintenance.mockRejectedValueOnce(new Error('Sensitive object data'));
    expect(await f.service.runBatch([id, 'd'.repeat(64)])).toEqual({ processed: 0, counts: { error: 1 } });
    expect(f.maintenance).toHaveBeenCalledOnce();
  });
});
