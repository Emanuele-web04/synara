# Historical diagnostics content cleanup

This runbook prepares a separate production operation. No deployment, credential
access or production deletion is authorized merely by this file.

## Order and containment

1. After explicit deployment authorization, deploy the technical-only receiver
   and legacy forwarder. `/v1/crash` and `/api/dumps/*` must return 410 without
   reading bodies, forwarding requests or accessing objects. New/legacy Beta
   and Remote JSON must store technical fields only. New clients start no raw
   crash uploader. Old client processes need a client update to stop attempting
   uploads; a receiver cannot prevent bytes leaving those old installations.
2. Apply the normal ordered D1 migrations through `0009` after the receiver
   guard is deployed. `0009` records the highest legacy event ID and triage
   rowid; it does not load raw content into tools or rewrite the whole table.
   It depends on existing events/issue tables, not migration `0008` fields.
3. Obtain separate authorization for deletion, including reset of historical
   issue triage. Enable `PURGE_LEGACY_DIAGNOSTICS=true` only for this operation.
   The scheduled handler then invokes the bounded cleanup functions. If quicker
   completion is required, an authorized operator can temporarily increase the
   cron frequency; restore the normal schedule afterward.

## Bounded work and retries

Each invocation scrubs at most 100 historical events, then at most 100 historical
triage keys once the event range is finished. Only numeric row IDs are read.
The event scrub and its checkpoint advance share one D1 batch; failure cannot
advance beyond un-scrubbed rows. It removes all legacy message/stack/log text,
replaces content-dependent error grouping with one legacy technical group, and
normalizes process/reason/source/platform/architecture fields. Event counts
remain intact. New technical events beyond the recorded checkpoint are not
rewritten. Historical individual error frames and triage assignments are lost
intentionally rather than retained through uncertain text redaction.

Each invocation also lists the first page of at most 100 `dumps/` objects and
deletes them before deleting their D1 index rows. Listing the prefix catches
orphan objects whose index insert failed. Re-listing the first page after each
delete avoids cursor skipping while the set shrinks. A partial failure can leave
an object, an index row or both; repeat the job. Only after the prefix is empty
are at most 100 remaining stale index rows deleted per invocation. Unrelated R2
prefixes are untouched. Do not export or download dumps for this cleanup.

## Completion evidence and scope

Record counts only, never messages, object bodies, keys, account IDs or exports:

- checkpoint `last_event_id = through_event_id` and `status_complete = 1`;
- no remaining objects under the dedicated bucket's `dumps/` prefix;
- zero `crash_dumps` index rows;
- synthetic ingestion/read probes demonstrate the technical-only boundary.

Disable `PURGE_LEGACY_DIAGNOSTICS` after completion and restore any temporary
schedule. A missing bucket binding is not proof the historical bucket is empty;
verify the dedicated bucket through the authorized operator's storage inventory.
Existing backups, D1 recovery copies and previous export archives are separate
copies. Inventory and erase/minimize them under the same authorization and
retention obligations without copying content into chats or logs. Do not claim
complete historical deletion until those copies and actual receiver/forwarder
rollout are checked. The source/tests cover only synthetic local data.
