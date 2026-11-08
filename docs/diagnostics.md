# Beta and Remote diagnostics

Beta and Remote use the same content-exclusion boundary. No automatic telemetry
includes prompts, replies, chat or file contents, credentials, project names,
paths, error prose, function/file names, log excerpts or raw process memory.
Regex redaction alone is not sufficient to enforce this rule.

Stable never constructs the release-diagnostics sender. Beta release diagnostics
remain automatic; their existing collection policy is separate from the
product-analytics switch. Remote release diagnostics follow **Share usage and
diagnostics** in Settings → General → Privacy. Turning sharing off aborts pending
requests where possible and removes unsent diagnostics and local context.
Beta/Remote homes and their random installation identities remain separate.

## Technical fields

| Event                                                                                       | Retained metadata                                                                                                             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `app.start`, `app.exit`                                                                     | Lifecycle duration; startup OS major/minor and language category                                                              |
| `app.error`                                                                                 | Main/renderer source, built-in error type and at most 30 numeric source positions; no original message, file or function name |
| `app.renderer-crash`, `app.child-process-crash`                                             | Fixed process/reason categories; backend exit reasons accept only numeric exit codes and fixed signal names                   |
| `update.check`, `update.available`, `update.downloaded`, `update.installed`, `update.error` | Check/download/install stage, outcome, bounded duration, release version and fixed failure reason; no failure message         |
| `usage.daily`                                                                               | Bounded aggregate usage counts and fixed categories, with no underlying chat or provider payload                              |
| `beta.installed`, `beta.left`                                                               | Fixed import/fresh-install or keep/trash outcome                                                                              |

Every envelope has an event UUID, random installation UUID, build flavor,
platform/architecture category, release version and normalized timestamp. Payload
kind must match its event. Unknown properties are discarded.

Handled failures reuse `app.error` with the fixed `DesktopDiagnosticIssue`
code/reason allowlist in `packages/contracts/src/ipc.ts` and optional bounded
numeric duration. Git, voice, cache/compaction, startup and event-loop issues
never attach exception text, operation arguments or identifiers. These reports
are observations, not proof of a root cause.

Error grouping is derived only from technical metadata. Changes to work content
or external addresses cannot change its fingerprint. Main/renderer reports of
the same handled code/reason share a group; duration is not a grouping field.
Identical groups are throttled for ten minutes with a 30-error hourly session
cap. An existing diagnostic ID is an event UUID, not a chat or user identifier;
upload acknowledgement does not mean a maintainer has reviewed it.

Recent fixed activity and numeric memory samples remain local to the process;
they are not serialized into error stacks or crash logs. Resize and error
listeners do not change application exception or recovery behavior. The
server-owned usage snapshot remains a rolling 24-hour observation, relayed at
most once per UTC upload day; it is not an exact disjoint calendar-day total.

## Queue, ingestion and historical records

The flavor-specific `diagnostics/events.jsonl` queue is bounded to 1 MiB and
trimmed to its newest 512 KiB. HTTPS uploads use fixed NDJSON envelopes, timeouts
and event-UUID deduplication. Before every upload, all legacy envelopes are
reconstructed and the local queue is atomically replaced with technical-only
records. Invalid or cross-flavor rows are discarded. Failed network requests
therefore leave no legacy prose in the retained queue.

The Cloudflare Worker independently applies the same technical boundary to
Beta, Remote, old clients and handcrafted requests. D1 stores only reconstructed
fields. Dashboard reads sanitize historical error text and keys while storage
cleanup is pending. Raw dump uploads, downloads and legacy forwarding return
HTTP 410 without consuming dump bodies or accessing R2. No flavor starts
Electron's raw crash uploader.

Older installed clients used broader diagnostics, including text and raw crash
memory. Source changes do not prove that clients have updated, the receiver is
deployed, or historical data has been deleted. Migration `0009` records a bounded
cleanup checkpoint; it does not read or erase the historical dataset during
schema migration. A separately authorized operator enables the cleanup job to
scrub legacy D1 text/content-derived grouping and triage keys and delete indexed
and orphan R2 dumps. See the [cleanup runbook](../apps/analytics/DIAGNOSTICS-CONTENT-CLEANUP.md).
No production cleanup is performed by checking out or testing this code.

Product events expire after 30 days and extracted diagnostic usage rows after
90 days, in capped scheduled batches. Other diagnostic records currently have
no automatic expiry; the historical content scrub is distinct from retention.

## Product analytics

Desktop Settings → General → Privacy offers **Share product analytics**, off by
default in Stable and Beta. Consent belongs to the controlling installation,
not the account or a connected host. Browser/CLI clients do not expose this
desktop sender. iPhone/iPad provide their own local consent control.

When enabled, fixed events record app readiness, selected feature opens, pairing,
connection/reconnection outcomes, chat request acknowledgements and startup
duration. The desktop also observes live terminal turn activities; available
usage counters are included without model names. Missing counters stay unknown.
These observations are not complete host execution totals: closed clients,
history and native completion events are not included. They are not billing data.

Each envelope contains a random per-installation UUID, event UUID, timestamp,
app version, channel, surface and platform. Additional fields are restricted to
fixed enums and bounded durations/token counts, including the fixed provider categories
`codex`, `claude` and `other`. No account identifiers or account-derived hashes, model
names, task/project/repository names, paths, routes, URLs, prompts, chat content, files,
credentials or error text enter this path. The random UUID is independent of login,
billing and the Beta diagnostics identity.

Events go to the Cloudflare Worker `/v1/product-events` and a separate D1
`product_events` table, viewed through its authenticated Product dashboard.
They are unrelated to private account usage, Saved Inbox and public profile
data. Raw product events are scheduled for deletion 30 days after receipt. Daily
cleanup deletes at most 100,000 rows in batches of 10,000, so an unusually large
backlog can take longer. This cleanup does not remove separate diagnostic records.

The desktop uses its flavor-specific `product-analytics` directory for consent,
the random identifier and an expiring queue (at most 500 events, seven days).
Uploads are limited to 50 events/64 KiB, with timeout and backoff. Turning off
collection aborts pending uploads where possible, clears unsent events and
removes the identifier. Re-enabling generates a fresh random identifier without
relinking it through an account. Turning off cannot
retract a request already received by Cloudflare; retention applies there.
The first account-free upgrade also replaces the legacy analytics identifier and
discards its unsent telemetry before replay. Consent and local workspace history
are preserved.

Release dependency: deploy the product D1 migration and receiving Worker before
shipping these clients. `/v1/crash` remains Beta-only. `/v1/events` accepts Beta and
Remote diagnostics; Remote events follow the sharing switch.

### Synara Remote

From version **1.0.6-remote.18**, Remote product events use the `remote` channel and
are **on by default** until the user turns sharing off; the choice persists per
installation and an existing off choice is preserved. Native iPhone/iPad apps from
**build 139** also default to on with their own local switch. Besides the events
above, Remote records `app.active` once per UTC day while the app runs, so long
sessions count as active days. Failed connections, pairings and chat requests can
carry one fixed `reason` category (for example `unreachable`, `not_accepting`,
`host_unlinked`, `timeout`); the receiver rejects a reason on any other outcome. The
dashboard counts installations active in the last 24 hours, 7 days and 30 days, and
installations that sent a chat request in those windows. These are rolling windows
ending now, not calendar-day, calendar-week or calendar-month totals. One person using
multiple installations may be counted more than once.

Remote and the other desktop lanes also record `command.used` for built-in keyboard
shortcuts (`shortcut:terminal.toggle`) and slash commands (`slash:plan`), once per key
press or command. Numbered jumps share one name; anything a person defined, such as a
custom shortcut, script or skill, is reported as `custom`. The receiver accepts only
that fixed `shortcut:` or `slash:` shape.

Product events are installation-only: signing in or out does not identify, merge or
relink analytics installations. Older clients used a deterministic account hash;
updated clients delete the saved hash and scrub it from queued envelopes. The updated
receiver discards that legacy field, and the account-hash removal migration deletes
it from stored product rows. These changes require updated clients, Worker and schema;
source changes alone do not update a deployed service or installed app.

Provider/model turn breakdowns remain a separate host-reported Beta/Remote diagnostics
path. A `usage.daily` report samples the preceding 24 hours and is sent at most once
per UTC day; it is not an exact calendar-day ledger or a complete global execution
total. Product and diagnostic usage observations are separate from account and billing
records.

### Aggregate reporting cohorts

Cohort-capable clients add only a UTC cohort entry day and one fixed return stage
(`new`, `week1`, `month1`) to successful `app.active` events after the receiver confirms
support. Cohorts measure new reporting installations, including upgrades adopting the
measurement, resets and reinstalls; they do not measure downloads or people. Return
windows cover days 7–13 and 30–36, and rates remain unknown until each full window plus
seven days of delayed-upload grace has passed. Missing return reports do not establish
an uninstall or subscription cancellation. Existing activity is not backfilled.

Raw events keep their 30-day cleanup schedule. Only day/channel/surface aggregate counts
survive in `product_cohorts`, with a 90-cohort-day scheduled cleanup target and capped
batches; no installation or account identifier is stored in that table. Local cohort
state is deleted with product opt-out. Re-enabling starts a new random reporting identity.
This protocol requires migration 0008, the cohort-capable receiver and updated senders;
source changes do not deploy it or enable native cohort reporting.
