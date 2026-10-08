# TarkovTracker API

Public API gateway and shared progress contracts for TarkovTracker.

The extraction starts from the independently reviewed
[TarkovTracker foundation at `99b19499`](https://github.com/tarkovtracker-org/TarkovTracker/tree/99b19499b48998eb177e4c8e7cbd6e31469baaff/workers/api-gateway).
The original project and contributors retain attribution; its GPL license is preserved verbatim.

Source, standalone tooling and a committed dependency lockfile are prepared in an extraction
pull request. Production continues using the existing TarkovTracker repository until a separately
approved integration cutover. Worker `api-gateway`, Durable Object class `ApiGatewayRateLimiter`,
migration `v1` and existing state must retain their identities.

Frontend, Nitro, Supabase migrations, Edge Functions and precompute remain in
[TarkovTracker](https://github.com/tarkovtracker-org/TarkovTracker).
