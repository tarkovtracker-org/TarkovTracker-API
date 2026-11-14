import { describe, expect, it } from 'vitest';
import { transformProgress } from '../utils/transform';
import type { TarkovTask, UserProgressData } from '../types';
const baseProgress = (taskCompletions: UserProgressData['taskCompletions']): UserProgressData => ({
  level: 12,
  pmcFaction: 'USEC',
  displayName: 'Tester',
  taskObjectives: {},
  taskCompletions,
  hideoutParts: {},
  hideoutModules: {},
  traders: {},
  skills: {},
  prestigeLevel: 0,
  skillOffsets: {},
});
const entryFor = (tasks: Array<{ id: string; invalid?: boolean }>, id: string) =>
  tasks.find((task) => task.id === id);
describe('transformProgress invalidation', () => {
  it.each([
    { complete: true, failed: false },
    { complete: false, failed: true },
    { complete: true, failed: true },
  ])('preserves terminal flags without invalid ($complete/$failed)', (completion) => {
    const tasks: TarkovTask[] = [
      { id: 'root', name: 'Failed root' },
      { id: 'faction', name: 'BEAR only', factionName: 'BEAR', objectives: [{ id: 'factionObj' }] },
      {
        id: 'dependent',
        name: 'Dependent',
        objectives: [{ id: 'dependentObj' }],
        taskRequirements: [{ task: { id: 'root' }, status: ['complete'] }],
      },
    ];
    const progress = baseProgress({ root: { failed: true }, faction: completion, dependent: completion });
    progress.taskObjectives = { factionObj: { complete: true }, dependentObj: { complete: false } };
    const result = transformProgress(progress, 'user-1', 1, tasks, []);
    for (const id of ['faction', 'dependent']) {
      expect(entryFor(result.tasksProgress, id)).toEqual({
        id,
        complete: completion.complete && !completion.failed,
        ...(completion.failed ? { failed: true } : {}),
      });
    }
    expect(result.taskObjectivesProgress).toEqual([
      { id: 'factionObj', complete: true },
      { id: 'dependentObj', complete: false },
    ]);
  });
  it('honors requirements that accept a failed prerequisite (shared algorithm)', () => {
    // Regression: the worker previously carried its own copy of the invalidation algorithm that
    // ignored `status: ['complete', 'failed']`, so the public API disagreed with the app.
    const tasks: TarkovTask[] = [
      { id: 'chemical4', name: 'Chemical - Part 4' },
      {
        id: 'loyaltyBuyout',
        name: 'Loyalty Buyout',
        taskRequirements: [{ task: { id: 'chemical4' }, status: ['failed'] }],
      },
      {
        id: 'safeCorridor',
        name: 'Safe Corridor',
        taskRequirements: [{ task: { id: 'chemical4' }, status: ['complete', 'failed'] }],
      },
      {
        id: 'strictFollowUp',
        name: 'Strict follow-up',
        taskRequirements: [{ task: { id: 'chemical4' }, status: ['complete'] }],
      },
    ];
    const result = transformProgress(
      baseProgress({
        chemical4: { complete: false, failed: true },
        loyaltyBuyout: { complete: false },
        safeCorridor: { complete: false },
        strictFollowUp: { complete: false },
      }),
      'user-1',
      1,
      tasks,
      []
    );
    expect(entryFor(result.tasksProgress, 'chemical4')).toMatchObject({
      complete: false,
      failed: true,
    });
    expect(entryFor(result.tasksProgress, 'chemical4')?.invalid).toBeUndefined();
    expect(entryFor(result.tasksProgress, 'loyaltyBuyout')?.invalid).toBeUndefined();
    expect(entryFor(result.tasksProgress, 'safeCorridor')?.invalid).toBeUndefined();
    expect(entryFor(result.tasksProgress, 'strictFollowUp')?.invalid).toBe(true);
  });
  it('marks other-faction tasks and their objectives invalid', () => {
    const tasks: TarkovTask[] = [
      { id: 'bearOnly', name: 'BEAR only', factionName: 'BEAR', objectives: [{ id: 'bearObj' }] },
    ];
    const progress = baseProgress({ bearOnly: { complete: false } });
    progress.taskObjectives = { bearObj: { complete: false } };
    const result = transformProgress(progress, 'user-1', 1, tasks, []);
    expect(entryFor(result.tasksProgress, 'bearOnly')?.invalid).toBe(true);
    expect(entryFor(result.taskObjectivesProgress, 'bearObj')?.invalid).toBe(true);
  });
});
describe('transformProgress trader standing', () => {
  const PRAPOR_ID = '54cb50c76803fa8b248b4571';
  const SECOND_TRADER_ID = '54cb57776803fa99248b456e';
  it('returns each stored trader level and reputation', () => {
    const progress = baseProgress({});
    progress.traders = {
      [PRAPOR_ID]: { level: 4, reputation: 0.52 },
      [SECOND_TRADER_ID]: { level: 2, reputation: -0.1 },
    };
    expect(transformProgress(progress, 'user-1', 1, [], []).tradersProgress).toEqual([
      { id: PRAPOR_ID, level: 4, reputation: 0.52 },
      { id: SECOND_TRADER_ID, level: 2, reputation: -0.1 },
    ]);
  });
  it('fills missing or unusable values with the app defaults', () => {
    const progress = baseProgress({});
    progress.traders = {
      onlyLevel: { level: 3 },
      onlyReputation: { reputation: 0.2 },
      fractionalLevel: { level: 2.5, reputation: Number.NaN },
      zeroLevel: { level: 0, reputation: Number.POSITIVE_INFINITY },
      stringValues: { level: '4', reputation: '0.3' },
    } as unknown as UserProgressData['traders'];
    expect(transformProgress(progress, 'user-1', 1, [], []).tradersProgress).toEqual([
      { id: 'onlyLevel', level: 3, reputation: 0 },
      { id: 'onlyReputation', level: 1, reputation: 0.2 },
      { id: 'fractionalLevel', level: 1, reputation: 0 },
      { id: 'zeroLevel', level: 1, reputation: 0 },
      { id: 'stringValues', level: 1, reputation: 0 },
    ]);
  });
  it.each([
    ['no progress row', null],
    ['missing traders', { ...baseProgress({}), traders: undefined }],
    ['array traders', { ...baseProgress({}), traders: [] }],
    ['non-object entries', { ...baseProgress({}), traders: { a: null, b: 3, c: [1] } }],
  ])('returns an empty list for %s', (_label, progress) => {
    const result = transformProgress(
      progress as unknown as UserProgressData | null,
      'user-1',
      1,
      [],
      []
    );
    expect(result.tradersProgress).toEqual([]);
  });
});
