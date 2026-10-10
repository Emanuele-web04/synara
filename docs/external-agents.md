# External agent profiles

This change adds the server-side profile, discovery, capability-evidence, and ACP/CLI runtime foundation. It does not provide a complete profile-creation/model-picker UI. Existing pinned external threads and composer drafts retain their profile identity; built-in provider health and discovery never substitute another provider for them.

## Identity and access

A selection uses provider and instanceId `external`, plus an immutable `profileId`, `revisionId`, and model. The server resolves the executable and credential references from its own profile store on every session start. A client cannot supply an expanded launch environment. Profile/discovery/evidence-management RPCs require an authenticated owner session.

Revisions are content-addressed, but membership is recorded separately for each profile. Reverting to shared content preserves earlier memberships. A profile cannot launch an unrelated revision using its own credentials. The migration can prove only the current revision of an older experimental profile; ambiguous historical parent links are not treated as ownership.

Quarantined and retired profiles cannot start. Credential release requires explicit owner authorization in `trust.allowCredentialAccess`. Brand, organization, workflow, and provenance labels cannot grant it. Editing a revision clears the grant unless the owner explicitly supplies it again. Unexpected trust-check errors fail closed. Provenance labels are owner-managed metadata, not cryptographic vendor attestation. This is a local process integration, not an operating-system sandbox: an executable still has the permissions of the Synara server user.

External processes inherit only basic OS launch variables and explicitly referenced credentials, rather than every ambient server API key. Native event logging uses the shared secret redactor. Revisions, resumable cursors, and turn attribution do not contain expanded secrets.

## Runtime behavior

- ACP supports real prompt turns, streamed assistant/tool events, approvals, elicitation, modes, plans, and usage when the agent emits them. Authentication is requested on demand, so agents without authentication methods can start.
- Model `default` explicitly means the agent's configured default. A specific ACP model is applied through an advertised model config option; an unsupported selection fails instead of merely changing the displayed label. Arbitrary connector model options are currently rejected.
- CLI structured and basic connectors accept text only and model `default`. They do not pretend to support image attachments, native resume, model switching, or ACP permissions. CLI connectors do not receive a Synara MCP session grant.
- Unknown ACP permission kinds are cancelled, including in full-access mode. Display titles are not promoted into executed-command evidence, and unknown plan statuses do not become invented pending steps.
- Turn completion waits for the adapter's queued ACP notifications to drain. Stops terminate the owned runtime and emit one terminal event. A structured CLI exiting without a terminal turn event fails the turn.
- Resume cursors bind a native session to both profile and revision. Older unbound cursors require an explicit fresh session. Native forks and direct history rollback are unsupported; a restart-based context rebuild is required.
- CLI stdout has bounded frames and strict UTF-8 decoding. Conformance stdout capture is capped at 4 MiB. Scratch directories are asynchronous, scoped resources cleaned up on success, failure, timeout, or interruption.

## Persistence and compatibility

New migrations follow the current released lineage. Historical turns remain unattributed when their actual profile cannot be established; the current thread selection is not evidence of which agent produced an old turn. New turn-start events capture pinned attribution.

Drafts, sticky selections, and queued turns preserve external profile and revision identity across serialization. A built-in provider preference, trait edit, or generic catalog lookup cannot reconstruct or replace that identity.

Capability evidence is scoped to both profile and revision. Re-certification re-evaluates recorded evidence; synthetic fixture runs are not live-agent certification. Unknown evidence neither inherits an earlier revision's verdict nor lifts quarantine.

## Verification scope

Tests cover a real local ACP fixture subprocess, streamed item lifecycle, profile mismatch rejection, overlapping-turn rejection, cancellation, profile membership/revert history, draft/queue round-trips, CLI framing limits and UTF-8 failures, migrations, discovery and conformance fixtures. These are synthetic agents. Live third-party agent credentials and a signed macOS build have not been exercised.

Discovery's in-process memo expires after one minute, including missing binaries and registry outages; the registry client still owns its 24-hour network cache. CLI tests also run real synthetic subprocesses: explicit failures and premature EOF stay failed, foreign turn IDs cannot settle or add content to another turn, and a process-exit-completed basic session cannot be reused. The contracts RPC group uses explicit type references so packaged declaration emission does not exceed TypeScript's inferred-type serialization limit.
