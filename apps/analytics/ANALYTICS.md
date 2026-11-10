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
are discarded, including legacy `accountHash` values of any type. The receiver
never stores or queries account linkage. Commands must belong to the shared
`PRODUCT_ANALYTICS_COMMANDS` list; custom names become the fixed `slash:custom`
category on the client. Invalid required or optional values reject that event. There
are no event-level read APIs.

Never add prompts, replies, filenames, paths, repository or project names, URLs,
account identifiers, credentials, arbitrary strings, or error text.

## Storage and dashboard

Accepted events enter `product_events`; `events`, `usage_providers`, `usage_turns`,
and `crash_dumps` remain diagnostics data. Event UUIDs make retries idempotent.
The daily scheduled job deletes product rows by `received_at` after 30 days and
raw usage provider/turn samples after 90 days. Each table uses 10,000-row chunks,
capped at 10 chunks per run; a larger backlog is picked up by later runs.
General diagnostic records, issues and R2 minidumps keep their existing retention
policy, including project/active-thread counts retained on `events` usage rows.
Changing that policy requires coordinated issue and R2 cleanup.

Snapshot producer, desktop queue and receiver share finite provider, bundled
model, effort, mode and origin categories. Unknown model/dimension values become
`other`; unknown provider summary rows are dropped. Syntactically valid custom
strings and future-looking model names do not extend the allowlist. Migration
`0007_installation_privacy.sql` removes historical account linkage and scrubs
unknown stored commands and usage categories to fixed fallbacks. Known safe
categories and numeric totals are preserved; unknown provider rows merge into
`other` without primary-key collisions. Dashboard queries normalize categories
before grouping and limiting, including before migration, so an installation
counts once within its resulting category. See [deployment order](README.md#deployment).

The private dashboard reads `/api/product?from=YYYY-MM-DD&to=YYYY-MM-DD`, with
optional `channel` and `surface` filters. It reports daily event and active
installation counts, feature usage, event outcomes, mean durations, and sampled
token totals from reported desktop `turn.completed` events. These are client
observations from installations that enabled sharing, not complete global turn
or account billing totals. Missing token samples stay unknown and are excluded
from totals. Counts represent installation IDs that sent events, not people.
The query range is limited to the 30-day retention window. Rolling active
installation counts cover the last 24 hours, 7 days and 30 days. Engaged means
an installation attempted a chat request, including failures; it does not mean
a successful use. There are no account-level counts or individual drill-downs.

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

## Reporting cohorts

Migration `0008_product_cohorts.sql` adds installation-generated `cohortDay` and
`cohortStage` (`new`, `week1`, `month1`) only to successful `app.active` envelopes.
The renderer input cannot set these fields. Desktop starts a cohort only after
an existing product POST acknowledges receiver support and an entry envelope is
durably queued. Native senders need the same protocol before their cohorts appear;
existing activity is never backfilled. An entry is a **new reporting installation**,
including adoption of this measurement, resets and reinstalls, not a download or person.
GitHub cumulative asset downloads and external Apple reporting are separate sources.

A return is observed once during UTC days 7–13 or 30–36 after entry. A cohort becomes
mature only after the whole window and seven days of upload grace (day 21/day 44).
The Overview reads the last 90 complete UTC cohort entry days independently of the raw
product date filter, retaining the channel/surface filters. Immature rates are unknown;
non-return is absence of a report, not proof of uninstall or subscription churn.
Opt-out, offline use and missing reports affect these best-effort observations.

Raw envelopes and their UUID deduplication still expire on the 30-day schedule.
SQL triggers increment only day/channel/surface aggregate counters in the same
transaction as the raw insertion. A null-to-cohort upgrade safely handles a raw UUID
stored by an older receiver during rollback. The aggregate table contains no event,
installation or account identifiers and is scheduled for deletion after 90 cohort days,
using the same capped daily cleanup. There is no individual retention drilldown.

The desktop persists cohort state separately from its bounded queue, writes the entry
queue first, and acknowledges a stage before removing its envelope. Stable stage UUIDs
are SHA-256-derived from only the random installation UUID, cohort day and closed stage,
with UUIDv8/version and RFC variant bits. Restart re-establishes support before sending
queued cohort metadata. Recovery reconciles a newer durable replacement entry even
when an older state file is still valid. A stage acknowledgement requires the stored
UUID and installation/scope/event/outcome/cohort tuple to match the request. An already
classified stage survives timestamp changes after local state loss; upgrading a plain
legacy row additionally requires the original timestamp. Normalization or an ignored
insert alone is not a receipt. Opt-out deletes cohort
state together with the queue and ID;
re-enabling begins a new reporting identity. Old entries that expire before their
acknowledgement start a fresh measurement rather than sending an out-of-window entry.

Rollout: apply migration 0008 before deploying this cohort receiver, then ship senders.
The nullable columns preserve older receivers/clients; a capability header and explicit
stage UUID acknowledgements prevent an older receiver from silently completing stages.
No deployment, production migration or native cohort release is implied by these changes.

The cross-language wire fixture is
`packages/contracts/fixtures/product-analytics/cohort-v1.json`, copied byte-for-byte
from the native fixture. Sender tests compare real generated UUIDs with its independent
hardcoded vectors; receiver tests replay its full iPhone/iPad payloads with clocks fixed
to each event's July 2026 timestamp so event-age validation remains exercised.

## Diagnostics content boundary

Beta and Remote diagnostics keep fixed error/issue categories and numeric source
positions only. Error prose, log tails and raw crash memory are excluded for all
flavors. Raw dump routes, including legacy forwarding/downloads, are retired.
Old queue rows are reconstructed before upload; historical API reads are guarded.
Migration `0009` prepares a checkpointed content scrub. Actual D1/R2 deletion is
an explicit, bounded operator operation; no production cleanup is implied by
this source. See [the cleanup runbook](DIAGNOSTICS-CONTENT-CLEANUP.md).

## Host usage quality followup

The existing host turn grouper now supplies product-consented, frozen completed
UTC-day windows across Stable/Beta/Remote. New diagnostics no longer ingest
provider/model/execution/token payloads. Legacy sampled rows stay separate.
`usage_turns` is reused for anonymous daily counters; receipts14days, counters and
quality90UTCdays, no host UUID/account key in those rows. Token fields have
independent measured denominators and explicit zero/unknown semantics. The
Product Providers page reuses the Usage breakdown table and exposes truncation,
missing-time and partial-consent coverage without claiming complete/global totals.
Schema and client rollout must follow [README deployment order](README.md#product-host-usage).
