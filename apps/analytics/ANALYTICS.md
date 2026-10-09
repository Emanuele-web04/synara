# Product events

## Current ownership: Synara monorepo

As of 5 October 2026, this service is maintained in `apps/analytics` on Synara's
`codex/cloudflare-remote-mvp` branch (PR #1412). Source imported from the former
standalone repository at `c2fe29c`; its PR #3 no longer needs a merge to ship this
work. The account, Worker name, bindings and endpoint are unchanged.

The native iPhone and iPad branches already target the same product endpoint,
with a local default-off switch. A loopback integration check compiled each
branch's actual Swift sender and delivered five synthetic events per surface
through this Worker into an isolated D1 database. Authenticated queries returned
only each surface's five events and one installation. Desktop completion totals
remained zero and missing token totals remained unknown. Default-off and opt-out
checks passed. This checks the native sender/receiver path, not a fresh device or
simulator UI session. No production data was inserted.

The imported redactor copy and its duplicate test suite are omitted: the Worker
uses the existing shared redactor, whose tests also cover loopback URL handling.
Wrangler remains pinned at 4.135.0 for this workspace because older 4.122.0 cannot
run the Worker's 2026-09-01 compatibility date locally. Other workspace dependency
versions are retained; the lockfile includes dependency hoisting changes.

This Worker has a separate endpoint and D1 table for product events. Beta
crashes, errors, updates, and usage diagnostics continue through their existing
routes and schema.

## Consent and payload

The application integration must default to off and send only after the user
enables sharing in Settings. It must keep the setting local to that installation
and clear queued product events when sharing is disabled. The Worker cannot
prove application consent from an incoming request; it validates and stores
only the fixed event envelope.

`POST /v1/product-events` accepts JSON shaped as `{ "events": [...] }`, with at
most 50 events and a 64 KiB request body. Each event carries only the version,
random install and event UUIDs, timestamp, release channel, app surface,
platform, app version, one event name, one outcome, and optional enumerated
feature/mode/provider fields or bounded duration/token counts. Unknown fields
are discarded. Invalid required or optional values reject that event. There
are no event-level read APIs.

Never add prompts, replies, filenames, paths, repository or project names, URLs,
account identifiers, credentials, arbitrary strings, or error text.

## Storage and dashboard

Accepted events enter `product_events`; `events`, `usage_providers`, and
`crash_dumps` remain diagnostics data. Event UUIDs make retries idempotent.
The daily scheduled job deletes product rows by `received_at` after 30 days in
10,000-row chunks, capped at 10 chunks per run, and does not alter diagnostic
data. An unusually large backlog is picked up by later runs.

The private dashboard reads `/api/product?from=YYYY-MM-DD&to=YYYY-MM-DD`, with
optional `channel` and `surface` filters. It reports daily event and active
installation counts, feature usage, event outcomes, mean durations, and sampled
token totals from reported desktop `turn.completed` events. These are client
observations from installations that enabled sharing, not complete global turn
or account billing totals. Missing token samples stay unknown and are excluded
from totals. Counts represent installation IDs that sent events, not people.
The query range is limited to the 30-day retention window.

## Production checkpoint — 5 October 2026

Migration `0005_product_events.sql` and source commit `7f14dd0` were deployed to
Synara Orgs. Initial Worker version: `bd556f7d-088e-4d4c-adbf-b0d02d4ad4e3`
(created 4 October at 23:48 UTC). Existing secrets, D1/R2 bindings and rate limits
were preserved. The daily retention schedule is installed; its first scheduled
execution has not been observed.

Live checks passed: health 200, unauthenticated aggregates 401, malformed JSON
400, wrong content type 415, synthetic event accepted once and duplicate accepted
zero. The authenticated Product dashboard showed its 42 ms duration. That one
synthetic event was deleted by exact event/install UUID and zero probe rows remain.
Previous Worker version for rollback: `cb10fe76-56c7-4e00-ae25-0fe5f36a3167`;
the additive table can remain if the Worker is rolled back.

Desktop and native consent/sender changes are pushed in their existing PRs.
New client builds are still needed; deployment does not enable sharing on any
installation, merge a PR, or publish a signed app/TestFlight release.

## Turn reporting

Product now separates accepted chat requests from observed terminal desktop turns.
The daily chart includes observed turns; the turn section counts succeeded, failed
and cancelled executions and groups those outcomes and available input/output/cache
tokens by provider. Unknown provider remains separate from Other. Each token sum
shows its sample count; missing usage stays unknown and reported zero stays zero.
Started events and mobile completion envelopes do not enter desktop turn totals.

These are client observations, not unique global executions: multiple installations
can observe the same turn. Event UUID retries deduplicate, but cross-device turn
identity is not collected. No provider/model cost or global billing claim is made.
The desktop server now preserves the provider on every terminal activity; older
clients/servers can still report Other. Specific model names remain uncollected.

Verification: 119 Worker tests, typecheck and build passed. A local Wrangler/D1
check and browser inspection confirmed four terminal turns (two succeeded, one
failed, one cancelled), provider/token rows, and separation from accepted requests.
The test uses synthetic data only. Desktop projection/ingestion: 146 tests passed;
provider attribution regression failed for Codex/Pi before the repair.

Turn dashboard deployed from `34209d8` as Worker version
`481d06ef-2370-4825-8323-c848e3004d78`. Verified with both Wrangler and cf CLI;
live health 200, unauthorized API 401 and authenticated turn dashboard rendered.
No additional migration or production test data was required for this update.

## Provider chart UI — 5 October 2026

The Product page now leads with a provider comparison chart, bundled provider
logos, distinct series colors, observed-turn totals, period deltas, a clearly
labelled Claude/Codex ratio and share bars. The default range is the previous
seven complete UTC days; 7/14/30-day presets and custom ranges are available.
The chart axis starts at zero and keeps Other/Unknown series when present.
Token details remain available below the chart with sample counts.

The API adds daily provider aggregates and an equal-length previous period using
the same channel/surface filters. Comparison is unavailable for a partial current
day or when the previous period falls outside retention. A zero baseline produces
no growth percentage; a zero Codex denominator produces no ratio. These remain
client observations, not unique users or globally deduplicated turns.

Reused EChart, chartChrome, Stat, TableWrap and deltaDetail. Provider logos reuse
the SVG assets already shipped in Synara and are bundled as same-origin assets;
no external requests or broader CSP permissions. No new events or migrations.

Verification: 120 tests, typecheck and build pass. Browser checks covered populated
charts/logos, date presets, tooltips and empty mobile-filter results. Screenshots
in docs/images are synthetic local fixtures, not production measurements.

Published as Worker `479820f6-84fa-4913-b2ec-9b47bd18e5da` from `b9fccd5`.
Live checks confirmed health 200, private API 401 without session, authenticated
empty-state rendering and both bundled SVG logos returning image/svg+xml.
No production data was seeded.

## Product navigation (2026-10-05)

Product analytics is divided into Overview (activity and features), Providers
(branded comparison and daily turns), Tokens (observed totals and sample coverage),
and Reliability (terminal outcomes and durations). The existing navigation,
charts and tables are reused. Each section has a direct `#/product/<section>`
link; `#/product` and unknown section names fall back to Overview. Browser
back/forward work without replacing the Product component, keeping the current
date/channel/surface filters across section changes. A full reload retains the
section and restores the default filters, as before.

This is a dashboard-only change: ingestion, consent, retention, auth and D1
schema are unchanged. Validation: 121 tests, TypeScript and production build;
browser checks of all sections, shared date filters and back navigation.
The section preview uses synthetic local fixture data, not production usage.

Published section navigation from `26e70b1` to Worker version
`39a3b37b-c6d4-4ef4-90ca-ee597c61acbe`. Verified the authenticated live
Providers page and navigation, `/health` 200 and unauthenticated `/api/product` 401. No production fixture rows were added.

## Monorepo deployment checkpoint

Synara source `67f9dec` was deployed as Worker version
`29cd18af-d988-4d93-9a71-d31b91d0f0e6`. Verified `/healthz` 200 (`ok`),
unauthenticated `/api/product` 401 and authenticated live Product navigation.
The old standalone PR #3 is closed as superseded by Synara PR #1412.

Checks passed: 78 analytics tests, 3 native analytics tests, the actual iOS and
iPadOS Swift senders against isolated local Worker/D1 (5 events each), build,
Worker deploy dry-run, frozen Bun install, root formatting/lint/typecheck, CI
contracts and released migration lineage. Lint retains warnings; the existing
ECharts bundle still triggers the build size warning. Full-suite first attempt
hit a sandbox loopback restriction; the permitted run exposed two AppSnap test
cleanup/timing failures. All 52 AppSnap tests passed isolated; a reduced-concurrency
workspace rerun passed: 16,102 tests, 251 skipped, all 11 packages successful.
The skips include 200 PostgreSQL tests without an isolated test database.
