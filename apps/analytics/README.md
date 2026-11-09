# Synara analytics and Beta diagnostics

This workspace owns the Cloudflare receiving Worker, private dashboard, D1
migrations, legacy ingestion forwarder and their tests. It includes Product
Overview, Providers, Tokens and Reliability, plus Beta release/crash diagnostics.

- Live: https://synara-beta-diagnostics.synara-orgs.workers.dev/#/product
- Privacy and client contract: [diagnostics](../../docs/diagnostics.md).
- Metrics and historical deployments: [ANALYTICS.md](ANALYTICS.md).
- Previous account migration: [MIGRATION.md](MIGRATION.md) (historical, not a setup requirement).

## From the Synara repository root

```bash
bun install --frozen-lockfile
bun run --cwd apps/analytics test
bun run --cwd apps/analytics typecheck
bun run --cwd apps/analytics build
```

Root Turbo tests/typechecks include this workspace. CI also builds the dashboard
and dry-runs the Worker bundle. The Worker imports the canonical
`@synara/shared/diagnosticsRedaction`; its regression tests remain in packages/shared.

## Local development

Create `apps/analytics/.dev.vars` (ignored) with local-only
`DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_KEY`. From `apps/analytics`:

```bash
bunx wrangler d1 migrations apply synara-beta-diagnostics --local
bunx wrangler d1 execute synara-beta-diagnostics --local --file seed/local.sql
bun run dev --port 8787
```

Choose an unused port; local fixtures never belong in the production database.

## Deployment

From the root, with an authorized Synara Orgs Wrangler session:

```bash
bun run --cwd apps/analytics deploy
```

The script builds first. Existing Worker name, D1/R2 bindings, secrets and live URL
are preserved. Moving source into this monorepo requires no database migration,
new credentials or client endpoint change. Do not deploy from the former separate
repository: this workspace is the source of truth. For future schema changes,
review the order required by each migration before deploying dependent code.

For `0007_installation_privacy.sql`, deploy the new receiver first: its INSERT
omits `account_hash` and works against both schemas. Then apply the migration
to scrub/remove the old linkage column, replace historical unknown usage/command
categories with fixed fallbacks, and add the usage-retention index. The new
receiver also normalizes stored categories before grouping dashboard results,
so legacy strings stay hidden during this rollout. Never
run the old receiver against the migrated schema. No production migration or
deployment is authorized by the presence of this file.

`POST /v1/product-events` accepts bounded, consented desktop/iOS/iPadOS reports;
`GET /api/product` requires dashboard authentication. Raw product events expire
after 30 days. Raw diagnostic provider and turn samples (`usage_providers` and
`usage_turns`) expire after 90 days; other diagnostic records and minidumps keep
their existing retention policy. Usage counts on general `events` rows, including
project and active-thread counts, remain under that policy. Provider turns and
token samples currently describe observed
desktop completions, not account-wide billing or globally deduplicated execution.
Native clients contribute lifecycle, feature, connection and request events under
their own consent. Beta `/v1/events` keeps its separate collection policy but the same content exclusions; `/v1/crash` is retired.

No local state, credentials, D1 data, R2 dumps or exports are tracked here.

Reporting cohorts use optional installation-generated cohort day/stage fields and
aggregate-only 90-day history. Week/month return rates wait for complete return windows
and seven days of upload grace; existing usage is not backfilled. These measure new
reporting installations and observed returns, not downloads, people, uninstalls or
subscription churn. See [Reporting cohorts](ANALYTICS.md#reporting-cohorts) for the
migration-first rollout and queue/retry/privacy contract.

## Diagnostics content boundary

Beta and Remote diagnostics keep fixed error/issue categories and numeric source
positions only. Error prose, log tails and raw crash memory are excluded for all
flavors. Raw dump routes, including legacy forwarding/downloads, are retired.
Old queue rows are reconstructed before upload; historical API reads are guarded.
Migration `0009` prepares a checkpointed content scrub. Actual D1/R2 deletion is
an explicit, bounded operator operation; no production cleanup is implied by
this source. See [the cleanup runbook](DIAGNOSTICS-CONTENT-CLEANUP.md).

## Product host usage

Deploy additive migration `0010_product_host_usage.sql` before the receiving Worker,
then ship the client; no deployment is performed by local checks. The existing
product endpoint accepts a closed `hostUsage` payload from the existing consent
sender. `usage_turns.source='product'` stores anonymous day/channel/dimension
counters with a fixed install placeholder; its partial unique index supports
atomic upserts. Opaque day receipts expire after 14 days, aggregate counters/quality
after 90 UTC days. Diagnostic rows remain `source='diagnostic'`, separately labelled
legacy sampled; new diagnostics accept only project/active-thread health counts.
See the [precise consent, measurement and coverage contract](../../docs/diagnostics.md#product-consented-host-execution-windows).

Product aggregate/quality `received_at` values are UTC window boundaries, not
individual arrival times. Only the 14-day deduplication receipts keep arrival time;
90-day product counter cleanup uses the aggregate `day` field.

## Public installer download observations

The existing daily scheduled sweep also reads the public GitHub Releases API,
without credentials or installer binaries. It shares the marketing installer
artifact parser (`@synara/shared/installerDownloads`): only `.dmg`, `.exe` and
`.AppImage` asset `download_count` counters qualify. Pagination is capped at ten
100-release pages, 8 MiB total response bytes, 10,000 installer assets and a
20-second source deadline. Hitting any limit, malformed data, rate limits or a
partial traversal preserves the last successful snapshot. No fallback marketing
counter is written as a fresh observation.

Migration `0011_installer_downloads.sql` is additive and must be applied before
running a receiver that reads these tables. Its numeric per-asset head and finite
channel/platform interval totals contain no names, URLs or installation IDs.
Snapshots and history older than 90 days are pruned after successful source
reconciliation; source outages can delay age-based cleanup while preserving the
last good observation. The current asset head is replaced only by a complete
successful reconciliation. The transactional snapshot
claim rejects duplicate, older and concurrent writers before they can change
history or the current head; a traversal overlapping a newer completed snapshot
is also rejected. No migration or deployment is authorized here.

Product Overview shows the latest source counter independently of its date
range, plus intervals whose ending snapshot falls in that range. Counts include
repeat downloads, updaters and bots; they are not unique people or installs, and
the current counter includes only assets GitHub still lists. The initial baseline
has no increase. Missing/reset/reclassified assets and newly discovered assets
created before the prior observation make the affected scope's increase unknown;
a later comparable interval can recover. New assets created after the prior
observation can contribute their full current count. GitHub traversal is not an
atomic source snapshot, so intervals are observations, not exact daily counts.

Channel filters follow release tags (`stable`, `beta`, `remote`); unrecognized
historical tags remain in a finite `other` bucket, visible only with all channels.
iOS/iPadOS filters report unsupported App Store counts, never desktop totals.
App Store owner analytics and external mirrors are not measured here, and
first launch is never used as a download proxy. See the GitHub
[release API](https://docs.github.com/en/rest/releases/releases#list-releases)
for the public counter source. Tests use synthetic responses and local SQLite;
they never call a live Worker or D1 database.
