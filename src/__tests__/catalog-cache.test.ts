import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCatalogSnapshot } from '../services/catalog-cache';
import { getHideoutStations, getTasks } from '../services/tarkov';
import { deleteMemoryCache } from '../utils/memory-cache';
import { getTaskCatalogInvalidator } from '../utils/task-catalog';
const validEntry = (value: Record<string, unknown>) => typeof value.id === 'string';
describe('public catalog snapshots', () => {
  let entries: Map<string, Response>;
  let match: ReturnType<typeof vi.fn>;
  let put: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    entries = new Map();
    match = vi.fn(async (key: string) => entries.get(key)?.clone());
    put = vi.fn(async (key: string, response: Response) => {
      entries.set(key, response.clone());
    });
    vi.stubGlobal('caches', { default: { match, put } });
    for (const mode of ['regular', 'pve', 'pvp-season']) {
      deleteMemoryCache(`tarkov:tasks:${mode}`);
      deleteMemoryCache(`tarkov:hideout:${mode}`);
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('reuses the smaller snapshot without extending its original expiry', async () => {
    const load = vi.fn(async () => [{ id: 'public-task' }]);
    const first = await loadCatalogSnapshot('tasks/regular', load, validEntry);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0]).toBe(
      'https://api.tarkovtracker.org/.internal/catalog-cache/v1/tasks/regular'
    );
    expect(put.mock.calls[0][1].headers.get('Cache-Control')).toBe('public, max-age=3600');
    vi.setSystemTime(Date.now() + 3_599_000);
    expect(await loadCatalogSnapshot('tasks/regular', load, validEntry)).toEqual(first);
    expect(load).toHaveBeenCalledOnce();
    vi.setSystemTime(first.expiresAt);
    await loadCatalogSnapshot('tasks/regular', load, validEntry);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it.each([
    { name: 'malformed JSON', body: () => '{' },
    { name: 'null envelope', body: () => 'null' },
    {
      name: 'empty catalog',
      body: () => JSON.stringify({ value: [], expiresAt: Date.now() + 1000 }),
    },
    {
      name: 'non-array catalog',
      body: () => JSON.stringify({ value: {}, expiresAt: Date.now() + 1000 }),
    },
    {
      name: 'invalid entry',
      body: () => JSON.stringify({ value: [{ id: 3 }], expiresAt: Date.now() + 1000 }),
    },
    {
      name: 'missing expiry',
      body: () => JSON.stringify({ value: [{ id: 'old' }] }),
    },
    {
      name: 'expired',
      body: () => JSON.stringify({ value: [{ id: 'old' }], expiresAt: 0 }),
    },
    {
      name: 'future expiry',
      body: () => JSON.stringify({ value: [{ id: 'future' }], expiresAt: 9e15 }),
    },
  ])('refetches an unusable snapshot: $name', async ({ body }) => {
    match.mockResolvedValue(new Response(body()));
    const load = vi.fn(async () => [{ id: 'fresh' }]);
    expect((await loadCatalogSnapshot('tasks/regular', load, validEntry)).value).toEqual([
      { id: 'fresh' },
    ]);
    expect(load).toHaveBeenCalledOnce();
  });
  it('does not hide upstream failure behind expired data or cache a rejection', async () => {
    match.mockResolvedValue(Response.json({ value: [{ id: 'expired' }], expiresAt: 0 }));
    await expect(
      loadCatalogSnapshot(
        'tasks/regular',
        async () => {
          throw new Error('offline');
        },
        validEntry
      )
    ).rejects.toThrow('offline');
    expect(put).not.toHaveBeenCalled();
  });
  it('tolerates unavailable cache reads and writes', async () => {
    match.mockRejectedValue(new Error('cache unavailable'));
    put.mockRejectedValue(new Error('cache unavailable'));
    expect(
      (await loadCatalogSnapshot('tasks/regular', async () => [{ id: 'fresh' }], validEntry)).value
    ).toEqual([{ id: 'fresh' }]);
  });
  it('keeps the three public mode snapshots separate across memory eviction', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL) => {
      const id = new URL(String(input)).pathname.split('/')[1];
      return Response.json({
        data: { tasks: { [id]: { id, objectives: [], taskRequirements: [], failConditions: [] } } },
      });
    });
    vi.stubGlobal('fetch', upstream);
    const modes = ['pvp', 'pve', 'seasonal'] as const;
    const first = await Promise.all(modes.map(getTasks));
    for (const mode of ['regular', 'pve', 'pvp-season']) deleteMemoryCache(`tarkov:tasks:${mode}`);
    expect(await Promise.all(modes.map(getTasks))).toEqual(first);
    expect(first.map((tasks) => tasks[0].id)).toEqual(['regular', 'pve', 'pvp-season']);
    expect(entries.size).toBe(3);
    expect(upstream).toHaveBeenCalledTimes(3);
  });
  it('refetches raw upstream-shaped entries instead of treating them as normalized rules', async () => {
    const raw = {
      id: 'child',
      name: 'child',
      objectives: [],
      failConditions: [],
      taskRequirements: [{ task: 'root', status: ['complete'] }],
    };
    match.mockResolvedValue(Response.json({ value: [raw], expiresAt: Date.now() + 1000 }));
    const upstream = vi.fn(async () => Response.json({ data: { tasks: { child: raw } } }));
    vi.stubGlobal('fetch', upstream);
    expect((await getTasks('pvp'))[0].taskRequirements![0].task).toEqual({ id: 'root' });
    expect(upstream).toHaveBeenCalledOnce();
  });
  it('rejects hideout snapshots carrying raw requirement-row IDs', async () => {
    const raw = {
      id: 'stash',
      levels: [
        {
          id: 'level',
          level: 1,
          itemRequirements: [{ id: 'requirement-row', item: 'item-template', count: 2 }],
        },
      ],
    };
    match.mockResolvedValue(Response.json({ value: [raw], expiresAt: Date.now() + 1000 }));
    const upstream = vi.fn(async () => Response.json({ data: { stash: raw } }));
    vi.stubGlobal('fetch', upstream);
    const stations = await getHideoutStations('pvp');
    expect(stations[0].levels![0].itemRequirements).toEqual([{ id: 'item-template', count: 2 }]);
    expect(upstream).toHaveBeenCalledOnce();
  });
  it.each(['pvp', 'pve', 'seasonal'] as const)(
    'restores immutable normalized %s rules and refreshes on the original deadline',
    async (mode) => {
      const upstreamMode = {
        pvp: 'regular',
        pve: 'pve',
        seasonal: 'pvp-season',
      }[mode];
      const upstream = vi.fn(async () =>
        Response.json({
          data: {
            tasks: {
              root: {
                id: 'root',
                objectives: [],
                taskRequirements: [],
                failConditions: [],
              },
              child: {
                id: 'child',
                objectives: [{ id: 'objective' }],
                taskRequirements: [{ task: 'root', status: ['complete'] }],
                failConditions: [],
              },
            },
          },
        })
      );
      vi.stubGlobal('fetch', upstream);
      const first = await getTasks(mode);
      deleteMemoryCache(`tarkov:tasks:${upstreamMode}`);
      vi.setSystemTime(Date.now() + 3_599_000);
      const restored = await getTasks(mode);
      expect(restored).toEqual(first);
      expect(restored).not.toBe(first);
      expect(Object.isFrozen(restored[1].taskRequirements![0].status)).toBe(true);
      expect(
        getTaskCatalogInvalidator(restored)!({
          taskCompletions: { root: { failed: true } },
          pmcFaction: 'USEC',
        })
      ).toEqual({
        invalidTasks: { child: true },
        invalidObjectives: { objective: true },
      });
      expect(upstream).toHaveBeenCalledOnce();
      vi.setSystemTime(Date.now() + 1000);
      upstream.mockRejectedValue(new Error('offline'));
      await expect(getTasks(mode)).rejects.toThrow();
      expect(upstream).toHaveBeenCalledTimes(2);
    }
  );
  it.each(['pvp', 'pve', 'seasonal'] as const)(
    'retains normalized %s hideout item identifiers across memory eviction',
    async (mode) => {
      const upstream = vi.fn(async () =>
        Response.json({
          data: {
            stash: {
              id: 'stash',
              levels: [
                {
                  id: 'level',
                  level: 1,
                  itemRequirements: [{ id: 'requirement-row', item: 'item-template', count: 2 }],
                },
              ],
            },
          },
        })
      );
      vi.stubGlobal('fetch', upstream);
      const first = await getHideoutStations(mode);
      const upstreamMode = {
        pvp: 'regular',
        pve: 'pve',
        seasonal: 'pvp-season',
      }[mode];
      deleteMemoryCache(`tarkov:hideout:${upstreamMode}`);
      expect(await getHideoutStations(mode)).toEqual(first);
      expect(first[0].levels![0].itemRequirements).toEqual([{ id: 'item-template', count: 2 }]);
      expect(upstream).toHaveBeenCalledOnce();
    }
  );
});
