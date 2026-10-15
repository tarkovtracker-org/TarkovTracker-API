/**
 * Explicit task-state writes shared by progress writers.
 *
 * Runtime-independent: callers write only requested IDs. Dependents are never rewritten,
 * preserving concurrent and explicit progress. Terminal and uncompleted writes clear active.
 */
export type TransitionTaskState = 'active' | 'completed' | 'uncompleted' | 'failed';
export type TransitionCompletion = {
  complete?: boolean;
  failed?: boolean;
  active?: boolean;
  timestamp?: number;
};
export type TransitionTask = {
  id: string;
  taskRequirements?: Array<{ task?: { id: string }; status?: string[] } | null | undefined>;
};
type Completions = Record<string, TransitionCompletion>;
export type TaskTransitionOptions = {
  timestamp: number;
  updates?: Map<string, TransitionTaskState>;
  /** Retained for source compatibility; transitions no longer write dependents. */
  protectedTaskIds?: ReadonlySet<string>;
};
export const toTransitionTaskState = (completion?: TransitionCompletion): TransitionTaskState => {
  if (completion?.failed === true) return 'failed';
  if (completion?.complete === true) return 'completed';
  return completion?.active === true ? 'active' : 'uncompleted';
};
export function setTaskState(
  completions: Completions,
  taskId: string,
  state: TransitionTaskState,
  { timestamp, updates }: TaskTransitionOptions
): void {
  const previous = toTransitionTaskState(completions[taskId]);
  completions[taskId] = {
    complete: state === 'completed' || state === 'failed',
    failed: state === 'failed',
    active: state === 'active',
    timestamp,
  };
  if (updates && previous !== state) updates.set(taskId, state);
}
/** Compatibility entry point: apply only the requested state, irrespective of the catalog. */
export function applyTaskTransition(
  completions: Completions,
  _tasks: readonly TransitionTask[],
  changed: { taskId: string; state: TransitionTaskState },
  options: TaskTransitionOptions
): void {
  setTaskState(completions, changed.taskId, changed.state, options);
}
