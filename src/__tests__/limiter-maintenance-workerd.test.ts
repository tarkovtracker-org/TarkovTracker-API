import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';
import type { ApiGatewayRateLimiter } from './fixtures/limiter-maintenance/worker';
import type Client from './fixtures/limiter-maintenance/client';
type Namespace = DurableObjectNamespace<ApiGatewayRateLimiter>;
describe('limiter maintenance in real workerd', () => {
  let harness: TestHarness;
  let namespace: Namespace;
  let client: Service<Client>;
  beforeAll(async () => {
    harness = createTestHarness({
      root: fileURLToPath(new URL('./fixtures/limiter-maintenance/', import.meta.url)),
      workers: [{ configPath: './wrangler.toml' }, { configPath: './client.toml' }],
    });
    await harness.listen();
    namespace = (await harness.getWorker().getEnv()).API_GATEWAY_LIMITER as Namespace;
    client = await harness.getWorker<Record<string, unknown>, { default: typeof Client }>('limiter-maintenance-client-test').getExport();
  }, 30_000);
  afterAll(async () => { await harness?.close(); }, 30_000);
  const object = (_name: string) => {
    // Production inventory contains opaque IDs. Named IDs create a Miniflare-only
    // SQL name table; unique IDs exercise the actual production catalog guard.
    const id = namespace.newUniqueId();
    return { id: id.toString(), stub: namespace.get(id) };
  };
  const snapshot = async (stub: DurableObjectStub<ApiGatewayRateLimiter>) => JSON.parse(await stub.snapshot()) as {
    state?: Record<string, unknown>; keys: string[]; alarm: number | null; tables: { name: string }[];
  };
  const consume = (stub: DurableObjectStub<ApiGatewayRateLimiter>) => stub.fetch('https://rate-limit', {
    method: 'POST', body: JSON.stringify({ limit: 100, windowSec: 60, retain: true }),
  });
  it('reclaims expired state through a named service binding; dry-run does not write', async () => {
    const { id, stub } = object('expired');
    await stub.seed({ count: 3, windowSec: 60, resetAt: Date.now() - 1 });
    const before = await snapshot(stub);
    expect(await client.runBatch([id])).toEqual({ processed: 1, counts: { 'fixed:eligible': 1 } });
    expect(await snapshot(stub)).toEqual(before);
    expect(await client.runBatch([id], { apply: true })).toEqual({ processed: 1, counts: { 'fixed:deleted': 1 } });
    expect(await snapshot(stub)).toMatchObject({ keys: [], alarm: null });
    expect((await snapshot(stub)).state).toBeUndefined();
  });
  it('preserves active daily/Pages and partially expired sliding quotas', async () => {
    const now = Date.now();
    const states = [
      { count: 10, windowSec: 86400, resetAt: now + 86_400_000, anchor: 'utc-day' },
      { count: 2, windowSec: 60, resetAt: now + 60_000, ephemeral: true },
      { count: 2, windowSec: 60, resetAt: now - 60_000, mode: 'sliding', timestamps: [now - 120_000, now] },
    ];
    for (const [index, state] of states.entries()) {
      const { id, stub } = object(`active-${index}`);
      await stub.seed(state);
      const before = await snapshot(stub);
      const result = await client.runBatch([id], { apply: true });
      expect(Object.keys(result.counts)[0]).toMatch(/:active$/);
      expect(await snapshot(stub)).toEqual(before);
    }
  });
  it('skips unknown data and extra KV/SQL storage', async () => {
    for (const extra of ['kv', 'sql', null] as const) {
      const { id, stub } = object(`extra-${extra}`);
      await stub.seed(extra ? { count: 2, windowSec: 60, resetAt: Date.now() - 1 } : { alien: true }, extra);
      const before = await snapshot(stub);
      const result = await client.runBatch([id], { apply: true });
      expect(Object.keys(result.counts)[0]).toMatch(extra ? /:extra-storage$/ : /:unknown$/);
      expect(await snapshot(stub)).toEqual(before);
    }
  });
  it('serializes concurrent maintenance and consumption without losing quota', async () => {
    const { id, stub } = object('concurrent');
    await stub.seed({ count: 5, windowSec: 60, resetAt: Date.now() - 1 });
    expect((await client.runBatch([id])).counts).toEqual({ 'fixed:eligible': 1 });
    const operations = Array.from({ length: 20 }, (_, index) => index % 2 === 0
      ? consume(stub).then((response) => response.text())
      : client.runBatch([id], { apply: true }));
    await Promise.all(operations);
    expect((await snapshot(stub)).state).toMatchObject({ count: 10 });
    expect((await client.runBatch([id], { apply: true })).counts).toEqual({ 'fixed:active': 1 });
  });
  it('reports SQL-only storage as extra-storage and preserves its table', async () => {
    const { id, stub } = object('sql-only');
    await stub.seed(undefined, 'sql');
    const before = await snapshot(stub);
    expect(before.keys).toEqual([]);
    expect(before.tables).toContainEqual({ name: 'unrecognized' });
    for (const options of [{}, { apply: true }]) {
      expect(await client.runBatch([id], options)).toEqual({ processed: 1, counts: { 'unknown:extra-storage': 1 } });
      expect(await snapshot(stub)).toEqual(before);
    }
  });
  it('clears a loaded cache and reloads storage after cleanup', async () => {
    const { id, stub } = object('cached');
    await stub.seed({ count: 5, windowSec: 60, resetAt: Date.now() + 60_000 });
    await (await consume(stub)).text();
    await stub.seed({ count: 5, windowSec: 60, resetAt: Date.now() - 1 });
    expect((await client.runBatch([id], { apply: true })).counts).toEqual({ 'fixed:deleted': 1 });
    await stub.seed({ count: 8, windowSec: 60, resetAt: Date.now() + 60_000 });
    expect(await (await consume(stub)).json()).toMatchObject({ remaining: 91 });
  });
  it('validates batches before touching objects and keeps maintenance off public HTTP', async () => {
    const { id } = object('invalid-batch');
    for (const ids of [[], [id, id], Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, '0')), ['invalid']]) {
      await expect(Promise.resolve().then(() => client.runBatch(ids, { apply: true }))).rejects.toThrow('Invalid maintenance batch');
    }
    for (const path of ['/maintainExpiredState', '/LimiterMaintenance', '/api/v2/maintainExpiredState']) {
      const response = await harness.getWorker().fetch(`https://api.tarkovtracker.org${path}`, {
        method: 'POST', headers: { 'User-Agent': 'MaintenanceTest/1.0', Authorization: 'Bearer PVP_test' }, body: JSON.stringify({ apply: true }),
      });
      expect(response.status).toBe(404);
      await response.text();
    }
  });
});
