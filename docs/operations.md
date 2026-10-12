# Operations

Worker `api-gateway`, Durable Object class `ApiGatewayRateLimiter` (migration `v1`), and the
`API_ABUSE_LIMITER` rate-limit binding. Production changes, secret changes and deployments need
explicit authorization.

## Deployment source

The approved source cutover completed on 2026-10-12. Cloudflare Workers Builds connects the existing
`api-gateway` Worker to `tarkovtracker-org/TarkovTracker-API/main`, root `/`, with an empty build
command and deploy command `pnpm run deploy`. That command prepares workspace contracts before
Wrangler bundles the Worker. A plain `npx wrangler deploy` omits that preparation. The Tracker
build trigger is disconnected; only this repository deploys the Worker. Build caching remains
enabled, preview builds remain disabled, and the existing build-token identifier is reused.

Watch paths are `src/**`, `progress-contracts/**`, `scripts/prepare-contracts.mjs`, `package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `worker-configuration.d.ts`,
`wrangler.toml`, `.nvmrc` and `.npmrc`, with no exclusions. Keep these aligned with deployment
inputs without restoring a second source trigger. GitHub Actions validates; it does not deploy.

Cutover candidate `655b825ddfc863a2bc56f88eea97a5bbb15744ce` (source-only tag `v0.1.2`) built as
`4ffaa165-f64f-4eb0-b21f-b2821e30f97a` and became active version
`2043aeb0-6daa-47f2-af25-26a267ddbceb` at 100%. The contracts archive remains `v0.1.0`.
Worker/class/migration identity, DO namespace `832c68d546974f9884747962b5efe97d`, abuse namespace
`1001`, route `api.tarkovtracker.org/*`, secrets and the Pages cross-script binding were preserved.
Tracker [cleanup PR #1183](https://github.com/tarkovtracker-org/TarkovTracker/pull/1183) removes the
duplicate gateway; consumer parity and Supabase assertions remain there. That cleanup is pending
until its PR merges.

## Configuration

| Name                        | Kind                        | Purpose                                                       |
| --------------------------- | --------------------------- | ------------------------------------------------------------- |
| `SUPABASE_URL`              | secret                      | Supabase project URL                                          |
| `SUPABASE_SERVICE_ROLE_KEY` | secret                      | Service-role access to the objects in `supabase-surface.json` |
| `IP_HASH_SECRET`            | secret                      | HMAC key for `ip_hash` in abuse-gate logs                     |
| `ALLOWED_ORIGIN`            | `[vars]` in `wrangler.toml` | CORS allow-list                                               |
| `API_HOST`                  | `[vars]` in `wrangler.toml` | Host treated as the API host                                  |

Secrets live only in the Worker's secret store; `.env.example` lists names for local typing.
Never commit values.

## Before merging a deploying change

- **Secrets.** If the change relies on a secret (for example `IP_HASH_SECRET` for non-null
  `ip_hash`), confirm it is provisioned first:

  ```bash
  pnpm exec wrangler secret list --config wrangler.toml
  ```

- **Schema order.** Migrations, Edge Functions and Workers deploy independently, in no guaranteed
  order. A Supabase object the Worker starts using must already be live: land it in TarkovTracker
  in an earlier release, then update `supabase-surface.json` and TarkovTracker's
  `api_gateway_surface.test.sql` together.
- **Routes.** `scripts/deployment-routes.test.ts` requires the single `api.tarkovtracker.org/*`
  binding. A deploy applies `wrangler.toml` routes, so never restore the retired apex/www bindings.

## After deploying

1. Confirm the Workers Builds run succeeded for the expected commit
   (`pnpm exec wrangler deployments list --config wrangler.toml`). `/health` reports a fixed
   version and does not identify the build.
2. Smoke test `https://api.tarkovtracker.org/health` (200), an authenticated `GET /progress`
   with a test token, and a normal `https://tarkovtracker.org` page (Pages shares the DO).
3. Watch Workers Logs for `daily_quota_unavailable`, `abuse_gate_unavailable` and 5xx spikes.

## Rollback

Before an approved rollback, disable/disconnect the API build trigger and cancel unfinished builds
so another build cannot overwrite recovery. Restore an explicitly verified retained Worker version
at 100%, preserving the existing Worker, secrets, DO namespace/state and database. For this cutover,
the retained pre-migration version is `e470b448-d198-4138-9da4-054fb937e0ed`, built from Tracker
commit `92fc39f79f724f4cff93b076d8b4debe57c70108`. Use `pnpm exec wrangler rollback <VERSION_ID> --config wrangler.toml`
from the API checkout, then verify the active deployment and read-only production behavior.
Do not delete/recreate the Worker or DO, reset state, or create/copy secrets.

Fix/revert the offending API repository change through review, validate it, and re-enable only one
source trigger after recovery is verified. Do not synchronize a deleted Tracker gateway or point
legacy build settings at post-cleanup Tracker `main`. If a source-connection rollback is necessary,
the old settings and retained Tracker commit containing `workers/api-gateway` are available for
an explicitly approved temporary rollback ref/build; target that retained commit rather than the
moving branch. Consumer contracts/pins and DB/Pages ownership remain independent of Worker rollback.

## Incident triage

1. Workers Builds and Worker logs: failed build, missing secret, exceptions.
2. Supabase health: PostgREST errors for the objects in `supabase-surface.json`.
3. Limiter health: rising `*_unavailable` events mean requests are being served fail-open.
4. Abuse: group `abuse_gate_429` by `ip_hash` ([rate-limiting.md](./rate-limiting.md#observability)).
