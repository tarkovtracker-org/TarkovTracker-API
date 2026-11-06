/** Permanent overlay identities. Mode names here are upstream catalog names. */
export type AliasMode = 'regular' | 'pve' | 'pvp-season';
export interface TaskIdAliasMapping {
  tasks: Record<string, string>;
  objectives: Record<string, { id: string; taskId: string }>;
}
export interface TaskIdAliases {
  schemaVersion: 1;
  modes: Record<AliasMode, TaskIdAliasMapping>;
}
const MODES: AliasMode[] = ['regular', 'pve', 'pvp-season'];
const CLIENT_ID = /^[0-9a-f]{24}$/;
const TASK_ALIAS = /^placeholder_[a-z0-9_]+$/;
const OBJECTIVE_ALIAS = /^placeholder_[a-z0-9_]+_obj[0-9]+$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requireKeys(
  value: unknown,
  keys: readonly string[]
): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error('Invalid task identity manifest keys');
  }
}
function uniqueTarget(target: unknown, seen: Set<string>): asserts target is string {
  if (typeof target !== 'string' || !CLIENT_ID.test(target) || seen.has(target)) {
    throw new Error('Invalid or duplicate task identity target');
  }
  seen.add(target);
}
function parseTasks(value: unknown): Record<string, string> {
  if (!record(value)) throw new Error('Invalid task identity map');
  const seen = new Set<string>();
  return Object.fromEntries(
    Object.entries(value).map(([source, target]) => {
      if (!TASK_ALIAS.test(source)) throw new Error('Invalid task identity source');
      uniqueTarget(target, seen);
      return [source, target];
    })
  );
}
function parseObjectives(
  value: unknown,
  tasks: Record<string, string>
): TaskIdAliasMapping['objectives'] {
  if (!record(value)) throw new Error('Invalid objective identity map');
  const seen = new Set<string>();
  return Object.fromEntries(
    Object.entries(value).map(([source, target]) => {
      if (!OBJECTIVE_ALIAS.test(source)) throw new Error('Invalid objective identity source');
      requireKeys(target, ['id', 'taskId']);
      uniqueTarget(target.id, seen);
      if (
        typeof target.taskId !== 'string' ||
        tasks[source.replace(/_obj\d+$/, '')] !== target.taskId
      ) {
        throw new Error('Objective identity does not match its parent task');
      }
      return [source, { id: target.id, taskId: target.taskId }];
    })
  );
}
function parseMapping(value: unknown): TaskIdAliasMapping {
  requireKeys(value, ['tasks', 'objectives']);
  const tasks = parseTasks(value.tasks);
  return { tasks, objectives: parseObjectives(value.objectives, tasks) };
}
/** Reject malformed manifests atomically; a partially accepted map could corrupt identity. */
export function parseTaskIdAliases(value: unknown): TaskIdAliases {
  requireKeys(value, ['schemaVersion', 'modes']);
  if (value.schemaVersion !== 1) throw new Error('Unsupported task identity schema');
  requireKeys(value.modes, MODES);
  const modes = value.modes;
  return {
    schemaVersion: 1,
    modes: Object.fromEntries(
      MODES.map((mode) => [mode, parseMapping(modes[mode])])
    ) as TaskIdAliases['modes'],
  };
}
export const emptyTaskIdAliases = (): TaskIdAliases => ({
  schemaVersion: 1,
  modes: {
    regular: { tasks: {}, objectives: {} },
    pve: { tasks: {}, objectives: {} },
    'pvp-season': { tasks: {}, objectives: {} },
  },
});
export const taskAliasMode = (mode: 'pvp' | 'pve' | 'seasonal'): AliasMode =>
  mode === 'pvp' ? 'regular' : mode === 'seasonal' ? 'pvp-season' : 'pve';
export const resolveTaskId = (id: string, aliases: TaskIdAliasMapping): string =>
  Object.hasOwn(aliases.tasks, id) ? aliases.tasks[id]! : id;
export const resolveObjectiveId = (id: string, aliases: TaskIdAliasMapping): string =>
  Object.hasOwn(aliases.objectives, id) ? aliases.objectives[id]!.id : id;
type ProgressMap = Record<string, unknown>;
export interface IdentityProgress {
  progressEpoch?: number;
  taskCompletions?: ProgressMap;
  taskObjectives?: ProgressMap;
  taskAvailability?: ProgressMap;
}
const clock = (value: unknown): number | undefined => {
  const timestamp = record(value) ? value.timestamp : undefined;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0
    ? timestamp
    : undefined;
};
type Candidate = { value: unknown; canonical: boolean; current: boolean };
function compareCandidates(a: Candidate, b: Candidate): number {
  const left = clock(a.value);
  const right = clock(b.value);
  const timeOrder = left !== undefined && right !== undefined ? left - right : 0;
  return (
    timeOrder || Number(a.canonical) - Number(b.canonical) || Number(a.current) - Number(b.current)
  );
}
/** Merge only explicit objective fields; the winner alone supplies clock evidence. */
function resolveCandidate(candidates: Candidate[], partial: boolean): unknown {
  const winner = candidates.at(-1)?.value;
  if (!partial || !record(winner)) return winner;
  const result = candidates.reduce<ProgressMap>(
    (merged, candidate) => (record(candidate.value) ? { ...merged, ...candidate.value } : merged),
    {}
  );
  if (!Object.hasOwn(winner, 'timestamp')) delete result.timestamp;
  return result;
}
function identityCandidate(
  current: ProgressMap,
  previous: ProgressMap,
  id: string,
  canonical: boolean,
  partial: boolean
): Candidate[] {
  const candidates = [
    { map: previous, isCurrent: false },
    { map: current, isCurrent: true },
  ]
    .flatMap(({ map, isCurrent }) =>
      Object.hasOwn(map, id) ? [{ value: map[id], canonical, current: isCurrent }] : []
    )
    .sort(compareCandidates);
  const winner = candidates.at(-1);
  return winner ? [{ ...winner, value: resolveCandidate(candidates, partial) }] : [];
}
/** Collapse each identity first: unknown clocks cannot form a transitive multi-record ordering. */
function collectCandidates(
  current: ProgressMap,
  previous: ProgressMap,
  source: string,
  target: string,
  partial: boolean
): Candidate[] {
  return [
    ...identityCandidate(current, previous, source, false, partial),
    ...identityCandidate(current, previous, target, true, partial),
  ].sort(compareCandidates);
}
function reconcileMap(
  current: ProgressMap | undefined,
  previous: ProgressMap | undefined,
  aliases: Record<string, string>,
  partial: boolean
): ProgressMap | undefined {
  let result = current;
  for (const [source, target] of Object.entries(aliases)) {
    const candidates = collectCandidates(current ?? {}, previous ?? {}, source, target, partial);
    if (!candidates.length) continue;
    result = { ...result, [target]: resolveCandidate(candidates, partial) };
    delete result[source];
  }
  return result;
}
/**
 * Re-key a mode without manufacturing edits or dropping unmapped records. `previous` is
 * optional merge-boundary evidence for alias families only; unrelated merge rules stay with
 * the caller. Different reset epochs never contribute records to one another.
 */
export function reconcileTaskIdentities<T extends IdentityProgress>(
  current: T,
  aliases: TaskIdAliasMapping,
  previous?: IdentityProgress
): T {
  const prior =
    (current.progressEpoch ?? 0) === (previous?.progressEpoch ?? 0) ? previous : undefined;
  const objectives = Object.fromEntries(
    Object.entries(aliases.objectives).map(([source, target]) => [source, target.id])
  );
  const result = { ...current };
  const completions = reconcileMap(
    current.taskCompletions,
    prior?.taskCompletions,
    aliases.tasks,
    false
  );
  const objectiveProgress = reconcileMap(
    current.taskObjectives,
    prior?.taskObjectives,
    objectives,
    true
  );
  const availability = reconcileMap(
    current.taskAvailability,
    prior?.taskAvailability,
    aliases.tasks,
    false
  );
  if (completions !== undefined) result.taskCompletions = completions;
  if (objectiveProgress !== undefined) result.taskObjectives = objectiveProgress;
  if (availability !== undefined) result.taskAvailability = availability;
  return result;
}
export function reconcileTaskIdList(ids: readonly string[], aliases: TaskIdAliasMapping): string[] {
  return [...new Set(ids.map((id) => resolveTaskId(id, aliases)))];
}
