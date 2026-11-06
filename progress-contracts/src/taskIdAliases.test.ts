import parityCases from '../fixtures/task-id-alias-cases.json';
import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/task-id-aliases.json';
import {
  emptyTaskIdAliases,
  parseTaskIdAliases,
  reconcileTaskIdentities,
  reconcileTaskIdList,
  resolveObjectiveId,
  resolveTaskId,
  taskAliasMode,
} from './taskIdAliases';
const source = 'placeholder_honest_review';
const task = '6a764077161e4b45b101566e';
const objective = '6a7640eeb85e5647f3dac115';
const oldObjective = `${source}_obj01`;
const mapping = () => parseTaskIdAliases(fixture).modes.regular;
describe('permanent task identities', () => {
  it('migrates the verified fixture and preserves unknown tasks and metadata', () => {
    const saved = {
      progressEpoch: 4,
      level: 42,
      taskCompletions: {
        [source]: {
          complete: true,
          failed: false,
          manual: true,
          timestamp: 10,
        },
        placeholder_unknown: { complete: true },
      },
      taskObjectives: {
        [oldObjective]: { complete: false, count: 3, timestamp: 11 },
      },
      taskAvailability: { [source]: { available: true, timestamp: 12 } },
    };
    const result = reconcileTaskIdentities(saved, mapping());
    expect(result).toEqual({
      ...saved,
      taskCompletions: {
        [task]: saved.taskCompletions[source],
        placeholder_unknown: { complete: true },
      },
      taskObjectives: { [objective]: saved.taskObjectives[oldObjective] },
      taskAvailability: { [task]: saved.taskAvailability[source] },
    });
    expect(saved.taskCompletions).toHaveProperty(source);
    expect(reconcileTaskIdentities(result, mapping())).toEqual(result);
  });
  it.each(['pvp', 'pve', 'seasonal'] as const)('resolves only aliases proven for %s', (mode) => {
    const aliases = parseTaskIdAliases(fixture).modes[taskAliasMode(mode)];
    expect(resolveTaskId(source, aliases)).toBe(mode === 'pve' ? source : task);
    expect(resolveTaskId('placeholder_uninvited_guests_part_1', aliases)).toBe(
      mode === 'seasonal' ? '6a4f528221e50974ab006f6f' : 'placeholder_uninvited_guests_part_1'
    );
    expect(resolveObjectiveId(oldObjective, aliases)).toBe(
      mode === 'pve' ? oldObjective : objective
    );
  });
  it('preserves newer unchecks and reduced counts over old completed placeholders', () => {
    const saved = {
      taskCompletions: {
        [source]: { complete: true, timestamp: 10 },
        [task]: { complete: false, failed: false, timestamp: 20 },
      },
      taskObjectives: {
        [oldObjective]: { complete: true, count: 12, timestamp: 10 },
        [objective]: { complete: false, count: 0, timestamp: 20 },
      },
    };
    expect(reconcileTaskIdentities(saved, mapping())).toEqual({
      taskCompletions: {
        [task]: { complete: false, failed: false, timestamp: 20 },
      },
      taskObjectives: {
        [objective]: { complete: false, count: 0, timestamp: 20 },
      },
    });
  });
  it('accepts a newer explicit edit from an old device without synthesizing a clock', () => {
    const prior = {
      taskCompletions: { [task]: { complete: false, timestamp: 20 } },
    };
    const incoming = {
      taskCompletions: { [source]: { complete: true, timestamp: 30 } },
    };
    expect(reconcileTaskIdentities(incoming, mapping(), prior).taskCompletions).toEqual({
      [task]: { complete: true, timestamp: 30 },
    });
  });
  it('retains a newer canonical edit missing from an old client snapshot', () => {
    const prior = {
      taskCompletions: { [task]: { complete: false, timestamp: 30 } },
      taskObjectives: {
        [objective]: { complete: false, count: 1, timestamp: 30 },
      },
    };
    const incoming = {
      taskCompletions: { [source]: { complete: true, timestamp: 10 } },
      taskObjectives: {
        [oldObjective]: { complete: true, count: 9, timestamp: 10 },
      },
    };
    expect(reconcileTaskIdentities(incoming, mapping(), prior)).toEqual(prior);
  });
  it.each([undefined, 10])(
    'prefers canonical identities on equal or unknown clocks (%s)',
    (timestamp) => {
      const canonical = { complete: false, failed: true, timestamp };
      const current = {
        taskCompletions: {
          [task]: canonical,
          [source]: { complete: true, timestamp },
        },
      };
      expect(reconcileTaskIdentities(current, mapping()).taskCompletions).toEqual({
        [task]: canonical,
      });
    }
  );
  it.each([undefined, Number.NaN, -1])(
    'prefers canonical records when one clock is unknown (%s)',
    (timestamp) => {
      const current = {
        taskCompletions: {
          [source]: { complete: true, timestamp: 30 },
          [task]: { complete: false, timestamp },
        },
        taskObjectives: {
          [oldObjective]: { complete: true, count: 9, timestamp: 30 },
          [objective]: { complete: false, count: 0, timestamp },
        },
        taskAvailability: {
          [source]: { available: true, timestamp: 30 },
          [task]: { available: false, timestamp },
        },
      };
      const result = reconcileTaskIdentities(current, mapping());
      expect(result.taskCompletions).toEqual({ [task]: current.taskCompletions[task] });
      expect(result.taskObjectives).toEqual({ [objective]: current.taskObjectives[objective] });
      expect(result.taskAvailability).toEqual({ [task]: current.taskAvailability[task] });
    }
  );
  it('does not manufacture an objective clock from a losing identity', () => {
    const result = reconcileTaskIdentities(
      {
        taskObjectives: {
          [oldObjective]: { complete: true, count: 9, timestamp: 30 },
          [objective]: { count: 0 },
        },
      },
      mapping()
    );
    expect(result.taskObjectives).toEqual({ [objective]: { complete: true, count: 0 } });
  });
  it('collapses each identity before comparing clocks and uses current for same-ID ties', () => {
    const current = {
      taskCompletions: {
        [source]: { complete: true, timestamp: 30 },
        [task]: { complete: false, timestamp: 40 },
      },
    };
    const previous = { taskCompletions: { [task]: { complete: true } } };
    expect(reconcileTaskIdentities(current, mapping(), previous).taskCompletions).toEqual({
      [task]: current.taskCompletions[task],
    });
    expect(
      reconcileTaskIdentities(
        { taskCompletions: { [task]: { complete: false } } },
        mapping(),
        previous
      ).taskCompletions
    ).toEqual({ [task]: { complete: false } });
  });
  it('keeps unrelated fields and sparse objective fields without taking maximum count', () => {
    const current = {
      taskObjectives: { [oldObjective]: { count: 1, timestamp: 30 } },
      taskCompletions: { unrelated: false },
    };
    const previous = {
      taskObjectives: {
        [objective]: {
          complete: true,
          count: 10,
          timestamp: 20,
          custom: 'retained',
        },
      },
      taskCompletions: { other: true },
    };
    expect(reconcileTaskIdentities(current, mapping(), previous)).toEqual({
      taskObjectives: {
        [objective]: {
          complete: true,
          count: 1,
          timestamp: 30,
          custom: 'retained',
        },
      },
      taskCompletions: { unrelated: false },
    });
  });
  it('never brings previous-epoch completion into a reset', () => {
    expect(
      reconcileTaskIdentities({ progressEpoch: 3, taskCompletions: {} }, mapping(), {
        progressEpoch: 2,
        taskCompletions: { [source]: { complete: true, timestamp: 999 } },
      })
    ).toEqual({ progressEpoch: 3, taskCompletions: {} });
  });
  it('preserves unmapped records and legacy booleans, including empty snapshots', () => {
    expect(reconcileTaskIdentities({}, mapping())).toEqual({});
    expect(
      reconcileTaskIdentities(
        {
          taskCompletions: { [source]: true, unknown: false },
          taskObjectives: { placeholder_unknown_obj01: { count: 2 } },
        },
        mapping()
      )
    ).toEqual({
      taskCompletions: { [task]: true, unknown: false },
      taskObjectives: { placeholder_unknown_obj01: { count: 2 } },
    });
  });
  it('deduplicates pinned/hidden task IDs in their existing order', () => {
    expect(reconcileTaskIdList([source, 'other', task, 'other'], mapping())).toEqual([
      task,
      'other',
    ]);
  });
  it('returns independent empty manifests', () => {
    const aliases = emptyTaskIdAliases();
    aliases.modes.regular.tasks[source] = task;
    expect(emptyTaskIdAliases().modes.regular.tasks).toEqual({});
  });
  it.each([null, {}, [], { ...fixture, schemaVersion: 2 }, { ...fixture, extra: true }])(
    'rejects malformed envelopes (%j)',
    (value) => {
      expect(() => parseTaskIdAliases(value)).toThrow();
    }
  );
  it('rejects missing modes, cycles, collisions and unproven objective parents', () => {
    const missing = structuredClone(fixture);
    Reflect.deleteProperty(missing.modes, 'pve');
    expect(() => parseTaskIdAliases(missing)).toThrow();
    const cycle = structuredClone(fixture);
    cycle.modes.regular.tasks[source] = source;
    expect(() => parseTaskIdAliases(cycle)).toThrow();
    const duplicate = structuredClone(fixture);
    Object.assign(duplicate.modes.regular.tasks, { placeholder_other: task });
    expect(() => parseTaskIdAliases(duplicate)).toThrow();
    const missingParent = {
      ...emptyTaskIdAliases(),
      modes: {
        ...emptyTaskIdAliases().modes,
        regular: {
          tasks: {},
          objectives: { [oldObjective]: { id: objective, taskId: undefined } },
        },
      },
    };
    expect(() => parseTaskIdAliases(missingParent)).toThrow();
    const wrongParent = structuredClone(fixture);
    wrongParent.modes.regular.objectives[oldObjective as 'placeholder_honest_review_obj01'].taskId =
      '6a4f528221e50974ab006f6f';
    expect(() => parseTaskIdAliases(wrongParent)).toThrow();
  });
});
describe('database/browser/Worker parity fixtures', () => {
  it.each(parityCases)('$name', ({ current, previous, mode, expected }) => {
    expect(['pvp', 'pve', 'seasonal']).toContain(mode);
    const aliases =
      parseTaskIdAliases(fixture).modes[taskAliasMode(mode as 'pvp' | 'pve' | 'seasonal')];
    expect(reconcileTaskIdentities(current, aliases, previous)).toEqual(expected);
  });
});
