# TarkovTracker API

Public API gateway and shared progress contracts for TarkovTracker.

The extraction starts from the independently reviewed
[TarkovTracker foundation at `99b19499`](https://github.com/tarkovtracker-org/TarkovTracker/tree/99b19499b48998eb177e4c8e7cbd6e31469baaff/workers/api-gateway).
The original project and contributors retain attribution; its GPL license is preserved verbatim.

This extraction draft contains the gateway at the repository root and the runtime-independent
`progress-contracts/` package. Production continues using the existing TarkovTracker repository until a separately
approved integration cutover. Worker `api-gateway`, Durable Object class `ApiGatewayRateLimiter`,
migration `v1` and existing state must retain their identities.

Frontend, Nitro, Supabase migrations, Edge Functions and precompute remain in
[TarkovTracker](https://github.com/tarkovtracker-org/TarkovTracker).

| Change                                                   | Location                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Public token API, HTTP routes, quota and OpenAPI         | `src/`                                                                      |
| Pure progress rules shared with the frontend             | `progress-contracts/src/`                                                   |
| Gateway import checks and local contract preparation     | `scripts/`                                                                  |
| API toolchain and dependency resolution                  | `package.json`, `.nvmrc`, `pnpm-workspace.yaml`, committed `pnpm-lock.yaml` |
| Frontend, Nitro, database, Edge Functions and precompute | Existing TarkovTracker repository                                           |

Use Node `24.21.0` and the complete pnpm `11.14.0` pin in `package.json`.
Run `pnpm install --frozen-lockfile`, then:

```sh
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
dependency update. This draft has no production deployment workflow or new credentials.
