# Operations

Worker `api-gateway`, Durable Object class `ApiGatewayRateLimiter` (migration `v1`), and the
`API_ABUSE_LIMITER` rate-limit binding. Production changes, secret changes and deployments need
explicit authorization.

## Deployment source

**Until the approved cutover, production still deploys from TarkovTracker.** Cloudflare Workers
Builds runs `npx wrangler deploy` in `TarkovTracker/workers/api-gateway` on watched `main`
pushes (that repository's
[runbook](https://github.com/tarkovtracker-org/TarkovTracker/blob/main/docs/runbook.md#deployment)
lists the watch paths). This repository has no deployment workflow; its `main` must stay
bundle-identical to that legacy source until cutover.

At cutover the Workers Builds connection moves here, with root `/` and build command
`node scripts/prepare-contracts.mjs` (or deploy command `pnpm run deploy`). A plain
`npx wrangler deploy` without it cannot resolve `@tarkovtracker/progress-contracts/*`, because the
workspace package's `dist/` is generated. Disconnect the TarkovTracker trigger at the same time so
two sources never deploy the same Worker.

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

`pnpm exec wrangler rollback --config wrangler.toml` restores the previous Worker version
(`wrangler deployments list` shows candidates). Rollback does not touch DO state or the database.
Then revert the offending commit on the repository that is the current deployment source (the
legacy TarkovTracker copy until cutover, this repository after), and keep the other source in
step, so the next build does not redeploy it.

## Incident triage

1. Workers Builds and Worker logs: failed build, missing secret, exceptions.
2. Supabase health: PostgREST errors for the objects in `supabase-surface.json`.
3. Limiter health: rising `*_unavailable` events mean requests are being served fail-open.
4. Abuse: group `abuse_gate_429` by `ip_hash` ([rate-limiting.md](./rate-limiting.md#observability)).
