export type MaintenanceOptions = {
  account: string;
  namespace: string;
  version: string;
  limit: number;
  cursor?: string;
  apply: boolean;
};
export type MaintenanceReceipt = {
  mode: 'apply' | 'dry-run';
  listed: number;
  candidates: number;
  processed: number;
  counts: Record<string, number>;
  nextCursor: string | null;
  cleanupFailed?: boolean;
};
export function parseOptions(args: string[]): MaintenanceOptions;
export function proxyConfig(account: string): {
  name: string;
  account_id: string;
  compatibility_date: string;
  workers_dev: boolean;
  preview_urls: boolean;
  services: { binding: string; service: string; entrypoint: string; remote: boolean }[];
};
export function verifyIdentity(options: MaintenanceOptions, request: (path: string) => Promise<unknown>): Promise<void>;
export function createReadbackRequest(token: string, requestFetch?: typeof fetch): (path: string) => Promise<unknown>;
export function reportFailure(error: unknown): void;
export function runMaintenance(options: MaintenanceOptions, dependencies: {
  request: (path: string) => Promise<unknown>;
  connect: (config: ReturnType<typeof proxyConfig>) => Promise<{
    service: { runBatch(ids: string[], options: { apply: boolean }): Promise<{ processed: number; counts: Record<string, number> }> };
    dispose(): Promise<void>;
  }>;
}): Promise<MaintenanceReceipt>;
