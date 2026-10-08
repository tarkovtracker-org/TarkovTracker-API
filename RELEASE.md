# Progress-contracts release plan

Distribution is a compiled ESM/type tarball attached to an immutable GitHub Release in
`tarkovtracker-org/TarkovTracker-API`. The package has no runtime dependencies and remains private
to prevent accidental registry publication. No registry or cross-repository symlink is needed.

The extraction branch is a review candidate. It publishes no release assets and changes no
production integration. Before a first release:

1. Independently review an exact extraction commit, its committed lockfile and its CI evidence.
   Preserve the Worker/class/migration/state identity and Pages binding/DO protocol.
2. Run the frozen-lock install, contracts/gateway tests, boundary/type/schema checks and dry-run
   build at that commit. Record frontend/Worker parity for PvP, PvE and Seasonal modes against
   the corresponding reviewed TarkovTracker commit. Keep SQL assertions with Supabase.
3. Fix the package version before freezing the release commit. The first candidate is `0.1.0`;
   each subsequent release changes it. Pack twice with the pinned tools, compare SHA-512, and
   retain the exact tarball, digest, source provenance and validation receipt.
4. Only after that immutable version is reviewed, create its release/tag and attach the verified
   tarball and checksum. Never publish from an evolving draft or replace a released archive.
5. Prepare a separate frontend dependency-update PR using the exact versioned release URL,
   for example `https://github.com/tarkovtracker-org/TarkovTracker-API/releases/download/v0.1.0/tarkovtracker-progress-contracts-0.1.0.tgz`.
   Commit pnpm's resolved integrity and lockfile; rerun consumer and all-mode parity checks.

The frontend continues using its pinned version until its dependency PR is validated and merged.
The production Worker stays on the existing deployment source until a separately approved
cutover. That cutover must also retain integration tests against the actual versioned gateway;
frontend parity must not silently keep testing a retired Worker copy.

CI may retain a candidate tarball and checksum as build evidence. A CI artifact is not a
published GitHub Release. Production cutover, integration/access changes and deployment remain
separate decisions.
