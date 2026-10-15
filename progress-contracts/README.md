# Progress contracts

`@tarkovtracker/progress-contracts@0.2.0` owns the existing pure rules used by the browser,
Nitro and the public API: task update caps, transitions, requirements, failure edges,
invalidation, materialized mode progress, season-number validation and display-name projection.
There are no runtime dependencies. Callers supply progress and catalog data; this package does
not fetch, persist, authenticate, select an active season or know about Nuxt/Workers/Supabase.

Use the explicit exported subpath for a rule, for example
`@tarkovtracker/progress-contracts/progressInvalidation`. Change a rule here once and run its
Node tests plus browser/Worker parity in the corresponding
[TarkovTracker](https://github.com/tarkovtracker-org/TarkovTracker) checkout. SQL implementations
remain owned there by `supabase/`; a package change does not authorize changing an applied migration.

From this directory: `pnpm install`, `pnpm run build`, `pnpm run test`, `pnpm pack`.
Gateway development commands watch this compiler alongside its server. Consumer
build/typecheck commands and Vitest prepare changed contracts automatically; there is no manual
reinstall step after editing a rule. Unchanged inputs/outputs reuse a local unpublished cache.
The tarball contains compiled ESM, declarations, original sources/tests, the common fixture and
the repository's unchanged license. The local license makes isolated and workspace packs agree.
The version describes these shared contracts; it does not change the HTTP API version.

This API workspace uses `workspace:*`. Frontend distribution uses an immutable versioned GitHub Release tarball from
`tarkovtracker-org/TarkovTracker-API`, pinned by URL and lockfile integrity in the frontend.
No registry publication or cross-repository symlink is needed. Each release must bump the
package version, run package/gateway/parity checks, and supply a frontend dependency-update PR;
the frontend continues using its pinned version until that PR is validated and merged.

This repository commits the exact validated workspace lockfile. Install with
`pnpm install --frozen-lockfile`. See [the release plan](../RELEASE.md) for review, source provenance
and the pinned frontend dependency update; this extraction draft publishes no release assets.

The 0.2.0 candidate adds explicit `active` state and requested-task-only writes. `setTaskState`
exports the canonical writer; `toTransitionTaskState` gives failed/completed flags precedence over
active. The existing `applyTaskTransition` signature and types remain available, but the catalog
and protected-ID arguments no longer cause dependent writes. This behavior change is intentional.
No release is published by preparing this candidate; all-mode consumer parity and independent
review are required before freezing its release commit.
