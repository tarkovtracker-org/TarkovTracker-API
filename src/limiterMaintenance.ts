// Only shapes emitted by the current limiter and the historical sliding limiter
// (Tracker 0855aa5fea170bb3f5fd417adfc254904309d15c) are recognized.
export type LimiterStateCategory = 'fixed' | 'sliding' | 'unknown';
export type LimiterStateInspection = {
  category: LimiterStateCategory;
  status: 'active' | 'expired' | 'unknown';
};
const COMMON_KEYS = ['count', 'resetAt', 'windowSec', 'ephemeral'];
function nonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function inspectLimiterState(value: unknown, now: number): LimiterStateInspection {
  const unknown = { category: 'unknown', status: 'unknown' } as const;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const state = value as Record<string, unknown>;
  if (!nonnegativeFinite(state.count) || !Number.isSafeInteger(state.count)) return unknown;
  if (!nonnegativeFinite(state.resetAt)) return unknown;
  if (!nonnegativeFinite(state.windowSec) || state.windowSec === 0) return unknown;
  const windowMs = state.windowSec * 1000;
  if (!Number.isFinite(windowMs)) return unknown;
  if (state.ephemeral !== undefined && typeof state.ephemeral !== 'boolean') return unknown;
  const sliding = state.mode === 'sliding';
  const keys = sliding ? [...COMMON_KEYS, 'mode', 'timestamps'] : [...COMMON_KEYS, 'anchor'];
  if (Object.keys(state).some((key) => !keys.includes(key))) return unknown;
  if (sliding) {
    if (!Array.isArray(state.timestamps) || state.timestamps.length !== state.count) return unknown;
    let previous = -1;
    let expired = true;
    for (const timestamp of state.timestamps) {
      if (!nonnegativeFinite(timestamp) || timestamp < previous) return unknown;
      const expiry = timestamp + windowMs;
      if (!Number.isFinite(expiry)) return unknown;
      if (expiry > now) expired = false;
      previous = timestamp;
    }
    if (state.timestamps.length && state.resetAt !== state.timestamps[0] + windowMs) return unknown;
    // An empty sliding window has no quota to preserve, but keep a future resetAt conservatively.
    return { category: 'sliding', status: expired && state.resetAt <= now ? 'expired' : 'active' };
  }
  if (state.anchor !== undefined && state.anchor !== 'utc-day') return unknown;
  return { category: 'fixed', status: state.resetAt <= now ? 'expired' : 'active' };
}
