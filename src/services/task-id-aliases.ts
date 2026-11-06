import {
  emptyTaskIdAliases,
  parseTaskIdAliases,
  taskAliasMode,
} from '@tarkovtracker/progress-contracts/taskIdAliases';
import type {
  TaskIdAliases,
  TaskIdAliasMapping,
} from '@tarkovtracker/progress-contracts/taskIdAliases';
import type { Env, GameMode } from '../types';
const MAX_MANIFEST_BYTES = 256 * 1024;
const CACHE_MS = 60_000;
let cached: { origin: string; expiresAt: number; value: TaskIdAliases } | undefined;
async function readManifest(response: Response): Promise<TaskIdAliases> {
  if (!response.ok || !response.body) throw new Error('Task identity manifest unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MANIFEST_BYTES) throw new Error('Task identity manifest exceeds size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseTaskIdAliases(JSON.parse(new TextDecoder().decode(bytes)));
}
/** Data-only cache, scoped to the database. Never accept client-provided identity maps. */
export async function getTaskIdAliases(env: Env, mode: GameMode): Promise<TaskIdAliasMapping> {
  if (env.TASK_ID_ALIASES_ENABLED !== 'true')
    return emptyTaskIdAliases().modes[taskAliasMode(mode)];
  if (cached?.origin === env.SUPABASE_URL && cached.expiresAt > Date.now()) {
    return cached.value.modes[taskAliasMode(mode)];
  }
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_progress_task_id_aliases`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(5_000),
  });
  const value = await readManifest(response);
  cached = {
    origin: env.SUPABASE_URL,
    expiresAt: Date.now() + CACHE_MS,
    value,
  };
  return value.modes[taskAliasMode(mode)];
}
