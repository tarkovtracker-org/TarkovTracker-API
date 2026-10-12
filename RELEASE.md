# Progress-contracts release plan

Distribution is a compiled ESM/type tarball attached to an immutable GitHub Release in
`tarkovtracker-org/TarkovTracker-API`. The package has no runtime dependencies and remains private
to prevent accidental registry publication. No registry or cross-repository symlink is needed.

The first compiled contracts release is `v0.1.0`. Source-only deployment tags `v0.1.1` and `v0.1.2`
do not publish replacement contracts archives. For a new contracts release:

1. Independently review an exact extraction commit, its committed lockfile and its CI evidence.
   Preserve the Worker/class/migration/state identity and Pages binding/DO protocol.
2. Run the frozen-lock install, contracts/gateway tests, boundary/type/schema checks and dry-run
   build at that commit. Record frontend/Worker parity for PvP, PvE and Seasonal modes against
   the corresponding reviewed TarkovTracker commit. Keep SQL assertions with Supabase.
3. Fix a new package version before freezing the release commit. The next patch candidate is
   `0.1.3` if its matching tag is still unused; verify the tag first and choose the appropriate
   higher version for the actual change. Never reuse released `0.1.0` or repurpose source-only
   tags `v0.1.1` / `v0.1.2`. Pack twice with the pinned tools, compare SHA-512, and
   retain the exact tarball, digest, source provenance and validation receipt.
4. Only after that immutable version is reviewed, create its release/tag and attach the verified
   tarball and checksum. Never publish from an evolving draft or replace a released archive.
5. Prepare a separate frontend dependency-update PR using the exact versioned release URL,
   for example `https://github.com/tarkovtracker-org/TarkovTracker-API/releases/download/v0.1.0/tarkovtracker-progress-contracts-0.1.0.tgz`.
   Commit pnpm's resolved integrity and lockfile; rerun consumer and all-mode parity checks.

The frontend continues using its pinned version until its dependency PR is validated and merged.
The approved production source cutover completed on 2026-10-12. The existing `api-gateway` Worker
builds from this repository's `main` with `pnpm run deploy`; the old Tracker trigger is disconnected.
Tracker retains integration tests against an explicit source-only tag/commit, currently `v0.1.2` /
`655b825ddfc863a2bc56f88eea97a5bbb15744ce`. Compiled contracts still match its immutable `v0.1.0`
archive. Keep the consumer source pin reviewed and explicit when API changes advance production;
never silently test a retired copy or implicitly follow the moving branch.

CI may retain a candidate tarball and checksum as build evidence. A CI artifact is not a
published GitHub Release. Future integration/access changes and production deployments remain
separately authorized decisions; see [operations](docs/operations.md) for the completed cutover
and retained-version rollback procedure.
