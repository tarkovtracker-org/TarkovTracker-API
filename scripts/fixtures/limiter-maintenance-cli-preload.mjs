import { registerHooks } from 'node:module';
const account = 'a'.repeat(32);
const namespace = 'b'.repeat(32);
const version = '12345678-1234-1234-1234-123456789abc';
const base = `/client/v4/accounts/${account}`;
// Run the real CLI while replacing all network/SDK access in this subprocess.
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.cloudflare.com') throw new Error('Unexpected fixture origin');
  let result;
  if (url.pathname === base && !url.search) result = { id: account };
  else if (url.pathname === `${base}/workers/durable_objects/namespaces` && url.search === '?per_page=100&page=1') {
    result = [{ id: namespace, script: 'api-gateway', class: 'ApiGatewayRateLimiter', use_sqlite: true }];
  } else if (url.pathname === `${base}/workers/scripts/api-gateway/settings` && !url.search) {
    result = { bindings: [{ type: 'durable_object_namespace', name: 'API_GATEWAY_LIMITER', namespace_id: namespace, class_name: 'ApiGatewayRateLimiter' }] };
  } else if (url.pathname === `${base}/workers/scripts/api-gateway/deployments` && !url.search) {
    result = { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] };
  } else if (url.pathname === `${base}/workers/durable_objects/namespaces/${namespace}/objects` && url.search === '?limit=100') {
    result = [{ id: 'c'.repeat(64), hasStoredData: true }];
  } else throw new Error('Unexpected fixture readback');
  return Response.json({ success: true, result });
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'wrangler') {
      return { url: new URL('./limiter-maintenance-sdk.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
