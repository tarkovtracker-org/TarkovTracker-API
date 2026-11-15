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

The retained pre-cutover source settings were Tracker repository `1098874862` under
`tarkovtracker-org`, root `workers/api-gateway`, empty build command, deploy command
`npx wrangler deploy`, build caching enabled, previews disabled, no path exclusions or build
environment variables, and the existing build-token identifier. Its watch paths were
`workers/api-gateway/**`, `shared/**`, `app/utils/**`, `app/features/resources/resourceData.ts`,
`app/locales/en.json`, `package.json`, `tsconfig.json`, `nuxt.config.ts`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `patches/**` and `.nvmrc`. The old connection watched `main`; after cleanup,
an approved source rollback must use a temporary ref retaining commit `92fc39f79f724f4cff93b076d8b4debe57c70108`
instead. Reuse an existing authorized build token without exposing its value or expanding grants.

## Incident triage

1. Workers Builds and Worker logs: failed build, missing secret, exceptions.
2. Supabase health: PostgREST errors for the objects in `supabase-surface.json`.
3. Limiter health: rising `*_unavailable` events mean requests are being served fail-open.
4. Abuse: group `abuse_gate_429` by `ip_hash` ([rate-limiting.md](./rate-limiting.md#observability)).

## Expired limiter state maintenance (#16)

This procedure is prepared tooling, not a production cleanup receipt. Obtain separate approval for
deployment, then separate approval for destructive cleanup with the reviewed account, namespace,
deployed version and bounded batch. Do not delete/recreate the shared class or namespace. Preserve
Worker `api-gateway`, class `ApiGatewayRateLimiter`, migration `v1` and namespace
`832c68d546974f9884747962b5efe97d`; Pages keeps its existing cross-script binding. No Pages deploy or
migration is needed: the normal DO fetch protocol and alarm behavior remain compatible.

1. Deploy the reviewed API change through the existing approved workflow first. Verify the active
   immutable version at 100%, `v1`, API/Pages bindings, normal authenticated read/write quota headers
   and a normal Pages limiter flow. Use designated test credentials and ordinary traffic; do not
   deliberately exhaust quotas. Keep deployment/build changes frozen during each maintenance batch.
2. Use pinned Node/pnpm and `pnpm install --frozen-lockfile`. Provision an account-scoped
   `CLOUDFLARE_API_TOKEN` through the approved secret mechanism, never command arguments or chat.
   It must permit account details, Workers/DO metadata reads and the remote service-binding session
   for this account. Remote sessions need Workers script authority; read-only DO-list permissions
   alone do not grant invocation. Review the current
   [Workers role guidance](https://developers.cloudflare.com/workers/authorization/workers/).
   If set, `CLOUDFLARE_ACCOUNT_ID` must equal the explicit expected account.
3. Record the verified account ID and immutable deployed version in the approved operator record.
   From this checkout, run one bounded dry-run (PowerShell; values are identifiers, not secrets):

   ```powershell
   $expectedAccount = '<verified-32-character-account-id>'
   $expectedVersion = '<approved-deployed-version-uuid>'
   node scripts/limiter-maintenance.mjs --account $expectedAccount --namespace 832c68d546974f9884747962b5efe97d --version $expectedVersion --limit 100
   ```

   The runner reads account identity, namespace script/class/SQLite identity, the deployed Worker
   binding and the sole active version before invoking anything. It checks at most the first 100
   namespaces and fails closed if the expected one is absent. It requests one object page (10–100 IDs,
   matching the API's minimum page size),
   never automatically follows cursors, and skips inventory entries without stored data. It uses
   Wrangler `getPlatformProxy` with `persist: false`, explicit `remoteBindings: true`, no dotenv
   inputs and a temporary remote **service** binding to the named `LimiterMaintenance` entrypoint.
   No operator Worker is deployed or public maintenance route added. Direct remote DO proxies are
   unsupported by pinned Wrangler; do not substitute one or invoke normal limiter fetch as a probe.
4. Review the aggregate receipt: `mode`, `listed`, `candidates`, `processed`, bounded
   `category:status` counts and `nextCursor`. It contains no object IDs, state, users or IPs. `eligible`
   is a point-in-time classification, not a deletion approval or legacy-object count. After cleanup
   approval, apply to the same page start (omit `--cursor` for the first page):

   ```powershell
   node scripts/limiter-maintenance.mjs --account $expectedAccount --namespace 832c68d546974f9884747962b5efe97d --version $expectedVersion --limit 100 --apply
   ```

   Apply repeats deployment/binding identity checks after listing; every object independently
   reclassifies its current state under serialization with consumption and alarms. Active quotas,
   unknown shapes and extra KV/SQL schema remain untouched. For a later separately reviewed bounded
   page, add `--cursor '<previous-nextCursor>'` to both dry-run and apply. Never build an unlimited
   pagination loop. Listing and storage reclamation are eventually observable; a cursor or a
   `hasStoredData` flag is not proof of orphan status or a namespace total.
5. A reported object error stops the batch immediately and returns a partial aggregate receipt with
   nonzero exit status. Connection/readback/receipt errors also stop; no further objects are called.
   Transport failures can leave the last operation's outcome unknown and may produce no receipt.
   Retain the command error/output and any receipt, then rerun a bounded dry-run from the same
   **input** cursor before deciding on another apply. Do not
   advance to `nextCursor` after an error or retry destructive batches blindly. Identity readbacks
   are not atomic with RPC calls; the deployment freeze is part of the operational boundary.
   If proxy shutdown fails after a validated result, the receipt is still printed with
   `cleanupFailed: true` and a nonzero exit status; retain its deletion counts.
6. After each batch, verify the deployed version and shared bindings again, ordinary API read/write
   and Pages limiter continuity, and absence of new `daily_quota_unavailable`/5xx spikes. Record
   before/after category totals, partial errors, page cursors, unknown/extra-state counts and the
   scope still unexamined in #16. Close only with operational evidence or an explicit evidence-backed
   disposition. This procedure cannot reconstruct exact legacy key names from opaque IDs.

Stop further batches to roll back maintenance. A Worker code rollback removes the new RPC/service
but **does not restore deleted DO storage**. `deleteAll()` deallocates the object's database; do not
promise PITR after deletion. Any recovery needs separate approval and verified platform recovery
capabilities and can overwrite quotas consumed since the restore point. The safety boundary is
proof of expiry before deletion, not a reversible quota reset. No namespace migration or mass
deletion is part of this procedure.

Platform references: [storage deletion/PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[service RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
[Wrangler proxy API](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy),
[supported remote bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/).
Cloudflare's [workerd metadata source](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite-metadata.h)
identifies `_cf_METADATA` as platform alarm metadata, not application state.

## Task identity rollout (#1302)

`TASK_ID_ALIASES_ENABLED` defaults to `false` so this Worker can deploy before the new RPC.
Ship Tracker's `get_progress_task_id_aliases()` service-role-only RPC and progress-table triggers,
then the reviewed `0.1.3` contracts release and Tracker consumers, before enabling this flag.
Keep aliases empty until all deployed consumers handle canonical IDs. Publish an activated overlay
manifest and matching catalog definitions with a matching forward SQL manifest migration; wait out
metadata caches and verify all three modes before retiring placeholder definitions. Keep every
activated alias permanently. Do not roll back to a consumer that cannot read canonical IDs after
cutover; disable new writes and restore a compatible consumer instead. No bulk rewrite is part of
this rollout. See TarkovTracker #1302 and overlay #530 for the coordinated release checklist.
