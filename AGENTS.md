# Public API repository

Public HTTP behavior belongs in `src/`; shared pure progress rules belong in
`progress-contracts/src/`. Frontend, Nitro, database migrations, Edge Functions and precompute
remain in [TarkovTracker](https://github.com/tarkovtracker-org/TarkovTracker).

Keep one implementation of each pure rule. Package runtime exports must remain independent of
Nuxt, Vue, Workers, Supabase and Node APIs. Do not import another checkout or use cross-repository
symlinks. Consumer commands prepare changed compiled contracts; edit source, never `dist`.

Use the pinned Node/pnpm versions and committed lockfile. Install with
`pnpm install --frozen-lockfile`; validate with:

- `pnpm run lint:blank-lines` (no removable blank lines; `--fix` rewrites)
- `pnpm --filter @tarkovtracker/progress-contracts run test`
- `pnpm run typecheck`
- `pnpm run types:check`
- `pnpm run validate:openapi`
- `pnpm run test` (includes real workerd tests)
- `pnpm run build` (Wrangler dry-run)

Preserve Worker `api-gateway`, class `ApiGatewayRateLimiter`, migration `v1`, namespace/state and
the existing Pages binding/DO protocol. Authenticate and enforce quota before decoding input;
validation errors retain rate-limit headers. Public progress clients supply a 5–200 character
`User-Agent`. A request makes at most one Durable Object call (the daily quota); both limiters
fail open. Read responses stay `private` with payload-derived ETags. When a change alters
documented behavior, update the owning doc in `docs/` (`api.md` client contract,
`progress-api.md` flow/invariants, `rate-limiting.md`, `operations.md`) in the same change.

`supabase-surface.json` lists every Supabase relation, column, RPC and Auth endpoint `src/` uses;
`scripts/supabase-surface.test.ts` keeps it exact. A change to it needs the matching
TarkovTracker schema assertion, and any new object must ship there first.
Migration assertions and browser/Worker parity remain in the frontend repository. Rule/API
changes need corresponding integration evidence for PvP, PvE and Seasonal modes before release.
See `RELEASE.md` for the immutable package and frontend version-update path. Production cutover,
merge, integration/permission changes and deployment require their own authorization.

`.github/main-ruleset.json` is the reviewed `main` ruleset (PR required, squash only, strict `api`,
`security`, `workflow-lint` and `CodeQL` checks, no bypass). Changing it in a PR does not apply
it; an authorized maintainer
applies it with `gh api -X POST repos/tarkovtracker-org/TarkovTracker-API/rulesets --input
.github/main-ruleset.json` (or `PUT .../rulesets/<id>` to update). Never weaken it to land a change.
