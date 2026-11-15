# Gateway rate limiting

How the `api-gateway` Worker limits token-authenticated clients. Client-facing quotas and headers:
[api.md](./api.md#rate-limits). App mutation limits, Pages/Nitro limits, account deletion and
Supabase Auth limits belong to TarkovTracker
([ownership map](https://github.com/tarkovtracker-org/TarkovTracker/blob/main/docs/rate-limiting.md)).

```mermaid
flowchart LR
  C[External client + API token] --> W[api-gateway Worker]
  W --> ABUSE[IP abuse gate<br/>Cloudflare Rate Limiting binding]
  ABUSE --> AUTH[Validate token hash]
  AUTH --> TIER[Resolve supporter tier]
  TIER --> DAILY[DO daily quota<br/>utc-day window]
  DAILY --> HANDLER[Progress / team handlers]
  HANDLER --> DB[(Supabase)]
  W --> USAGE[record_api_usage RPC<br/>api_usage_daily]
```

## Controls

- **Abuse gate.** `API_ABUSE_LIMITER` (`[[ratelimits]]` in `wrangler.toml`, 300 requests per
  60 seconds) keyed `api:<CF-Connecting-IP>`, before token lookup. Per-location and eventually
  consistent; it shields `api_tokens` and Supabase from floods. `period` must equal
  `ABUSE_GATE_PERIOD_SEC` in `src/limits.ts`.
- **Daily quota.** At most one `ApiGatewayRateLimiter` Durable Object call per request (none when
  the abuse gate or token checks reject it first), keyed
  `daily-read:<userId>` or `daily-write:<userId>`, UTC-day window, retained state. Limits are
  `TIER_LIMITS` in `src/limits.ts`. A unit is consumed when an authenticated request is admitted;
  downstream failures are not refunded. There is no burst bucket, IP backstop or refund
  reconciliation; reintroducing any of them is a regression.
- **Usage accounting.** `record_api_usage` writes `public.api_usage_daily` off the response path.
  It is observability, not a limiter.
- **Shared namespace.** TarkovTracker Pages binds the same DO class through
  `script_name = "api-gateway"` for its own ephemeral limiter keys. Its protocol is pinned by
  `src/__tests__/pages-limiter-contract.test.ts`.

## Fail behavior

| Control     | On failure                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Abuse gate  | Fails open; logs `abuse_gate_unavailable`.                                                                                 |
| Daily quota | Fails open (product entitlement, not a DB-integrity boundary); logs `daily_quota_unavailable`; no `X-RateLimit-*` headers. |

Neither failure is recorded as a throttle in `api_usage_daily`. Do not change a control's fail
mode without weighing its abuse impact.

## Observability

The Worker logs structured `daily_quota_429` (identifies `user_id`, `token_id`) and
`abuse_gate_429` (identifies `ip_hash`, a truncated HMAC-SHA-256 of the client IP keyed by
`IP_HASH_SECRET`; never the raw IP). In Workers Logs Query Builder, use **Last 24 hours**,
**Count**, sorted descending:

| Purpose                               | Filters                                                                   | Group by              |
| ------------------------------------- | ------------------------------------------------------------------------- | --------------------- |
| Daily quota denials by user           | `event` equals `daily_quota_429`                                          | `user_id`             |
| Daily quota denials by user and token | `event` equals `daily_quota_429`                                          | `user_id`, `token_id` |
| Abuse-gate denials by hashed IP       | `event` equals `abuse_gate_429`; `ip_hash` matches Regex `^[0-9a-f]{16}$` | `ip_hash`             |

Do not generate load by deliberately triggering denials. TarkovTracker's admin
`GET /api/admin/api-usage` reports top consumers from `api_usage_daily`. Logpush, WAF
verification and alerting are open work ([#17](https://github.com/tarkovtracker-org/TarkovTracker-API/issues/17)).

## Retention

| Store                   | Retention                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| DO ephemeral keys       | Self-clean with alarms at `resetAt + 1s` (Pages keys).                                                                                               |
| DO retained keys        | Expire by window logic.                                                                                                                              |
| Legacy burst/IP DO keys | Orphaned by the daily-quota refactor (no cleanup alarms); staged cleanup is [#16](https://github.com/tarkovtracker-org/TarkovTracker-API/issues/16). |
| `api_usage_daily`       | 180 days, nightly pg_cron job owned by TarkovTracker `supabase/`.                                                                                    |

## Expired-state maintenance (#16)

The binding-only `LimiterMaintenance.runBatch` service and
`ApiGatewayRateLimiter.maintainExpiredState` RPC support bounded dry-run and explicitly requested
cleanup. Neither is a public HTTP route. Deployment and production cleanup require separate
authorization; adding the tooling does not establish that any production state was reclaimed.
See [the operator procedure](./operations.md#expired-limiter-state-maintenance-16).

Object IDs are opaque: this process inventories **recognized expired state**, not exact legacy
burst/IP objects. It can reclaim expired daily or Pages state too, which the normal limiter already
treats as absent. Active quotas remain intact. Unknown, malformed, mixed-schema, extra KV or
unrecognized SQL schema objects are retained for separate investigation, without returning their
state or user/IP data. Only the single `state` KV entry and Cloudflare's `_cf_KV`/`_cf_METADATA`
catalog entries are accepted for complete storage deletion. The SQL check reads catalog names,
never internal KV or metadata contents.

Recognized fixed windows require a nonnegative integer count, finite nonnegative `resetAt`, positive
finite `windowSec` and only supported optional `anchor`/`ephemeral` fields. Equality at expiry is
eligible. Historical sliding state from Tracker
[`0855aa5`](https://github.com/tarkovtracker-org/TarkovTracker/blob/0855aa5fea170bb3f5fd417adfc254904309d15c/workers/api-gateway/src/index.ts)
also requires `mode: 'sliding'`, ordered finite timestamps, matching count/oldest reset and no anchor.
Every timestamp must have expired by its full window; an elapsed oldest `resetAt` alone is unsafe.
Current and historical shapes outside this strict whitelist remain untouched.

Each applying call reads and classifies current storage again while serialized with normal requests
and alarms. It invalidates the loaded cache, cancels the alarm and deletes storage only after those
checks. A stale dry-run never authorizes deletion of newly active state. Dry-run invokes/accesses
the object and may initialize its runtime, but does not explicitly write storage, consume quota,
change its cache or schedule/cancel alarms. Platform billing, invocation logs and already scheduled
alarms can still occur independently of maintenance.
