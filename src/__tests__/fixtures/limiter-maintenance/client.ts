import { WorkerEntrypoint } from 'cloudflare:workers';
import type { LimiterMaintenance, MaintenanceSummary } from '../../../limiterMaintenanceService';
export default class extends WorkerEntrypoint<{ MAINTENANCE: Service<LimiterMaintenance> }> {
  async runBatch(ids: string[], options: { apply?: boolean } = {}): Promise<MaintenanceSummary> {
    return this.env.MAINTENANCE.runBatch(ids, options);
  }
}
