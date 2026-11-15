import { describe, expect, it, vi } from 'vitest';
import { createReadbackRequest, parseOptions, proxyConfig, reportFailure, runMaintenance } from './limiter-maintenance.mjs';
const account = 'a'.repeat(32);
const namespace = 'b'.repeat(32);
const version = '12345678-1234-1234-1234-123456789abc';
const id = 'c'.repeat(64);
const args = ['--account', account, '--namespace', namespace, '--version', version];
function fixture() {
  const bodies = {
    account: { result: { id: account } },
    namespaces: { result: [{ id: namespace, script: 'api-gateway', class: 'ApiGatewayRateLimiter', use_sqlite: true }] },
    settings: { result: { bindings: [{ type: 'durable_object_namespace', name: 'API_GATEWAY_LIMITER', namespace_id: namespace, class_name: 'ApiGatewayRateLimiter' }] } },
    deployments: { result: { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] } },
    objects: { result: [{ id, hasStoredData: true }], result_info: { cursor: 'next-page' } },
  };
  const request = vi.fn(async (path: string) => {
    const base = `/accounts/${account}`;
    if (path === base) return bodies.account;
    if (path === `${base}/workers/scripts/api-gateway/settings`) return bodies.settings;
    if (path === `${base}/workers/scripts/api-gateway/deployments`) return bodies.deployments;
    if (path === `${base}/workers/durable_objects/namespaces?per_page=100&page=1`) return bodies.namespaces;
    const url = new URL(path, 'https://api.cloudflare.com');
    if (url.origin === 'https://api.cloudflare.com' &&
      url.pathname === `${base}/workers/durable_objects/namespaces/${namespace}/objects` &&
      /^\d+$/.test(url.searchParams.get('limit') ?? '') &&
      Number(url.searchParams.get('limit')) >= 10 && Number(url.searchParams.get('limit')) <= 100 &&
      url.searchParams.getAll('limit').length === 1 && url.searchParams.getAll('cursor').length <= 1 &&
      [...url.searchParams.keys()].every((key) => key === 'limit' || key === 'cursor')
    ) return bodies.objects;
    throw new Error('Unexpected fixture request');
  });
  const runBatch = vi.fn(async (): Promise<{ processed: number; counts: Record<string, number> }> => ({ processed: 1, counts: { 'fixed:eligible': 1 } }));
  const dispose = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ service: { runBatch }, dispose }));
  return { bodies, request, runBatch, dispose, connect };
}
describe('bounded maintenance runner', () => {
  it('defaults to a single 100-object dry-run with a remote named service binding', async () => {
    const f = fixture();
    const options = parseOptions(args);
    expect(options).toMatchObject({ apply: false, limit: 100 });
    const receipt = await runMaintenance(options, f);
    expect(receipt).toEqual({ mode: 'dry-run', listed: 1, candidates: 1, processed: 1, counts: { 'fixed:eligible': 1 }, nextCursor: 'next-page' });
    expect(f.runBatch).toHaveBeenCalledWith([id], { apply: false });
    expect(f.connect).toHaveBeenCalledWith(proxyConfig(account));
    expect(proxyConfig(account).services).toEqual([{ binding: 'MAINTENANCE', service: 'api-gateway', entrypoint: 'LimiterMaintenance', remote: true }]);
    expect(f.request.mock.calls.filter(([path]) => path.includes('/objects?'))).toHaveLength(1);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(receipt)).not.toContain(id);
  });
  it('applies only explicitly, rechecking identity after the inventory read', async () => {
    const f = fixture();
    await runMaintenance(parseOptions([...args, '--apply', '--limit', '10', '--cursor', 'old']), f);
    expect(f.runBatch).toHaveBeenCalledWith([id], { apply: true });
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/deployments'))).toHaveLength(2);
    expect(f.request.mock.calls.find(([path]) => path.includes('/objects?'))?.[0]).toContain('limit=10&cursor=old');
  });
  it('stops before connecting when identity changes after inventory', async () => {
    const f = fixture();
    const dispatch = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path) => {
      const result = await dispatch(path);
      if (path === `/accounts/${account}/workers/durable_objects/namespaces/${namespace}/objects?limit=100`) {
        f.bodies.settings.result.bindings[0].namespace_id = 'd'.repeat(32);
      }
      return result;
    });
    await expect(runMaintenance(parseOptions([...args, '--apply']), f)).rejects.toThrow('Deployed Worker binding identity mismatch');
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.runBatch).not.toHaveBeenCalled();
  });
  it('rejects unknown request paths and inventory parameters in the fixture', async () => {
    const f = fixture();
    for (const path of [
      `/accounts/${account}/unknown`,
      `/accounts/${account}/workers/scripts/wrong/settings`,
      `/accounts/${account}/workers/durable_objects/namespaces?per_page=100&page=2`,
      `/accounts/${account}/workers/durable_objects/namespaces/${namespace}/objects?limit=9`,
      `/accounts/${account}/workers/durable_objects/namespaces/${namespace}/objects?limit=100&unknown=true`,
    ]) await expect(f.request(path)).rejects.toThrow('Unexpected fixture request');
  });
  it.each([
    [], [...args, '--limit', '9'], [...args, '--limit', '101'], [...args, '--limit', '1.5'],
    [...args, '--limit', 'NaN'], [...args, '--account', account], [...args, '--apply', 'false'],
    [...args, '--other', 'x'], [...args, '--apply', '--apply'], [...args, '--cursor', '\n'],
    ['--account', 'bad', '--namespace', namespace, '--version', version],
  ].map((values) => [values]))('rejects invalid arguments before any connection %#', (values) => {
    expect(() => parseOptions(values)).toThrow();
  });
  it.each(['account', 'namespace', 'binding', 'version', 'split', 'inventory', 'oversize', 'duplicates'])('fails closed on %s mismatch', async (kind) => {
    const f = fixture();
    if (kind === 'account') f.bodies.account.result.id = 'd'.repeat(32);
    if (kind === 'namespace') f.bodies.namespaces.result[0].script = 'other';
    if (kind === 'binding') f.bodies.settings.result.bindings[0].namespace_id = 'd'.repeat(32);
    if (kind === 'version') f.bodies.deployments.result.deployments[0].versions[0].version_id = 'wrong';
    if (kind === 'split') f.bodies.deployments.result.deployments[0].versions[0].percentage = 50;
    if (kind === 'inventory') f.bodies.objects.result[0].id = 'wrong';
    if (kind === 'oversize') f.bodies.objects.result = Array.from({ length: 101 }, () => ({ id, hasStoredData: true }));
    if (kind === 'duplicates') f.bodies.objects.result.push({ id, hasStoredData: true });
    await expect(runMaintenance(parseOptions(args), f)).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('does not connect for an empty stored-data inventory', async () => {
    const f = fixture();
    f.bodies.objects.result[0].hasStoredData = false;
    expect((await runMaintenance(parseOptions(args), f)).candidates).toBe(0);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('disposes the binding after an RPC error or invalid receipt', async () => {
    const f = fixture();
    f.runBatch.mockRejectedValueOnce(new Error('remote error'));
    await expect(runMaintenance(parseOptions(args), f)).rejects.toThrow('remote error');
    expect(f.dispose).toHaveBeenCalledOnce();
    f.runBatch.mockResolvedValueOnce({ processed: 1, counts: { 'fixed:deleted': 1 } });
    await expect(runMaintenance(parseOptions(args), f)).rejects.toThrow('Invalid maintenance receipt');
    expect(f.dispose).toHaveBeenCalledTimes(2);
  });
  it.each([
    { processed: 0, counts: {} },
    { processed: 1, counts: { 'fixed:eligible': 1, error: 1 } },
  ])('rejects incomplete or contradictory receipts %#', async (summary) => {
    const f = fixture();
    f.runBatch.mockResolvedValueOnce({ processed: summary.processed, counts: summary.counts as Record<string, number> });
    await expect(runMaintenance(parseOptions(args), f)).rejects.toThrow('Invalid maintenance receipt');
    expect(f.dispose).toHaveBeenCalledOnce();
  });
  it('fails closed on HTTP, malformed JSON and unsuccessful API envelopes', async () => {
    for (const response of [new Response('{}', { status: 403 }), new Response('{'), new Response('null'), new Response('{"success":false}'), new Response('{}')]) {
      const requestFetch = vi.fn(async () => response.clone());
      const request = createReadbackRequest('test-token', requestFetch);
      const connect = vi.fn();
      await expect(request(`/accounts/${account}`)).rejects.toThrow();
      await expect(runMaintenance(parseOptions(args), { request, connect })).rejects.toThrow();
      expect(connect).not.toHaveBeenCalled();
      expect(requestFetch.mock.calls[0]).toMatchObject([
        `https://api.cloudflare.com/client/v4/accounts/${account}`,
        { redirect: 'error', headers: { Authorization: 'Bearer test-token' } },
      ]);
    }
  });
  it('copies only bounded summary fields from a service receipt', async () => {
    const f = fixture();
    f.runBatch.mockResolvedValueOnce({ processed: 1, counts: { 'fixed:eligible': 1 }, state: 'private-data' } as { processed: number; counts: Record<string, number> });
    const receipt = await runMaintenance(parseOptions(args), f);
    expect(receipt).not.toHaveProperty('state');
    expect(JSON.stringify(receipt)).not.toContain('private-data');
  });
  it('preserves a validated deletion receipt when proxy cleanup fails', async () => {
    const f = fixture();
    f.runBatch.mockResolvedValueOnce({ processed: 1, counts: { 'fixed:deleted': 1 } });
    f.dispose.mockRejectedValueOnce(new Error('private transport detail'));
    const receipt = await runMaintenance(parseOptions([...args, '--apply']), f);
    expect(receipt).toMatchObject({ mode: 'apply', processed: 1, counts: { 'fixed:deleted': 1 }, cleanupFailed: true });
    expect(JSON.stringify(receipt)).not.toContain('private transport detail');
  });
  it.each(['RPC error', 'invalid receipt'])('preserves the original %s when disposal also fails', async (kind) => {
    const f = fixture();
    const original = new Error('original RPC failure');
    if (kind === 'RPC error') f.runBatch.mockRejectedValueOnce(original);
    else f.runBatch.mockResolvedValueOnce({ processed: 0, counts: {} });
    f.dispose.mockRejectedValueOnce(new Error('private disposal details'));
    const error = await runMaintenance(parseOptions(args), f).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    if (kind === 'RPC error') expect(aggregate.errors[0]).toBe(original);
    else expect(aggregate.errors[0]).toMatchObject({ message: 'Invalid maintenance receipt' });
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[1]).toMatchObject({ message: 'Maintenance proxy cleanup failed' });
    expect(String(aggregate)).not.toContain('private disposal details');
  });
  it('prints only the sanitized CLI failure for an aggregate error', () => {
    const previousExitCode = process.exitCode;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportFailure(new AggregateError([new Error('private request data')], 'private aggregate data'));
      expect(error).toHaveBeenCalledExactlyOnceWith('Maintenance stopped. Check arguments, account/binding/version readbacks and authorized service-binding access; no further objects were attempted.');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });
});
