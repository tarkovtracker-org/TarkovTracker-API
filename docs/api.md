# Public API reference

Client-facing behavior of the `api-gateway` Worker. The machine-readable contract is the
OpenAPI document served at <https://api.tarkovtracker.org/openapi.json> (source: `src/openapi.ts`);
this page covers behavior the schema cannot express. Data flow and invariants live in
[progress-api.md](./progress-api.md); quota internals in [rate-limiting.md](./rate-limiting.md).

## Host

The API is served only on `https://api.tarkovtracker.org`, with clean paths (`/progress`); the
prefixes `/api/v2`, `/api` and `/v2` are accepted as aliases on that host (`API_HOST_PREFIXES` in
`src/router.ts`). `wrangler.toml` binds only `api.tarkovtracker.org/*`. On any other host the
Worker answers only `/health`; everything else returns 404. Loopback hosts are treated as the API
host for local development.

The legacy apex/www addresses (`tarkovtracker.org/api/v2`, `/api/token`, `/api/progress`,
`/api/team/progress` and their descendants) are retired. TarkovTracker Pages answers them with a
static `410 legacy_api_retired` JSON body pointing at this host; www first 308-redirects to the
apex. That response and its record are owned by the frontend repository
([retirement record](https://github.com/tarkovtracker-org/TarkovTracker/blob/main/docs/api-ownership.md#legacy-address-retirement)).

```diff
-POST https://tarkovtracker.org/api/v2/progress/task/{taskId}
+POST https://api.tarkovtracker.org/progress/task/{taskId}
```

## Endpoints

| Method | Path                                     | Permission |
| ------ | ---------------------------------------- | ---------- |
| GET    | `/health`, `/openapi.json`, `/docs`      | none       |
| GET    | `/token`                                 | `GP`       |
| GET    | `/progress`                              | `GP`       |
| GET    | `/team/progress`                         | `TP`       |
| POST   | `/progress/level/{level}`                | `WP`       |
| POST   | `/progress/task/{taskId}`                | `WP`       |
| POST   | `/progress/task/objective/{objectiveId}` | `WP`       |
| POST   | `/progress/tasks`                        | `WP`       |

Protected endpoints require a 5–200 character `User-Agent` (checked first, `400` otherwise) and
`Authorization: Bearer <token>`. `/health`, `/`, `/docs`, `/openapi.json`, `robots.txt` and
`OPTIONS` preflights are answered before either check. `/health` reports a fixed version, so it
does not identify a deployed build.

## Tokens

Tokens are created and revoked in TarkovTracker (Settings → API Tokens) through its `token-create`
Edge Function; this Worker only validates them. Facts clients rely on:

- Prefix `PVP_`, `PVE_` or `SZN_` declares the token's mode. The stored `game_mode` selects the
  exact `(user_id, game_mode, season_number)` progress row every read and write touches, never
  the mode the owner is viewing on the site. PvP/PvE use season `0`; Seasonal uses the active season.
- A token whose prefix disagrees with its stored mode returns `401 Token game mode mismatch`.
  Legacy `tt_` tokens return `401 Invalid token format`.
- Permissions are a non-empty subset of `GP` (read own progress), `TP` (read team progress) and
  `WP` (write progress).
- At most 3 active tokens per account (database trigger); creation is limited to 3 per hour.
  Renaming changes only the token's `note`.

## Rate limits

Daily quotas are per account (not per token), reset at 00:00 UTC, and count authenticated
requests admitted for processing:

| Tier      | Reads/day | Writes/day |
| --------- | --------: | ---------: |
| Free      |     1,000 |        100 |
| Supporter |     2,000 |        250 |
| Scav      |     2,000 |        250 |
| Timmy     |     3,000 |        400 |
| Chad      |     5,000 |        600 |

The tier comes from the account's supporter entitlement (cached up to 60 seconds). Active
subscriptions, and past-due subscriptions within their recorded grace period, keep paid limits;
expired ones return to Free.

A pre-authentication, IP-keyed abuse gate shields token validation from floods. It is
infrastructure protection, not a customer quota, and is not advertised as a per-IP entitlement.

Authentication and the quota check run before input validation, so a malformed request from an
unauthenticated or over-quota client returns `401`/`429`, not `400`. Responses with a quota
decision carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix
seconds); authorized validation `400`s carry them too. A denial returns `429` with `Retry-After`
(free-tier bodies include an upgrade link). Abuse-gate `429`s carry only `Retry-After`. When the
quota service is unavailable the request is served without `X-RateLimit-*` headers (fail open).

## Progress write validation

Task, objective and batch JSON bodies are limited to 262144 bytes (256 KiB), counted from the
request stream before JSON decoding, independently of `Content-Length`. Larger bodies return
`413`. Authentication, permissions and daily quota checks still run first; admitted validation
errors retain CORS and quota headers and consume one daily write.

Batch writes accept either the legacy ID-to-state object or an array of `{id, state}` updates.
Each batch must contain 1–1000 entries; duplicate array IDs count toward the limit and retain
their existing ordered transition behavior. Task and objective IDs must be nonblank and at most
64 characters. URL IDs keep their existing decoding and trimming behavior; batch IDs are exact.
Every supplied ID must exist in the token mode's current task/objective catalog, even if a
previously stored progress map contains it. Invalid batches are rejected in full with `400`
before transitions or persistence. Unavailable catalogs return `503`, including objective writes.
Clients sending more than 1000 updates must split their requests; dependency cascades retain
their existing behavior within each request.

## Conditional requests and polling

`GET /progress` and `GET /team/progress` return a weak `ETag` derived from the response payload
and `Cache-Control: private, max-age=15`. Send it back in `If-None-Match`; an unchanged payload
returns `304` with an empty body. A `304` still counts against the daily quota.

Bodies of 1 KiB or more are gzipped when the client accepts gzip; smaller ones are sent
uncompressed. `gzip;q=0` is honored as a refusal; `identity;q=0` with gzip accepted forces gzip
regardless of size; refusing every available coding returns `406 no_acceptable_encoding`.

Pollers (TarkovMonitor, tarkov.dev, RatScanner) should poll at intervals of 60 seconds or more and
always send `If-None-Match`.

## Errors

API-host responses use `{"success": false, "error": "..."}`. Client-correctable problems keep
specific `4xx` messages. Requests on any other host (except `/health`) get a plain-text
`Not Found` 404 instead. Unexpected failures always return `500` with the fixed body
`{"success": false, "error": "Internal server error"}`; details are logged server-side only, so
clients must not parse `500` bodies. Missing or malformed upstream task/hideout catalogs return
`503` in the same envelope.
