# Public API repository

Public HTTP behavior belongs in `src/`; shared pure progress rules belong in
`progress-contracts/src/`. Frontend, Nitro, database migrations, Edge Functions and precompute
remain in [TarkovTracker](https://github.com/tarkovtracker-org/TarkovTracker).

Keep one implementation of each pure rule. Package runtime exports must remain independent of
Nuxt, Vue, Workers, Supabase and Node APIs. Do not import another checkout or use cross-repository
symlinks. Consumer commands prepare changed compiled contracts; edit source, never `dist`.

Use the pinned Node/pnpm versions and committed lockfile. Install with
`pnpm install --frozen-lockfile`; validate with:

- `pnpm --filter @tarkovtracker/progress-contracts run test`
- `pnpm run typecheck`
- `pnpm run types:check`
- `pnpm run validate:openapi`
- `pnpm run test` (includes real workerd tests)
- `pnpm run build` (Wrangler dry-run)

Preserve Worker `api-gateway`, class `ApiGatewayRateLimiter`, migration `v1`, namespace/state and
the existing Pages binding/DO protocol. Authenticate and enforce quota before decoding input;
validation errors retain rate-limit headers. Public progress clients supply a 5–200 character
`User-Agent`.

Migration assertions and browser/Worker parity remain in the frontend repository. Rule/API
changes need corresponding integration evidence for PvP, PvE and Seasonal modes before release.
See `RELEASE.md` for the immutable package and frontend version-update path. Production cutover,
merge, integration/permission changes and deployment require their own authorization.
