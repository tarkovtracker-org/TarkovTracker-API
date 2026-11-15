// Capture policy at SDK initialization, so configuring it after import cannot pass.
const diagnosticsEnabled = process.env.WRANGLER_LOG !== 'none';
if (diagnosticsEnabled) console.log('SDK initialization diagnostic');
if (process.env.WRANGLER_WRITE_LOGS !== 'false') console.error('SDK disk-log diagnostic');
export async function getPlatformProxy(options) {
  if (diagnosticsEnabled) console.log('Establishing remote connection...');
  if (options.remoteBindings !== true || options.persist !== false || options.envFiles.length !== 0) {
    throw new Error('Unexpected fixture proxy options');
  }
  return {
    env: { MAINTENANCE: { runBatch: async (ids, options) => {
      if (ids.length !== 1 || ids[0] !== 'c'.repeat(64) || options.apply !== false) {
        throw new Error('Unexpected fixture batch');
      }
      return { processed: 1, counts: { 'fixed:eligible': 1 } };
    } } },
    dispose: async () => {
      if (diagnosticsEnabled) console.log('SDK disposal diagnostic');
    },
  };
}
