# TarkovTracker API

Public API gateway and shared progress contracts for TarkovTracker.

The extraction starts from the independently reviewed
[TarkovTracker foundation at `99b19499`](https://github.com/tarkovtracker-org/TarkovTracker/tree/99b19499b48998eb177e4c8e7cbd6e31469baaff/workers/api-gateway).
The original project and contributors retain attribution; its GPL license is preserved verbatim.

This repository owns the production gateway at its root and the runtime-independent
`progress-contracts/` package. The approved source cutover completed on 2026-10-12: the existing
Worker `api-gateway` now builds from this repository's `main`, root `/`, with `pnpm run deploy`.
The Tracker build trigger was disconnected. Durable Object class `ApiGatewayRateLimiter`,
migration `v1`, namespace and existing state retain their identities. Duplicate-source removal
in Tracker is tracked by [cleanup PR #1183](https://github.com/tarkovtracker-org/TarkovTracker/pull/1183);
it is not complete until that PR merges.

Frontend, Nitro, Supabase migrations, Edge Functions and precompute remain in
[TarkovTracker](https://github.com/tarkovtracker-org/TarkovTracker).

| Change                                                   | Location                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Public token API, HTTP routes, quota and OpenAPI         | `src/`                                                                      |
| Pure progress rules shared with the frontend             | `progress-contracts/src/`                                                   |
| Gateway import checks and local contract preparation     | `scripts/`                                                                  |
| API toolchain and dependency resolution                  | `package.json`, `.nvmrc`, `pnpm-workspace.yaml`, committed `pnpm-lock.yaml` |
| Frontend, Nitro, database, Edge Functions and precompute | Existing TarkovTracker repository                                           |

Docs: [public API reference](docs/api.md), [data flow and invariants](docs/progress-api.md),
[rate limiting](docs/rate-limiting.md), [operations](docs/operations.md).

Use Node `24.21.0` and the complete pnpm `11.14.0` pin in `package.json`.
Run `pnpm install --frozen-lockfile`, then:

```sh
pnpm run lint:blank-lines
pnpm --filter @tarkovtracker/progress-contracts run test
pnpm run typecheck
pnpm run types:check
pnpm run validate:openapi
pnpm run test
pnpm run build
```

`build` is a Wrangler dry-run. `pnpm run dev` and `pnpm run test:watch` start the contracts
compiler watcher with the gateway or tests. Consumer commands prepare edited rules automatically;
unchanged inputs reuse the local cache. Edit source, never generated `dist`.

The committed lockfile records this repository's validated tools. Generic dependency override
values are carried from the reviewed foundation; frontend-specific overrides/configuration and
the Nuxt patch are omitted. Native build permission is limited to the existing API tools,
`esbuild` and `workerd`. No frontend dependency or source checkout is required.

Database schema assertions and browser/Worker parity across PvP, PvE and Seasonal modes remain
with their owners in TarkovTracker. This extraction preserves the reviewed implementations;
future rule/API changes need corresponding cross-repository integration evidence.

See [RELEASE.md](RELEASE.md) for version-pinned GitHub Release packages and the staged frontend
dependency update. GitHub Actions performs validation; Cloudflare Workers Builds owns production
deployment through the existing connection/token, with no new credentials.

Legacy address retirement is coordinated with
[the frontend promotion runbook](https://github.com/tarkovtracker-org/TarkovTracker/blob/main/docs/api-ownership.md#legacy-address-retirement).
The apex/www legacy bindings are retired: Wrangler binds only `api.tarkovtracker.org/*`, and
Pages owns the static 410 JSON migration response on the apex; www keeps its canonical 308 to
the apex, which then returns the 410. API `/health` remains 200 through the
catch-all. This repository's `wrangler.toml` owns the Worker routes; Tracker retains Pages routing
and the cross-script DO binding. Future production deployments and integration changes still
require their applicable authorization. See [operations](docs/operations.md) for source and rollback.
