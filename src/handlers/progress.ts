import {
  reconcileTaskIdentities,
  resolveTaskId,
  resolveObjectiveId,
} from '@tarkovtracker/progress-contracts/taskIdAliases';
import type { TaskIdAliasMapping } from '@tarkovtracker/progress-contracts/taskIdAliases';
import { getTaskIdAliases } from '../services/task-id-aliases';
import { capApiTaskUpdates } from '@tarkovtracker/progress-contracts/apiTaskUpdates';
import { setTaskState } from '@tarkovtracker/progress-contracts/taskTransitions';
import { getUserDisplayName } from '../utils/user-display-name';
import { hasMaterializedProgress } from '@tarkovtracker/progress-contracts/modeProgress';
import { getTasks, getHideoutStations } from '../services/tarkov';
import { prepareReadRepresentation } from '../responses';
import type { ReadRepresentation } from '../responses';
import { getGameModeSeasonNumber } from '../utils/gameMode';
import { logger } from '../utils/logger';
import { ProgressInputError } from '../utils/progress-input';
import { transformProgress } from '../utils/transform';
import type {
  Env,
  ApiToken,
  UserProgressModeRow,
  TaskState,
  BatchTaskUpdate,
  TaskCompletion,
  ApiUpdateMeta,
  GameMode,
  ProgressDataField,
  TarkovTask,
  TarkovHideoutStation,
} from '../types';
interface ProgressMergePayload {
  taskCompletions?: Record<string, TaskCompletion>;
  taskObjectives?: Record<string, Record<string, unknown>>;
  set?: Record<string, unknown>;
}
async function validateTaskIds(
  gameMode: GameMode,
  taskIds: readonly string[],
  aliases: TaskIdAliasMapping
): Promise<void> {
  const tasks = await getTasks(gameMode);
  const knownIds = new Set([...tasks.map((task) => task.id), ...Object.values(aliases.tasks)]);
  if (!taskIds.every((id) => knownIds.has(id))) {
    throw new ProgressInputError('Unknown task ID for token game mode');
  }
}
async function validateObjectiveId(
  gameMode: GameMode,
  objectiveId: string,
  aliases: TaskIdAliasMapping
): Promise<void> {
  const tasks = await getTasks(gameMode);
  const known = tasks.some((task) =>
    task.objectives?.some((objective) => objective.id === objectiveId)
  );
  if (!known && !Object.values(aliases.objectives).some((target) => target.id === objectiveId))
    throw new ProgressInputError('Unknown objective ID for token game mode');
}
/**
 * Persist a partial progress update atomically via the merge_progress_data
 * RPC. Only the supplied keys are merged server-side, so concurrent writers
 * cannot overwrite each other's unrelated changes, and a write against a
 * missing progress row fails loudly instead of silently updating nothing.
 */
async function mergeProgressData(
  env: Env,
  token: ApiToken,
  dataField: ProgressDataField,
  payload: ProgressMergePayload,
  logContext: { action: string; taskIds?: string[] }
): Promise<void> {
  const startedAt = Date.now();
  const body = JSON.stringify({
    p_user_id: token.user_id,
    p_field: dataField,
    p_task_completions: payload.taskCompletions ?? null,
    p_task_objectives: payload.taskObjectives ?? null,
    p_set: payload.set ?? null,
  });
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/merge_progress_data`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body,
  });
  const logEntry = {
    action: logContext.action,
    userId: token.user_id,
    tokenId: token.token_id,
    taskIds: logContext.taskIds,
    payloadBytes: body.length,
    status: res.status,
    durationMs: Date.now() - startedAt,
  };
  if (!res.ok) {
    logger.error('progress write failed', logEntry);
    throw new Error(`Failed to save progress update (HTTP ${res.status})`);
  }
  const updatedRows = Number(await res.text());
  if (!Number.isFinite(updatedRows) || updatedRows < 1) {
    logger.error('progress write matched no row', logEntry);
    throw new Error('Progress row not found for user');
  }
  logger.info('progress write', logEntry);
}
const getProgressDataField = (gameMode: GameMode): ProgressDataField => {
  if (gameMode === 'pve') return 'pve_data';
  if (gameMode === 'seasonal') return 'seasonal_data';
  return 'pvp_data';
};
const getServiceHeaders = (env: Env) => ({
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
});
/** Row shape selected from the materialized per-mode progress table. */
interface ProgressModeRowFragment {
  progress_data: UserProgressModeRow['progress_data'];
  user_id: string;
}
/** Account metadata selected from `user_progress`. */
interface ProgressMetadataRow {
  game_edition: number | null;
  user_id: string;
}
async function fetchProgressRowPair(
  env: Env,
  userId: string,
  gameMode: GameMode,
  seasonNumber: number
): Promise<{
  gameEdition: number;
  modeText: string;
}> {
  const modeUrl = `${env.SUPABASE_URL}/rest/v1/user_game_mode_progress?user_id=eq.${userId}&game_mode=eq.${gameMode}&season_number=eq.${seasonNumber}&select=user_id,progress_data&limit=1`;
  const metadataUrl = `${env.SUPABASE_URL}/rest/v1/user_progress?user_id=eq.${userId}&select=user_id,game_edition&limit=1`;
  const [modeResponse, metadataResponse] = await Promise.all([
    fetch(modeUrl, { headers: getServiceHeaders(env) }),
    fetch(metadataUrl, { headers: getServiceHeaders(env) }),
  ]);
  if (!modeResponse.ok || !metadataResponse.ok) {
    throw new Error('Failed to fetch user progress');
  }
  const [modeText, metadataRows] = await Promise.all([
    modeResponse.text(),
    metadataResponse.json<ProgressMetadataRow[]>(),
  ]);
  return { modeText, gameEdition: metadataRows[0]?.game_edition ?? 1 };
}
const asProgressRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
async function fetchCurrentProgressData(
  env: Env,
  userId: string,
  gameMode: GameMode
): Promise<Record<string, unknown>> {
  const seasonNumber = await getGameModeSeasonNumber(env, gameMode);
  const modeUrl = `${env.SUPABASE_URL}/rest/v1/user_game_mode_progress?user_id=eq.${userId}&game_mode=eq.${gameMode}&season_number=eq.${seasonNumber}&select=progress_data&limit=1`;
  const modeResponse = await fetch(modeUrl, {
    headers: getServiceHeaders(env),
  });
  if (!modeResponse.ok) throw new Error('Failed to fetch user progress');
  const modeRows = (await modeResponse.json()) as Array<{
    progress_data: Record<string, unknown> | null;
  }>;
  const modeProgress = modeRows[0]?.progress_data ?? null;
  return hasMaterializedProgress(modeProgress) ? asProgressRecord(modeProgress) : {};
}
const buildApiUpdateMeta = (updates: Map<string, TaskState>, timestamp: number): ApiUpdateMeta => {
  return {
    id: crypto.randomUUID(),
    at: timestamp,
    source: 'api',
    ...capApiTaskUpdates(Array.from(updates, ([id, state]) => ({ id, state }))),
  };
};
type ProgressReadInputs = {
  modeText: string;
  gameEdition: number;
  fallbackDisplayName: string | null;
  aliases: TaskIdAliasMapping;
  tasks: TarkovTask[];
  hideout: TarkovHideoutStation[];
};
type CachedProgressRead = ProgressReadInputs & {
  hasDisplayName: boolean;
  representation: ReadRepresentation;
};
const MAX_PROGRESS_READS = 32;
const MAX_PROGRESS_READ_BYTES = 128 * 1024;
const progressReads = new Map<string, CachedProgressRead>();
function matchesProgressRead(previous: CachedProgressRead, inputs: ProgressReadInputs): boolean {
  return (
    previous.gameEdition === inputs.gameEdition &&
    previous.fallbackDisplayName === inputs.fallbackDisplayName &&
    previous.aliases === inputs.aliases &&
    previous.tasks === inputs.tasks &&
    previous.hideout === inputs.hideout
  );
}
function rememberProgressRead(key: string, entry: CachedProgressRead): void {
  progressReads.delete(key);
  if (entry.modeText.length * 2 + entry.representation.payload.byteLength > MAX_PROGRESS_READ_BYTES)
    return;
  if (progressReads.size === MAX_PROGRESS_READS) {
    const oldest = progressReads.keys().next();
    if (!oldest.done) progressReads.delete(oldest.value);
  }
  progressReads.set(key, entry);
}
function parseProgressRead(modeText: string) {
  const [row] = JSON.parse(modeText) as ProgressModeRowFragment[];
  return hasMaterializedProgress(row?.progress_data) ? row.progress_data : null;
}
/** Build the private representation for GET /progress. */
export async function handleGetProgress(
  env: Env,
  token: ApiToken,
  gameMode: GameMode
): Promise<ReadRepresentation> {
  const userId = token.user_id;
  const season = await getGameModeSeasonNumber(env, gameMode);
  const { modeText, gameEdition } = await fetchProgressRowPair(env, userId, gameMode, season);
  const key = JSON.stringify([env.SUPABASE_URL, userId, gameMode, season]);
  const previous = progressReads.get(key);
  const matchingRow = previous?.modeText === modeText ? previous : undefined;
  const parsed = matchingRow ? undefined : parseProgressRead(modeText);
  // Task identity reconciliation only rewrites task-keyed fields.
  const storedName = parsed?.displayName;
  const hasDisplayName =
    matchingRow?.hasDisplayName ?? (typeof storedName === 'string' && storedName.trim().length > 0);
  const aliases = await getTaskIdAliases(env, gameMode);
  const fallbackDisplayName = hasDisplayName ? null : await getUserDisplayName(env, userId);
  const [tasks, hideout] = await Promise.all([
    getTasks(gameMode),
    getHideoutStations(gameMode),
  ]);
  // Recheck the same sources on every request. Catalog and alias refreshes replace
  // their snapshots, so even a catalog-only change invalidates this representation.
  const inputs = { modeText, gameEdition, fallbackDisplayName, aliases, tasks, hideout };
  if (matchingRow && matchesProgressRead(matchingRow, inputs)) {
    rememberProgressRead(key, matchingRow);
    return matchingRow.representation;
  }
  const rawProgress = parsed === undefined ? parseProgressRead(modeText) : parsed;
  const progressData = rawProgress ? reconcileTaskIdentities(rawProgress, aliases) : null;
  const data = transformProgress(
    progressData,
    userId,
    gameEdition,
    tasks,
    hideout,
    fallbackDisplayName
  );
  const representation = await prepareReadRepresentation({
    data,
    meta: { self: userId, gameMode },
  });
  rememberProgressRead(key, { ...inputs, hasDisplayName, representation });
  return representation;
}
/**
 * Handle POST /api/progress/level/:levelValue - Update player level
 */
export async function handleUpdateLevel(
  env: Env,
  token: ApiToken,
  level: number,
  gameMode: GameMode
): Promise<{ level: number; message: string }> {
  const dataField = getProgressDataField(gameMode);
  await mergeProgressData(env, token, dataField, { set: { level } }, { action: 'update-level' });
  return { level, message: 'Level updated successfully' };
}
/**
 * Handle POST /api/progress/task/objective/:objectiveId - Update task objective
 */
export async function handleUpdateObjective(
  env: Env,
  token: ApiToken,
  objectiveId: string,
  update: { state?: string; count?: number },
  gameMode: GameMode
): Promise<{
  objectiveId: string;
  state?: string;
  count?: number;
  message: string;
}> {
  const aliases = await getTaskIdAliases(env, gameMode);
  objectiveId = resolveObjectiveId(objectiveId, aliases);
  await validateObjectiveId(gameMode, objectiveId, aliases);
  const dataField = getProgressDataField(gameMode);
  const updateTime = Date.now();
  // Build the patch from `update` only and let the RPC's per-key objective
  // merge preserve untouched fields server-side. Reading the current objective
  // here would race a concurrent writer and could carry a stale `complete` or
  // `count` back into the merge, reintroducing the lost-update this refactor
  // fixes. Every objective write bumps `timestamp` to mark last touch.
  const objectiveData: Record<string, unknown> = {};
  if (update.state !== undefined) {
    objectiveData.complete = update.state === 'completed';
    objectiveData.timestamp = updateTime;
  }
  if (update.count !== undefined) {
    objectiveData.count = update.count;
    objectiveData.timestamp = updateTime;
  }
  await mergeProgressData(
    env,
    token,
    dataField,
    { taskObjectives: { [objectiveId]: objectiveData } },
    { action: 'update-objective', taskIds: [objectiveId] }
  );
  return {
    objectiveId,
    ...(update.state !== undefined && { state: update.state }),
    ...(update.count !== undefined && { count: update.count }),
    message: 'Task objective updated successfully',
  };
}
/**
 * Handle POST /api/progress/task/:taskId - Update single task
 */
export async function handleUpdateTask(
  env: Env,
  token: ApiToken,
  taskId: string,
  state: TaskState,
  gameMode: GameMode
): Promise<{ taskId: string; state: string; message: string }> {
  const aliases = await getTaskIdAliases(env, gameMode);
  taskId = resolveTaskId(taskId, aliases);
  await validateTaskIds(gameMode, [taskId], aliases);
  const updateTime = Date.now();
  const dataField = getProgressDataField(gameMode);
  const currentData = reconcileTaskIdentities(
    await fetchCurrentProgressData(env, token.user_id, gameMode),
    aliases
  );
  const taskCompletions = (currentData.taskCompletions as Record<string, TaskCompletion>) || {};
  const updateMap = new Map<string, TaskState>();
  setTaskState(taskCompletions, taskId, state, { timestamp: updateTime, updates: updateMap });
  const changedCompletions = { [taskId]: taskCompletions[taskId] };
  const set: Record<string, unknown> = {};
  if (updateMap.size > 0) {
    set.lastApiUpdate = buildApiUpdateMeta(updateMap, updateTime);
  }
  await mergeProgressData(
    env,
    token,
    dataField,
    { taskCompletions: changedCompletions, ...(updateMap.size > 0 && { set }) },
    { action: 'update-task', taskIds: [taskId] }
  );
  return { taskId, state, message: 'Task updated successfully' };
}
/**
 * Handle POST /api/progress/tasks - Batch update tasks
 */
export async function handleUpdateTasks(
  env: Env,
  token: ApiToken,
  updates: BatchTaskUpdate[],
  gameMode: GameMode
): Promise<{ updatedTasks: string[]; message: string }> {
  const aliases = await getTaskIdAliases(env, gameMode);
  const requestedIds = updates.map(({ id }) => resolveTaskId(id, aliases));
  const finalStates = new Map(requestedIds.map((id, index) => [id, updates[index].state]));
  await validateTaskIds(gameMode, [...finalStates.keys()], aliases);
  const dataField = getProgressDataField(gameMode);
  const updateTime = Date.now();
  // Fetch current data
  const currentData = reconcileTaskIdentities(
    await fetchCurrentProgressData(env, token.user_id, gameMode),
    aliases
  );
  const taskCompletions = (currentData.taskCompletions as Record<string, TaskCompletion>) || {};
  const updateMap = new Map<string, TaskState>();
  const changedCompletions: Record<string, TaskCompletion> = {};
  for (const [id, state] of finalStates) {
    setTaskState(taskCompletions, id, state, { timestamp: updateTime, updates: updateMap });
    changedCompletions[id] = taskCompletions[id];
  }
  const set: Record<string, unknown> = {};
  if (updateMap.size > 0) {
    set.lastApiUpdate = buildApiUpdateMeta(updateMap, updateTime);
  }
  await mergeProgressData(
    env,
    token,
    dataField,
    { taskCompletions: changedCompletions, ...(updateMap.size > 0 && { set }) },
    { action: 'update-tasks', taskIds: requestedIds }
  );
  return {
    updatedTasks: requestedIds,
    message: 'Tasks updated successfully',
  };
}
