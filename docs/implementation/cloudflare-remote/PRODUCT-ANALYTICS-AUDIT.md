# Product analytics implementation — 5 October 2026

Default-off product analytics for desktop Stable/Beta and native iPhone/iPad,
using the existing Cloudflare service. Existing Beta crash diagnostics remain
separate and Beta-only. This document describes the branch implementation;
shipping it requires the receiving migration/Worker followed by new client builds.

## Ownership and data flow

| Boundary          | Implementation                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contract   | `packages/contracts/src/productAnalytics.ts`: fixed event names/enums and bounded numbers; no arbitrary property dictionary                                |
| Desktop owner     | `apps/desktop/src/productAnalytics.ts`, trusted main-frame IPC, preload bridge; flavor-specific local consent and random identifier                        |
| Desktop UI        | Settings → General → Privacy → Share product analytics; existing settings primitives and switch                                                            |
| Web observers     | `apps/web/src/lib/productAnalytics.ts` and transport/navigation owners; fixed categories only; remote workspace frames use their controlling app's consent |
| Native            | Local settings control and bounded sender in both existing native branches; no inherited consent from account or remote Mac                                |
| Cloudflare        | `/v1/product-events`, separate `product_events` D1 table, authenticated `/api/product` aggregates and Product dashboard                                    |
| Existing services | `/v1/events` and `/v1/crash` remain Beta-only; account usage, public profile and private Saved Inbox are not copied into analytics                         |

No additional analytics vendor, browser autocapture, session replay or user
identification service. The random installation UUID is unrelated to account,
provider, device, hardware and Beta diagnostics identities. It groups events from
one consenting installation; it should not be described as a unique person count.

## Coverage and limits

| Event                                        | Meaning                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `app.open`                                   | App lifecycle observation, with explicit outcome                                                                                    |
| `performance.startup`                        | Measured readiness duration; platform-specific readiness points are not directly interchangeable                                    |
| `feature.used`                               | Selected feature navigation/actions classified into a fixed enum                                                                    |
| `connection.pair`                            | Pairing operation result; no pairing codes, device names or credentials                                                             |
| `connection.connect`, `connection.reconnect` | Connection attempt outcomes and elapsed duration at each client's transport owner                                                   |
| `chat.request`                               | Request acknowledgement, failure or cancellation; not successful assistant completion                                               |
| `turn.completed`                             | Desktop renderer's observed live terminal activity, locally deduplicated; no snapshots/history, closed-client or native completions |

Optional counters include bounded input/output/cache-read token totals only when
available. Missing values remain unknown. Model names and arbitrary provider
identifiers never leave this path; providers are fixed categories. Client
observations across multiple installations are not globally deduplicated host
execution totals. Use account usage records for complete user-facing history;
never use these consent-dependent observations for billing or quota enforcement.

No prompts, chat text, file contents, project/task names, paths, URLs, account IDs,
error messages or model names are accepted. The receiver reconstructs allowed
fields and validates UUIDs, timestamps, enum values and numeric bounds.

## Consent and delivery

- Off by default, per installation and desktop flavor. Only an explicit Settings
  choice enables product events. Beta crash collection is unaffected.
- At most 500 queued events, expiring after seven days; uploads contain at most
  50 events and 64 KiB. Bounded retries/backoff and request timeouts preserve app use
  through ingestion outages. Retried event UUIDs are idempotent in D1.
- Opt-out cancels requests where possible and removes unsent events and the local
  identifier. Re-enable creates a new identity. Already received requests cannot
  be retracted by the local switch.
- Raw product events have a 30-day retention policy and bounded scheduled cleanup.
  This does not delete or change retention of existing Beta diagnostics.
- Dashboard data requires the existing session/Access authentication. Public
  ingestion uses validation, size limits and existing rate limiting; distributed
  clients contain no ingestion secret. Public events remain untrusted telemetry.

## Verification and release order

Targeted checks cover default-off behavior, opt-out during sending, persistence,
retry identity, bounds, main-frame IPC, live completion vs history, Settings save
errors, real SQL deduplication and authenticated aggregates. Final run results
belong in the latest handoff checkpoint; implementation alone is not proof of a
live deployment or a signed app release.

Production checkpoint (5 October 2026): the additive D1 migration and Worker
`bd556f7d-088e-4d4c-adbf-b0d02d4ad4e3` are deployed. Synthetic ingestion,
deduplication, authenticated dashboard aggregates and unauthenticated rejection
passed; the single synthetic event was removed and zero probe rows remain.
The daily retention trigger is installed; its scheduled execution is not yet observed.
Client builds and physical-device qualification remain release work.

1. Validate all client schemas against Worker acceptance.
2. Apply the additive D1 product migration and deploy the receiving Worker/dashboard.
3. Verify synthetic ingestion, duplicate handling and private dashboard access.
4. Ship consent-aware desktop and native builds. Retain separate Beta diagnostic gates.
5. Qualify native suspension/reconnection on physical devices before wider rollout.

Privacy copy is synchronized in desktop diagnostics documentation, marketing
privacy text and native privacy documents. No account data or existing diagnostics
migration is required for the new product table.
