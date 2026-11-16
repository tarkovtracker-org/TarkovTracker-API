import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
export const MAINTENANCE_BATCH_LIMIT = 100;
export type MaintenanceSummary = { processed: number; counts: Record<string, number> };
// Named service binding only. No fetch handler and no public router registration.
// Account holders able to create service bindings already have Worker authority.
export class LimiterMaintenance extends WorkerEntrypoint<Env> {
  async runBatch(ids: string[], options: { apply?: boolean } = {}): Promise<MaintenanceSummary> {
    if (
      !Array.isArray(ids) || ids.length < 1 || ids.length > MAINTENANCE_BATCH_LIMIT ||
      ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(ids).size !== ids.length
    ) throw new TypeError('Invalid maintenance batch');
    if (
      !options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'apply') ||
      (options.apply !== undefined && typeof options.apply !== 'boolean')
    ) throw new TypeError('Invalid maintenance options');
    // Validate every ID against this namespace before calling any object.
    const namespace = this.env.API_GATEWAY_LIMITER;
    const objectIds = ids.map((id) => namespace.idFromString(id));
    const summary: MaintenanceSummary = { processed: 0, counts: {} };
    for (const id of objectIds) {
      try {
        const result = await namespace.get(id).maintainExpiredState({ apply: options.apply === true });
        const key = `${result.category}:${result.status}`;
        summary.counts[key] = (summary.counts[key] ?? 0) + 1;
      } catch {
        // A partial receipt is useful, but never expose exception text or object IDs.
        summary.counts.error = (summary.counts.error ?? 0) + 1;
        break;
      }
      summary.processed++;
    }
    return summary;
  }
}
