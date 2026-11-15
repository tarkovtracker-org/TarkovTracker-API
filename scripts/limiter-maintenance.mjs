import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const SCRIPT = 'api-gateway';
const CLASS = 'ApiGatewayRateLimiter';
const ENTRYPOINT = 'LimiterMaintenance';
const HEX32 = /^[a-f0-9]{32}$/;
const VERSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function removeTemporaryConfig(directory) {
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('limiter-maintenance-')) {
    throw new Error('Unexpected temporary directory');
  }
  await rm(target, { recursive: true });
}
export function parseOptions(args) {
  const options = { apply: false, limit: 100 };
  const names = new Set(['account', 'namespace', 'version', 'limit', 'cursor']);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('Duplicate argument');
    seen.add(flag);
    if (flag === '--apply') { options.apply = true; continue; }
    const name = flag.slice(2);
    if (!flag.startsWith('--') || !names.has(name) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('Expected --account ID --namespace ID --version UUID [--limit 10..100] [--cursor CURSOR] [--apply]');
    }
    options[name] = args[++index];
  }
  if (!HEX32.test(options.account ?? '') || !HEX32.test(options.namespace ?? '') || !VERSION.test(options.version ?? '')) {
    throw new Error('Explicit expected account, namespace and deployed version are required');
  }
  if (!/^\d+$/.test(String(options.limit)) || Number(options.limit) < 10 || Number(options.limit) > 100) {
    throw new Error('Limit must be an integer from 10 to 100');
  }
  options.limit = Number(options.limit);
  if (options.cursor && (options.cursor.length > 4096 || /[\r\n\x00]/.test(options.cursor))) throw new Error('Invalid cursor');
  return options;
}
export function proxyConfig(account) {
  return {
    name: 'limiter-maintenance-operator', account_id: account, compatibility_date: '2026-08-25',
    workers_dev: false, preview_urls: false,
    services: [{ binding: 'MAINTENANCE', service: SCRIPT, entrypoint: ENTRYPOINT, remote: true }],
  };
}
export async function verifyIdentity(options, request) {
  const base = `/accounts/${options.account}`;
  const account = await request(base);
  if (account.result?.id !== options.account) throw new Error('Account identity mismatch');
  const namespaces = await request(`${base}/workers/durable_objects/namespaces?per_page=100&page=1`);
  if (!Array.isArray(namespaces.result) || !namespaces.result.some((item) =>
    item.id === options.namespace && item.script === SCRIPT && item.class === CLASS && item.use_sqlite === true
  )) throw new Error('Namespace identity mismatch (only the first 100 namespaces are inspected)');
  const settings = await request(`${base}/workers/scripts/${SCRIPT}/settings`);
  const bindings = settings.result?.bindings;
  if (!Array.isArray(bindings) || !bindings.some((binding) =>
    binding.type === 'durable_object_namespace' && binding.name === 'API_GATEWAY_LIMITER' &&
    binding.namespace_id === options.namespace && binding.class_name === CLASS &&
    (!binding.script_name || binding.script_name === SCRIPT)
  )) throw new Error('Deployed Worker binding identity mismatch');
  const deployments = await request(`${base}/workers/scripts/${SCRIPT}/deployments`);
  const versions = deployments.result?.deployments?.[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0].version_id !== options.version || versions[0].percentage !== 100) {
    throw new Error('Expected version must be the sole active deployment at 100%');
  }
}
export async function runMaintenance(options, { request, connect }) {
  await verifyIdentity(options, request);
  const query = new URLSearchParams({ limit: String(options.limit) });
  if (options.cursor) query.set('cursor', options.cursor);
  const page = await request(`/accounts/${options.account}/workers/durable_objects/namespaces/${options.namespace}/objects?${query}`);
  if (!Array.isArray(page.result) || page.result.length > options.limit || page.result.some((object) =>
    !object || !/^[a-f0-9]{64}$/.test(object.id) || typeof object.hasStoredData !== 'boolean'
  ) || new Set(page.result.map((object) => object.id)).size !== page.result.length) throw new Error('Invalid object inventory');
  const cursor = page.result_info?.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 4096 || /[\r\n\x00]/.test(cursor))) throw new Error('Invalid inventory cursor');
  const ids = page.result.filter((object) => object.hasStoredData).map((object) => object.id);
  // Inventory is only a candidate list. Every object rechecks its live state in RPC.
  // Re-read deployment/binding identity immediately before an applying batch too.
  if (options.apply) await verifyIdentity(options, request);
  const receipt = { mode: options.apply ? 'apply' : 'dry-run', listed: page.result.length, candidates: ids.length, processed: 0, counts: {}, nextCursor: cursor };
  if (!ids.length) return receipt;
  const connection = await connect(proxyConfig(options.account));
  let validatedReceipt;
  try {
    const summary = await connection.service.runBatch(ids, { apply: options.apply });
    const allowed = /^(?:(?:fixed|sliding|unknown):(?:empty|unknown|extra-storage|active|eligible|deleted)|error)$/;
    if (!summary || !Number.isSafeInteger(summary.processed) || summary.processed < 0 || summary.processed > ids.length ||
      !summary.counts || typeof summary.counts !== 'object' || Array.isArray(summary.counts) ||
      Object.entries(summary.counts).some(([key, count]) => !allowed.test(key) || !Number.isSafeInteger(count) || count < 0) ||
      Object.values(summary.counts).reduce((sum, count) => sum + count, 0) !== summary.processed + (summary.counts.error ?? 0) ||
      (summary.counts.error ?? 0) > 1 ||
      (summary.counts.error ? summary.processed >= ids.length : summary.processed !== ids.length) ||
      (!options.apply && Object.keys(summary.counts).some((key) => key.endsWith(':deleted')))
    ) throw new Error('Invalid maintenance receipt');
    validatedReceipt = { ...receipt, processed: summary.processed, counts: summary.counts };
  } finally {
    try {
      await connection.dispose();
    } catch {
      if (!validatedReceipt) throw new Error('Maintenance proxy cleanup failed');
      validatedReceipt.cleanupFailed = true;
    }
  }
  return validatedReceipt;
}
export function createReadbackRequest(token, requestFetch = fetch) {
  return async (path) => {
    const response = await requestFetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cloudflare readback failed (${response.status})`);
    const body = await response.json();
    if (!body || body.success !== true) throw new Error('Cloudflare readback was unsuccessful');
    return body;
  };
}
async function main() {
  const options = parseOptions(process.argv.slice(2));
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required in the environment');
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== options.account) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must match the expected account');
  }
  const request = createReadbackRequest(token);
  const connect = async (config) => {
    const directory = await mkdtemp(join(tmpdir(), 'limiter-maintenance-'));
    try {
      const configPath = join(directory, 'wrangler.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      const { getPlatformProxy } = await import('wrangler');
      const proxy = await getPlatformProxy({ configPath, remoteBindings: true, persist: false, envFiles: [] });
      return { service: proxy.env.MAINTENANCE, dispose: async () => {
        try { await proxy.dispose(); } finally { await removeTemporaryConfig(directory); }
      } };
    } catch (error) {
      await removeTemporaryConfig(directory);
      throw error;
    }
  };
  const receipt = await runMaintenance(options, { request, connect });
  console.log(JSON.stringify(receipt));
  if (receipt.cleanupFailed) console.error('Maintenance proxy cleanup failed; the validated receipt is retained.');
  if (receipt.counts.error || receipt.cleanupFailed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Third-party exceptions can include IDs, request data or tokens. Do not print them.
    console.error('Maintenance stopped. Check arguments, account/binding/version readbacks and authorized service-binding access; no further objects were attempted.');
    process.exitCode = 1;
  });
}
