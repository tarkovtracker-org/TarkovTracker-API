import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '@tarkovtracker/progress-contracts/fixtures/task-id-aliases.json';
import type { Env } from '../types';
const env = {
  SUPABASE_URL: 'https://aliases.example',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only',
  TASK_ID_ALIASES_ENABLED: 'true',
} as Env;
beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('authoritative task identity manifests', () => {
  it('does not call a new RPC until enabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getTaskIdAliases } = await import('../services/task-id-aliases');
    expect(await getTaskIdAliases({ ...env, TASK_ID_ALIASES_ENABLED: 'false' }, 'pvp')).toEqual({
      tasks: {},
      objectives: {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('caches validated data, keeps modes isolated and revalidates after one minute', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json(fixture));
    vi.stubGlobal('fetch', fetchMock);
    const { getTaskIdAliases } = await import('../services/task-id-aliases');
    expect(await getTaskIdAliases(env, 'pvp')).toEqual(fixture.modes.regular);
    expect(await getTaskIdAliases(env, 'pve')).toEqual(fixture.modes.pve);
    expect(await getTaskIdAliases(env, 'seasonal')).toEqual(fixture.modes['pvp-season']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    fetchMock.mockImplementationOnce(async () => new Response('unavailable', { status: 503 }));
    await expect(getTaskIdAliases(env, 'pvp')).rejects.toThrow('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([{}, { ...fixture, schemaVersion: 2 }])(
    'fails closed for an invalid manifest %j',
    async (value) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(value))
      );
      const { getTaskIdAliases } = await import('../services/task-id-aliases');
      await expect(getTaskIdAliases(env, 'pvp')).rejects.toThrow();
    }
  );
  it('bounds streamed responses without trusting content-length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(' '.repeat(256 * 1024 + 1)))
    );
    const { getTaskIdAliases } = await import('../services/task-id-aliases');
    await expect(getTaskIdAliases(env, 'pvp')).rejects.toThrow('size limit');
  });
});
