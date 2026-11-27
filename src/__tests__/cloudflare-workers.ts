// Node tests await catalog callers directly; workerd supplies the real request lifetime hook.
export function waitUntil(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class WorkerEntrypoint<Env = unknown> {
  protected readonly env: Env;
  constructor(_ctx: ExecutionContext, env: Env) {
    this.env = env;
  }
}
