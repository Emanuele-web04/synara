# Anonymous reliability operations

The fixed event contract lives in `packages/contracts/src/reliability.ts`.
Desktop consent and delivery are owned by `ReliabilityReporter`; backend
producers only send allowlisted codes to their parent. No raw logs, customer
identities or chat content belong in this dataset.

## Rollout

1. Verify the target is the Synara Orgs account and the `synara-beta-diagnostics`
   Worker/D1 binding. Inspect the applied migration ledger and schema read-only.
2. Obtain deployment authorization and a D1 recovery point/export. Apply only
   the reviewed additive `0013_reliability.sql`, and record its completion using
   the deployment's migration procedure. Do not blindly apply every pending
   historical migration: some environments intentionally skipped `0007` and
   `0009`. This change does not authorize that cleanup work.
3. Deploy the Worker with both reliability endpoints and retention. Existing
   product and release-diagnostics ingestion keeps its separate contract.
4. Release the desktop sender. A sender reaching an older receiver retains its
   receipts for retry within the seven-day window. A receiver deployed without
   the new tables returns 503 without acknowledging them.

The migration adds two tables, an index and two triggers; it does not rewrite
existing data. D1's batch transaction and the insert trigger commit each receipt
with its aggregate increment. Replaying an identical receipt has no effect on
the count. Reusing a receipt ID with different fields aborts the batch. Rollback
can restore the previous Worker while leaving the additive tables intact;
clients retain unacknowledged records. Never reset a customer's app database.

## Read-only investigation

After signing into the existing dashboard, request
`/api/reliability?from=2026-11-11&to=2026-11-17&channel=stable` (use the actual
incident range). Optional exact filters are `version`, `platform` and `code`;
`day` can replace `from`/`to`. The default range is seven UTC days, the maximum
is 90 days, and responses cap at 1,000 rows with `truncated: true` when necessary.
Narrow the range or filters when truncated. Dashboard results never return
receipt IDs.

The same aggregates can be queried through the authenticated Wrangler CLI:

```sh
bun run --cwd apps/analytics wrangler d1 execute synara-beta-diagnostics --remote \
  --config wrangler.toml \
  --command "SELECT day, app_version, platform, code, SUM(count) AS observations FROM reliability_daily WHERE channel = 'stable' AND day >= date('now', '-6 days') GROUP BY day, app_version, platform, code ORDER BY day DESC, observations DESC LIMIT 200" \
  --json
```

Compare `backend.exit_before_ready`/`backend.exit_after_ready` with
`recovery.crash_resume_accepted`, `recovery.crash_resume_skipped` and
`recovery.shutdown_event_timeout` for the affected release. Migration,
account-refresh and chat-settlement codes identify their owning subsystem.
These are correlations across anonymous observations, not a per-user timeline
or proof of causality. An empty result can mean no recorded consent, an old
client/receiver, failed delivery, expiration, or no matching observations.

For remote-access interruptions, also compare `remote.ingress_socket_error`,
`remote.tunnel_socket_error` and `backend.event_loop_stall`. The first two count
handled connection failures; a count does not mean the backend crashed. Stall
counts use the existing monitor's throttling and do not attribute a slow query.
Socket categories are also limited to one report per category per backend every
thirty seconds; they count reporting windows, not every failed connection.

The worker rejects unknown codes/properties, noncanonical release strings,
precise timestamps and dates outside the retry window. Extend the shared
allowlist and add an owner-level producer when a newly confirmed failure needs
tracking; never add arbitrary exception messages or repository-derived values.
