import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetProgress } from '../handlers/progress';
import { handleGetTeamProgress } from '../handlers/team';
import { deleteMemoryCache } from '../utils/memory-cache';
import { logger } from '../utils/logger';
import { getUserDisplayName } from '../utils/user-display-name';
import type { ApiToken, Env, GameMode } from '../types';
vi.mock('../services/tarkov', () => ({
  getTasks: vi.fn(async () => []),
  getHideoutStations: vi.fn(async () => []),
}));
const env: Env = {
  API_GATEWAY_LIMITER: {} as Env['API_GATEWAY_LIMITER'],
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  ALLOWED_ORIGIN: '*',
};
const token: ApiToken = {
  token_id: 'token-1',
  user_id: 'lookup-user',
  token_hash: 'hash',
  permissions: ['GP', 'TP'],
  game_mode: 'pvp',
  is_active: true,
  usage_count: 0,
};
const jsonResponse = (data: unknown) => new Response(JSON.stringify(data));
const readers = [
  ['personal', handleGetProgress],
  ['team', handleGetTeamProgress],
] as const;
const modes: GameMode[] = ['pvp', 'pve', 'seasonal'];
const phases = ['headers', 'body'] as const;
const cases = readers.flatMap(([endpoint, read]) =>
  modes.flatMap((gameMode) => phases.map((phase) => ({ endpoint, read, gameMode, phase })))
);
describe('optional display-name lookup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    deleteMemoryCache('user-display:lookup-user');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it.each(cases)(
    '$endpoint $gameMode progress continues when lookup $phase stall',
    async ({ read, gameMode, phase }) => {
      const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      let signal: AbortSignal | null | undefined;
      let lookupStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        lookupStarted = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.includes('/auth/v1/admin/users/')) {
            signal = init?.signal;
            lookupStarted();
            if (phase === 'headers') {
              return new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
              });
            }
            return new Response(
              new ReadableStream({
                start(controller) {
                  signal?.addEventListener('abort', () => controller.error(signal?.reason), {
                    once: true,
                  });
                },
              })
            );
          }
          if (url.includes('/team_memberships')) {
            return jsonResponse(
              url.includes('team_id=eq.') ? [{ user_id: token.user_id }] : [{ team_id: 'team-1' }]
            );
          }
          if (url.includes('/user_game_mode_progress')) {
            return jsonResponse([
              { user_id: token.user_id, progress_data: { level: 12, taskCompletions: {} } },
            ]);
          }
          if (url.includes('/user_progress'))
            return jsonResponse([{ user_id: token.user_id, game_edition: 2 }]);
          if (url.includes('/get_active_season_number')) return jsonResponse(1);
          throw new Error(`Unexpected fetch: ${url}`);
        })
      );
      let settled = false;
      const result = read(env, token, gameMode).then((value) => {
        settled = true;
        return value;
      });
      await started;
      await vi.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const response = await result;
      const data = Array.isArray(response.data) ? response.data[0] : response.data;
      expect(data).toMatchObject({
        displayName: 'lookup',
        userId: token.user_id,
        playerLevel: 12,
        gameEdition: 2,
      });
      expect(signal?.aborted).toBe(true);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      const recoveredFetch = vi.fn(async () =>
        jsonResponse({ user_metadata: { full_name: 'Recovered' } })
      );
      vi.stubGlobal('fetch', recoveredFetch);
      expect(await getUserDisplayName(env, token.user_id)).toBe('Recovered');
      expect(await getUserDisplayName(env, token.user_id)).toBe('Recovered');
      expect(recoveredFetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
  it.each([404, 500])('keeps HTTP %s fallback uncached and clears its deadline', async (status) => {
    const fetchMock = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getUserDisplayName(env, token.user_id)).toBeNull();
    expect(await getUserDisplayName(env, token.user_id)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
