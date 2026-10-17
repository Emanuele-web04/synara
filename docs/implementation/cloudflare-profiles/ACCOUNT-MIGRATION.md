# Synara Orgs account migration

Status: diagnostics cut over on 2026-09-29 at 01:45 CEST; account API traffic
cut over at 02:14 CEST and profile links now redirect to Synara Orgs. API,
profiles, avatars and diagnostics are live in the destination. The original
API and diagnostics URLs remain as compatibility forwarders. Workers Paid
is active on the destination.

## Verified destination and scope

- Source account: Synara, `9f9caeb268766deda99bc580c775d50c`.
- Destination: Synara Orgs, `56e5b3e566be2fc8ade9b7d0eadf5e35`.
- Destination Workers subdomain: `synara-orgs.workers.dev`.
- The destination already contains `synara-marketing` and its
  `synara-marketing-cache` R2 bucket. Preserve both.
- Account renaming does not migrate services or change the Workers subdomain.

| Component                     | Migration action                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Beta diagnostics              | Redeploy its Worker/dashboard; copy its D1 database and private crash-dump R2 bucket                                          |
| Account API                   | Republish the container image into the destination registry; deploy the Worker, Container and its Durable Object binding      |
| Public profiles               | Deploy the existing OpenNext Worker and assets against the destination API                                                    |
| Avatars                       | Copy R2 objects with unchanged keys, content types and cache metadata; configure the new storage endpoint and public base URL |
| Marketing                     | Preserve the existing destination deployment and cache; verify the production site's analytics association separately         |
| Account database and identity | Keep the existing PostgreSQL/Supabase database and WorkOS project; preserve existing users and profiles                       |

These services share an owning Cloudflare account, while retaining separate
storage and access controls. Diagnostics remain private and Beta-only. Moving
infrastructure does not enable new telemetry or make diagnostic data public.
Remote tunnel implementation is a separate outstanding feature.

## Completed preparation

- Created destination D1 database `synara-beta-diagnostics`, ID
  `642c0f74-6a06-4433-ac72-728bd6d0ed39`, with a Western Europe location hint.
  Its final import contains all six source tables, including the migration journal.
- Created Standard R2 buckets `synara-beta-crash-dumps` and
  `synara-profile-avatars-trial`. Both contain the copied source objects. Crash dumps remain private; only
  the avatar bucket has public access, matching its original behavior.
  The creation UI selected Eastern Europe automatically.
- Prepared an isolated local diagnostics checkout at source commit
  `f917899ab4925fa35fd0a12c7e2fa7b58072e7c7` and a destination Wrangler config
  pinning the new account/database, with public and preview routes disabled.
- Verified the unchanged diagnostics app: 96 tests pass, TypeScript passes,
  Vite production build passes, and Wrangler 4.135.0 deployment dry run passes.
  Vite reports an existing large-chunk warning. A later focused fix preserves
  per-client ingest rate limits across Cloudflare accounts using a secret
  shared by the source forwarder and destination; spoofed relay headers are
  discarded. The forwarder also preserves the destination origin for `//`
  paths and does not follow upstream redirects. Updated checks: 101 tests and
  TypeScript pass.
- Wrangler device authorization now grants access to both accounts; Workers,
  D1 and R2 reads succeeded. Credentials are stored in the macOS Keychain.
  The Cloudflare MCP connector still exposes the old account in this session;
  the successful deployment path uses Wrangler and its authorized REST token.
- Source D1 exports and object backups are stored outside Git with restrictive
  permissions. Final cutover compared full ordered content hashes for every
  table: 1,559 events, 30 usage rows, five migration-journal rows, and zero
  `reports`, `crash_dumps`, or `issue_status` rows. The R2 smoke dump (2,048
  bytes) and uploaded avatar (3,884 bytes) have matching content checksums;
  HTTP and custom metadata are preserved. These are cutover counts, not live
  totals. The source database and buckets were retained.
- New diagnostics dashboard password/session secrets were generated privately;
  no old secret values were read back from Cloudflare. Login and secure
  session cookie checks passed. Anonymous dashboard reads return 401. The
  destination crash bucket remains private. A temporary ingest secret blocked
  writes until the final import verified; it was removed at cutover.
- Empty event batches pass through both old and new diagnostics URLs with 200.
  Replaying an existing client event through both URLs performs the database
  path without creating a duplicate. The real dashboard was opened and
  authenticated in Chrome, showing the migrated history.
  The old dashboard redirects to the destination with 308. The temporary
  cross-account probe Worker was removed after verification.
- Republished the unchanged API image into the destination registry with digest
  `sha256:cc29bdc4ac33d31dc64b5f093d13b6a1de0f8e9fb6775d8fda5ea3fdffe079d4`.
  Created the new API Worker/Container and profiles Worker. Supabase, WorkOS,
  signing and profile-proxy credentials were installed via secret bindings;
  the runtime avatar token was created after specific operator approval. The new
  API starts successfully, returns WorkOS instance metadata with 200, and
  rejects unauthenticated owner requests with 401. Public profile reads return
  200 for the existing user and 404 for an unknown handle. The existing session
  authenticates against the destination, and the copied photo loads from new R2.
  The API storage adapter performed a real signed S3 write of identical image
  bytes. API/profile cutover is complete; see READINESS.md for test limits.
- DNS and marketing resources are unchanged. The source API forwards to the
  destination; source profile links redirect there with 308.
  No credentials or exported user data have been added to Git.

## Prerequisites

1. Deployment-tool access is verified through Wrangler. Do not repeat OAuth
   setup unless it expires or permissions change. Retain old-account access
   for the compatibility forwarders.
2. Workers Paid is now active on the destination, verified after the operator's
   upgrade. This satisfies the Container plan prerequisite. The displayed base
   is USD 5/month plus usage, not a total cost cap.
3. Choose durable service origins before changing clients. For example,
   `diagnostics.trysynara.com`, `accounts.trysynara.com` and
   `profiles.trysynara.com` are proposed names, not deployed routes. Worker
   custom domains require an active Cloudflare zone. The domain currently uses
   Vercel nameservers; any DNS move needs a complete record inventory, including
   email verification records, before changing delegation. Account-local
   workers.dev URLs can be used to validate the new deployment first.

## Execution order and acceptance checks

1. **Record and back up the source.** Capture deployed versions, binding names,
   D1 table counts and migration history, R2 key lists, sizes and checksums.
   Store exports with restrictive local permissions outside Git. Recheck live
   counts at the actual cutover; documentation counts are not a live inventory.
2. **Prepare the destination.** Create fresh diagnostics D1/R2 resources and
   avatar storage, publish the API image and deploy the Workers. Install secrets
   through secret bindings only. Preserve the API signing/proxy keys during the
   transition where appropriate; recreate account-scoped storage credentials.
   Cloudflare cannot return existing secret values, so recover them from their
   authorized source or explicitly plan rotation. Restart/roll out the API
   Container after changing environment secrets.
3. **Validate before switching traffic.** Check API health, unauthenticated
   rejection, WorkOS login, profile editing, private/public/private transitions,
   social previews and avatar reads. Verify refresh tokens and logout/re-login
   against the destination. No destructive test suite may target the shared
   Supabase project. Verify the diagnostics dashboard requires authentication
   and crash dumps cannot be read anonymously.
4. **Transfer diagnostics consistently.** The diagnostics repository already
   includes export/import scripts and a forwarder. Review their safety before
   running them: require explicit account IDs, an empty destination database,
   safe object paths, complete pagination and checksum verification. First
   rehearse with a snapshot. For the final copy, briefly pause source ingestion
   with retryable responses, export the final D1/R2 snapshot, and import into an
   empty destination. Do not merge snapshots by integer event IDs. Compare
   every table count, migration history and object checksum before forwarding.
   The desktop retains failed event batches on disk, but its queue is bounded:
   keep the pause short and restore ingestion if validation fails.
5. **Preserve old clients and links.** Point the old diagnostics forwarder at
   the verified destination and test event/crash delivery through the old URL.
   Test rate-limit behavior behind forwarding. Keep old profile links usable.
   During avatar cutover, coordinate writes and perform a final object sync so
   old and new APIs cannot write to independent buckets against the same DB.
   Either route old API traffic to the new service or update its storage and
   configuration consistently; validate this path before removing old compute.
6. **Update configuration and delivery.** Update deployment account IDs, API and
   profile origins, CI variables/secrets, desktop defaults and documentation.
   Future Beta releases should embed the stable diagnostics origin. Keep the
   old forwarder for already-installed versions; a code edit alone cannot move
   them. Run repository-required checks for the affected code and live checks
   after deployment. Publishing a Beta release is a separate release action.
7. **Retire only after verification.** Preserve source backups and resources
   through validation. Remove duplicated compute and obsolete credentials only
   after traffic is confirmed on the new services and cleanup is authorized.

## Recovery

Before destination ingestion begins, a failed import can be abandoned and the
original diagnostics Worker restored against its untouched source database.
Once the destination accepts events, stop and reconcile those new records
before switching back; a blind rollback would lose or split diagnostic data.
After API cutover, new avatar writes belong to the destination bucket. Do not
restore the old API with its old S3 configuration: reconcile objects first or
configure recovery compute to use the destination avatar store.
The account API shares PostgreSQL across the transition, so use compatible
schemas and one authoritative avatar store rather than rolling back account
data. Retain the source deployment/image metadata until validation completes.

## References

- [Diagnostics migration reference](https://github.com/Emanuele-web04/synara-beta-diagnostics/blob/main/MIGRATION.md)
- [Current profile deployment evidence](READINESS.md)
- [Cloudflare Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)

## Operator checkpoint

Private backups and generated credentials are also saved with owner-only
permissions under `~/.local/share/synara-ops/cloudflare-migration-20260929` on
the operator Mac. The source data is retained. Do not blindly restore the
source now that the destination can accept new events.

The Synara checkout points future Beta builds at the new diagnostics origin;
this has not shipped in a release. Diagnostics desktop tests pass (26 tests),
and repository formatting, lint (zero errors; 792 existing warnings) and all
13 typecheck tasks pass. The diagnostics repository passes 101 tests and its
TypeScript/build checks. The initial sandboxed desktop run could not bind
loopback sockets; the authorized rerun passed. A scan of 57 changed/untracked
Synara files found none of the known deployment secret values.

Diagnostics deployment changes are recorded in [draft PR #2](https://github.com/Emanuele-web04/synara-beta-diagnostics/pull/2),
branch `codex/synara-orgs-migration`, latest commit `ce80fc9`. It is not merged.

### Account/profile completion

The final avatar snapshot and cutover evidence are saved beside the diagnostics
backup. The new runtime R2 key and API-forwarder secret have owner-only recovery
copies outside Git. Source storage and compute metadata are retained; the old
API Container receives no traffic through the compatibility bridge and retains
its existing 30-minute idle policy. No source resource purge was performed.

Normal deployment configs target Synara Orgs. Compatibility endpoints are
explicitly configured in `apps/api/wrangler.legacy.jsonc` and
`apps/profiles/wrangler.legacy.jsonc`; do not use those for normal deployments.
The same `MIGRATION_PROXY_SECRET` must remain installed on both API Workers.
Changing API secrets requires a Container restart/rollout to load them.

The account API and profiles GitHub deployment workflows still require their
Cloudflare and application secrets: `gh secret list` showed only Apple signing
secrets. No CI token was copied from the local interactive OAuth credential.
Live hosting works independently of those future workflow settings.

### Branded subdomain

The operator requested removing their personal account label from public URLs.
Cloudflare reported `synara.workers.dev` unavailable; the operator selected
`synara-orgs.workers.dev`, and the account subdomain was changed in the dashboard.
All four Workers inherit that suffix, including the existing marketing Worker.
Its code and storage were not redeployed. API/profile origin variables, legacy
forwarders, desktop diagnostics defaults and the diagnostics PR were updated.
The previous personal-label Workers URLs stop routing after this account rename.
The original `kartik-9f9` compatibility endpoints point to the branded origin.

Final code checks: formatting passes, lint has zero errors (793 warnings),
all 13 typecheck tasks pass, and Actionlint accepts both deployment workflows.
The full workspace test run passes all 12 tasks with the real database URLs
removed: 197 PostgreSQL-dependent API tests were skipped in this run. Their
previous disposable-PostgreSQL qualification is recorded in READINESS.md.
Focused post-rename tests pass: 17 API ingress/storage, six profiles and 26
Beta diagnostics tests. The diagnostics repository passes 101 tests and typecheck.
A scan of 63 changed/untracked Synara files found no known deployment secret
values. No new UI components were introduced; existing API, profile UI and
storage code were reused, with small compatibility Workers for old URLs.
