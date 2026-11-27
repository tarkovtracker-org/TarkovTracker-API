import gateway from '../../../index';
import { ApiGatewayRateLimiter as Limiter } from '../../../rateLimiter';
export { LimiterMaintenance } from '../../../limiterMaintenanceService';
// Test-only storage access. This subclass is never exported by src/index.ts.
export class ApiGatewayRateLimiter extends Limiter {
  async seed(value: unknown, extra: 'kv' | 'sql' | null = null): Promise<void> {
    if (value !== undefined) await this.ctx.storage.put('state', value);
    if (extra === 'kv') await this.ctx.storage.put('unrecognized', 'keep');
    if (extra === 'sql') this.ctx.storage.sql.exec('CREATE TABLE unrecognized(value TEXT)');
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }
  async snapshot() {
    return JSON.stringify({
      state: await this.ctx.storage.get('state'),
      keys: [...(await this.ctx.storage.list({ limit: 3 })).keys()],
      alarm: await this.ctx.storage.getAlarm(),
      tables: this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray(),
    });
  }
}
export default gateway;
