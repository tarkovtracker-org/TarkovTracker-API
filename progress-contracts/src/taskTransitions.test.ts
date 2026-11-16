import { describe, expect, it } from 'vitest';
import {
  applyTaskTransition,
  setTaskState,
  toTransitionTaskState,
  type TransitionCompletion,
  type TransitionTask,
  type TransitionTaskState,
} from './taskTransitions';
const tasks: TransitionTask[] = [
  { id: 'root' },
  { id: 'other' },
  {
    id: 'dependent',
    taskRequirements: [
      { task: { id: 'root' }, status: ['complete'] },
      { task: { id: 'other' }, status: ['complete'] },
    ],
  },
  { id: 'branch', taskRequirements: [{ task: { id: 'root' }, status: ['failed'] }] },
];
const run = (
  completions: Record<string, TransitionCompletion>,
  taskId: string,
  state: TransitionTaskState,
  protectedTaskIds?: Set<string>
) => {
  const updates = new Map<string, TransitionTaskState>();
  applyTaskTransition(
    completions,
    tasks,
    { taskId, state },
    { timestamp: 5, updates, protectedTaskIds }
  );
  return updates;
};
describe('applyTaskTransition', () => {
  it('preserves completed dependents when a prerequisite leaves completed', () => {
    const completions = {
      root: { complete: true, failed: false },
      dependent: { complete: true, failed: false },
    };
    const updates = run(completions, 'root', 'failed');
    expect(completions.root).toEqual({ complete: true, failed: true, active: false, timestamp: 5 });
    expect(completions.dependent).toEqual({ complete: true, failed: false });
    expect([...updates]).toEqual([['root', 'failed']]);
  });
  it('leaves dependents alone even when every requirement is met', () => {
    const completions: Record<string, TransitionCompletion> = {
      dependent: { complete: true, failed: false },
    };
    run(completions, 'root', 'completed');
    expect(completions.dependent).toEqual({ complete: true, failed: false });
    completions.other = { complete: true, failed: false };
    run(completions, 'root', 'completed');
    expect(completions.dependent).toEqual({ complete: true, failed: false });
  });
  it('ignores failed-status requirements and protected tasks', () => {
    const completions = { branch: { complete: true, failed: false } };
    const updates = run(completions, 'root', 'uncompleted', new Set(['dependent']));
    expect(completions).not.toHaveProperty('dependent');
    expect(completions.branch).toEqual({ complete: true, failed: false });
    expect(updates.size).toBe(0);
  });
});
describe('explicit active state', () => {
  it.each([
    ['active', false, false, true],
    ['completed', true, false, false],
    ['failed', true, true, false],
    ['uncompleted', false, false, false],
  ] as const)(
    'writes canonical %s flags and clears previous active',
    (state, complete, failed, active) => {
      const completions = { root: { active: true, complete: false, failed: false } };
      setTaskState(completions, 'root', state, { timestamp: 5 });
      expect(completions.root).toEqual({ complete, failed, active, timestamp: 5 });
    }
  );
  it.each([
    [undefined, 'uncompleted'],
    [{ complete: false }, 'uncompleted'],
    [{ active: true }, 'active'],
    [{ active: true, complete: true }, 'completed'],
    [{ active: true, complete: true, failed: true }, 'failed'],
  ] as const)('reads terminal precedence for %j', (completion, state) => {
    expect(toTransitionTaskState(completion)).toBe(state);
  });
  it('records activation once and does not notify for a repeated acceptance', () => {
    const completions: Record<string, TransitionCompletion> = { root: { complete: false } };
    expect([...run(completions, 'root', 'active')]).toEqual([['root', 'active']]);
    expect([...run(completions, 'root', 'active')]).toEqual([]);
  });
  it.each(['active', 'completed', 'failed'] as const)(
    'does not touch an explicitly %s successor',
    (state) => {
      const completions: Record<string, TransitionCompletion> = {};
      setTaskState(completions, 'dependent', state, { timestamp: 2 });
      const successor = structuredClone(completions.dependent);
      run(completions, 'root', 'completed');
      expect(completions.dependent).toEqual(successor);
      expect(Object.keys(completions)).toEqual(['dependent', 'root']);
    }
  );
});
