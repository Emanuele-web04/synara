# Cloudflare Remote — execution state

## Pairing follow-up — 2026-10-15, evening

- A concurrent token refresh could make an older successful `/me` response report
  signed out even though the account credentials were still valid. Status now
  accepts a rotated token only for the same verified user, organization and
  account authority; legacy identity backfills still require the original token.
  The regression failed before the change and passes now. Logout, user changes
  and authority changes remain fenced; 110 focused account/pairing tests pass.
  Workspace formatting, lint and twelve-package typecheck pass (existing lint
  warnings remain). This fix is not in the installed Remote .2 apps yet.
- The iPad PR #2 was merged into the existing iOS remote-connections branch,
  without merging that branch into main. iPad sidebar/rotation and two iPhone
  workspace UI flows pass. Native sign-in consent now displays Synara; the light
  icon uses the current vector at the dark icon's scale. No paid WorkOS custom
  domain or service was enabled.
- Real-account simulator sign-in and fresh-code enrollment to the installed
  Mini succeeded. The first remote enrollment exposed a separate mobile bug:
  successful trust installation did not mark onboarding complete or resume
  foreground reconnect. The mobile fix is being verified before upload.
  MacBook account directory/grant and pinned TLS/inner pairing channel passed;
  actual simulator enrollment to that host remains to be checked. None of this
  establishes production TestFlight APNs delivery on a physical iPhone.

## Installed-app qualification follow-up — 2026-10-15

- Synara Remote was installed beside the existing apps on both Macs. Read-only
  snapshots and message-by-message comparisons verified the imported local
  histories; account credentials and host/device identities were not copied.
  Both apps completed normal same-account Google sign-in and a real Codex reply.
  The Mini also passed Stop, follow-up and renderer reload with preserved history.
- The Mini's manual import initially put its usage checkpoint under `userdata`,
  causing an unintended historical backfill under the new installation identity.
  Account reporter state belongs directly under the packaged app's base directory
  (`usage-sync`), or under `dev` when a dev URL is configured. The duplicate target
  counters were backed up and zeroed within their verified account/environment
  scope; source counters and local history were preserved. A private disposable
  replay reproduced the misplaced-checkpoint backfill and verified no upload
  across repeated reporter starts with the correctly placed checkpoint. New real
  activity then uploaded without another historical backfill. This operator
  repair does not add per-account local conversation ownership; see [account
  switching semantics](../../../BETA.md#synara-remote-early-access).
- A controlled backend restart in installed version **1.0.6-remote.1** exposed a
  separate recovery defect: the replacement backend chose a new port while the
  renderer retained its pinned endpoint. The desktop now keeps its reserved port
  throughout the app lifetime. The existing fresh-profile Electron smoke now
  terminates only its own backend, waits for a replacement PID and healthy HTTP
  endpoint, and asserts that the port is unchanged. It failed on the old code for
  the changed endpoint and passed after the repair. No transport unpinning or
  renderer reload was added. The signed, notarized **1.0.6-remote.2** candidate
  (`a556ebf4238206ccf033158056027d86580fe45b`) passed
  [all build gates](https://github.com/Emanuele-web04/synara/actions/runs/38783573115)
  and is installed on both Macs, with the previous app retained for rollback.
  Both installed apps survived a controlled backend restart in the same window:
  replacement PID, unchanged port, preserved unsent draft, automatic reconnect
  and a real Codex reply without renderer reload. All 207 original Mini messages
  and 1,733 original MacBook messages remain unchanged; the Mini's 213 messages
  present immediately before this update also compare identically. Subsequent
  cloud reads show unchanged historical counters and only the new test activity.
  Account and host/environment identities were preserved across the update.
  This remains a build-only candidate, without a public release or updater feed.
- The final local workspace run passed **18,188 tests / 275 skips** across all
  eleven test tasks. A first parallel run hit one five-second web test timeout;
  that case passed in isolation and the second full run passed unchanged.
  Formatting, lint, twelve-package typecheck and Windows runtime checks passed.
- Apple Developer inspection found the Synara APNs key is topic-specific and
  **Sandbox only**. The deployed `both` gateway setting does not expand its
  authorization. The API now accepts an optional, separately validated
  `APNS_PRODUCTION_PRIVATE_KEY` / `APNS_PRODUCTION_KEY_ID` pair, forwards both
  Worker secrets, and keeps JWT signing/cache separate by token environment.
  The real-signature transport regression and configuration/forwarding checks
  failed before the fix and passed afterward. All **370 API tests** passed on
  a new disposable PostgreSQL database; lint/typecheck/format also passed.
  No schema change is required. With explicit operator approval, the separate
  topic-specific Production key is now created and installed in the two Worker
  secrets; all 23 previous secret names remain present (25 total). Existing
  Sandbox credentials are unchanged. The protected local key copy stays outside
  Git and Downloads; a scan of 9,684 repository files found no matching material.
  Worker `7793d785-432d-4c88-927b-7d1863a4ce2f` and Container version 21 now run
  image `sha256:cee7fc90fa39e989303a904b9494a3c59c95bdf86bcdd06412594ac58f7a02a1`.
  The new instance is running and its protected Live Activity route returns 401
  without credentials. All 23 database migrations are unchanged.
  An APNs Production probe using a nonexistent synthetic device token returned
  `400 BadDeviceToken` with the valid signer and `403 InvalidProviderToken` with
  an intentionally invalid signature. This verifies the Production credential,
  not device delivery. Visible background update/end on TestFlight remains the
  physical-device qualification step; no new mobile build is required.

## Early access delivery — 2026-10-15

- Qualified desktop source `8505590cfe40c58660171a3a778976ef6cccdd39` is pushed.
  The final workspace run passed 18,396 tests with 43 skips; format, lint (zero
  errors), twelve-package typecheck and migration lineage checks also passed.
- Published the API Container image
  `sha256:b731a83aac3af2abc4215fdf7c1ce6f72c6250521dd7fe2c83b768b4b58f64dc`.
  Live startup returned the expected unauthenticated 401. Supabase now records
  23 Drizzle migrations, including additive `0022_account_deletions`; its new
  table has RLS enabled and no SELECT grant for `anon` or `authenticated`.
  All 23 Worker secret names were preserved. No real account deletion was run.
- API proof expiry fix `d8c84fa` passed 369 tests against a fresh disposable
  PostgreSQL database plus format, lint and twelve-package typecheck. Deployed
  image `sha256:6ff0b90add17f7cae58ce3f25496554f60d45f8f3ca814228d8cb2183258a735`
  as Worker version `73ec6657-61a8-4680-938c-fc194ee1d4a3`; live startup again
  returned the expected unauthenticated 401. `APNS_ENVIRONMENT=both` was installed
  before this rollout. Actual TestFlight APNs delivery remains unverified;
  deployment and startup are not delivery proof.
- Universal iOS/iPadOS version 0.1 (130) was exported with Cloud Managed Apple
  Distribution and uploaded successfully with the ordinary Xcode Apple ID.
  App Store Connect shows **Ready to Test**. The internal **Synara Early Access**
  group has manual distribution, version 0.1 (130) attached and one explicitly
  authorized internal tester. App Store Connect confirms that tester is **Invited**.
  No App Store Connect API key was created. External Beta review remains pending.
- Both native branches are pushed and validate all 86 fixtures against this
  desktop source. The final retained native checks passed 116 cases (one skip)
  on each simulator; the iPad docked-sidebar flow passed twice. The broader
  legacy native suite is not green; see the mobile handoff for retained gaps.
- GitHub Actions for the private SynaraIOS repository refuses hosted jobs before
  execution because of account payment/spending limits; iOS qualification and
  upload ran on the Mini. This does not block the public desktop repository's
  standard runners. The obsolete build-only Beta candidate was cancelled after
  the user requested a distinct app named **Synara Remote**. Its separate flavor,
  data home and updater lane are implemented through the existing signing
  workflow. Remote qualification passed 259 affected tests, twelve-package
  typecheck, lint (zero errors), formatting, Windows boundary and release smoke.
  The exact candidate `fa1c5e6db6904ee3c694fd9a495d4292f1571a8f`, version
  **1.0.6-remote.1**, passed [all CI gates](https://github.com/Emanuele-web04/synara/actions/runs/38767031101):
  18,168 tests passed and 295 were skipped by their existing CI routing; the
  database-backed API cases passed separately in the 369-test Mini run above.
  Developer ID signing, Apple notarization of the app/DMG, artifact provenance
  and packaged Mac ARM64 startup smoke all passed. The qualified installer and
  updater ZIP were downloaded on the Mini: source/lockfile provenance, all file
  hashes, Remote bundle/display identity, DMG signature, stapled Apple ticket
  and Gatekeeper acceptance passed locally. They are available in the [30-day workflow artifact](https://github.com/Emanuele-web04/synara/actions/runs/38767031101/artifacts/11990746436).
  This is a build-only candidate: no public release/update feed has been published.
  No new paid plan or spending limit was enabled.
  No desktop tag, main merge, signed Remote publication or external TestFlight
  review is claimed.

Updated 2026-09-29. Original base `42aa8fb4f093f78fe7a1f7be5525f67571086ebf` verified clean; existing isolated worktree `a816/synara`, branch `codex/cloudflare-remote-mvp`. Git emits known AppleDouble index warnings; branch creation succeeded (exit 0) after granting Git metadata access. No pack repair.

## Completion levels

- Implementation: complete.
- Local qualification: complete. See [QUALIFICATION.md](QUALIFICATION.md) for commands, evidence and limits.
- Live qualification: in progress. Real service configuration, same-account
  login, managed provisioning, two-Mac pairing and remote file reading have
  passed with a process-scoped DNS override during propagation. Controller
  restart and connector crash recovery now pass without manual reconnect.
  Normal DNS, live revocation and unattended qualification remain pending.
  See the dated entries.

## Phase ledger

| Phase                   | State                              | Evidence / remaining                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 owners and references | complete                           | Upstream comparison at `d15210cd3da79f9a1a495a6309d912d76362a046`, official Cloudflare API and limits; owner map below.                                                                                                                                                                                                                                                                                                                    |
| 1 account coordination  | implemented                        | Additive 0013/0014, immutable allocations, HostProof-only tokens, SQL leases/checkpoints, retryable cleanup and hourly retired-name sweep, same-account code rendezvous. API suite 318/318 passed, including delayed allocation-disable regression. Fresh WorkOS membership bypasses cache for provisioning/polling.                                                                                                                       |
| 2 connector             | implemented, Mac smoke passed      | Pinned official 2026.9.3, SHA256, dedicated loopback ingress, real readiness, cancellable provisioning/download, isolated home/config, shared process teardown. Actual binary launched/stopped from Electron app.asar (43.4.1 / Node 24.18.1). Focused tests and final browser E2E passed.                                                                                                                                                 |
| 3 dialer                | implemented                        | Explicit Cloudflare contract/labels and directory endpoint; no runtime relay fallback. HTTPS fixture transports pinned TLS, 512KiB hash/Range, RPC, resources and 4MiB backpressure burst. Substituted-root negative case passed in final E2E.                                                                                                                                                                                             |
| 4 revocation            | implemented                        | 10s jittered fresh snapshots, 60s lease; closes before durable tombstone/ACK. Real API device revocation tested through fixture. Async setup/teardown fencing; targeted allocation retirement prevents delayed cleanup affecting the next allocation.                                                                                                                                                                                      |
| 5 code pairing          | implemented, browser passed        | Atomic registered-device claim, budgets, expiration, same-account/org scope, preview stays server-side, compare full root and approve exact device. Browser flow passes on both screens. CLI private invitation remains available.                                                                                                                                                                                                         |
| 6 UI                    | implemented, visual evidence saved | Existing settings/button/input/checkbox primitives reused. Screenshots copied to durable task artifacts; see QUALIFICATION.md. No new UI primitives. First-use missing root no longer misleadingly requests repair.                                                                                                                                                                                                                        |
| 7 relay removal         | complete                           | Removed server/desktop relay config/fallback and Docker deployment workflow. Production API no longer exposes legacy relay credentials/tickets. Retired relay runtime, ticket/control contracts and API polling feed removed; ADR 0016 and operations guide replace old instructions.                                                                                                                                                      |
| 8 local qualification   | final pass                         | Final E2E 16/16, API 318/318, focused lifecycle 13/13, build 10/10, typecheck 13/13, lint 792 existing warnings / 0 errors, Windows boundary and migration lineage passed. Root rerun passed 11/11 tasks: 13,914 tests passed / 246 skipped; database and E2E cases passed separately. The discovered signal-exit / Effect shutdown interaction was corrected. The built test now verifies connector PID exit and rejects forced shutdown. |
| 9 live                  | not run                            | No real resources provisioned; needs secure test configuration and two-Mac access after local completion. Commercial rollout still blocked by absence of real subscription authority (explicit test allowlist only).                                                                                                                                                                                                                       |

## Owner map and implementation order

WorkOS login and host link (`accountAuth`, API `hostKeyRegistry`) → host-proof authenticated allocation (`apps/api`, PostgreSQL) → dedicated loopback ingress + cloudflared (`hostConnectivity`, shared platform process boundary) → account directory exposes managed hostname only → authenticated code rendezvous → existing exact-JKT owner approval and SQLite trust → API grant + pinned TLS host mint → session registry/RPC/resources → API authorization snapshot polling, tombstones and ACK.

Keep public Cloudflare TLS separate from host P-256 TLS1.3. Never forward local admin routes or controller credentials. Pairing cloud delivery changes the out-of-band trust assumption: code lookup alone cannot confirm a root. Existing environment/account/generation fences and server Beta/Stable policy remain authoritative. No new provider/model, account stack, iOS app, production deployment or commercial entitlement system.

## Active local services and next action

Disposable PostgreSQL is stopped. It used `/private/tmp/synara-cloudflare-postgres/data`, 127.0.0.1:58433. Personal instance 7265 was preserved. Final E2E process inspection found no fixture connector/server remnants. Git AppleDouble warnings remain unchanged.

During qualification, the final process audit found connectors surviving a signal-induced Node exit. The existing Effect patch now keeps signal ownership during asynchronous finalization. A subprocess regression and built-workspace PID assertions cover the correction. Older fixture remnants were explicitly terminated. No operator process was targeted.

Logs: `/private/tmp/synara-cloudflare-{tests,api,e2e,all-types,build,format,lint,windows,migrations,electron,shutdown}.log`. Durable screenshots and compact checks: `/Users/emanueledipietro-macmini/.codex/visualizations/2026/09/28/01a0e737-6f66-7340-a97d-eada9d6c3680/cloudflare-remote/`.

Delivery: implementation commit `39784a61da783548060a1ed062b4ed6d9a314e8d` is published on `origin/codex/cloudflare-remote-mvp`. Final format and frozen patch-install verification passed; the installed-runtime regression passed 11/11. Live phase 9 needs secure test-environment setup and access to both Macs; no live success is claimed. No main merge, release, production deployment or commercial rollout.

## Follow-up readiness review — 2026-09-28

Reviewed the completed task against the first real two-Mac setup, including the WorkOS token contract, managed tunnel allocation/ingress, connector packaging and lifecycle, pairing, revocation and deployment instructions. The current WorkOS application/session-token documentation confirms the required `client_id` claim; no authentication boundary was relaxed.

The review reproduced and fixed controller pairing recovery defects:

- A transient account-directory or tunnel failure discarded a redeemed preview before success. The server now retains it until success, cancellation/forgetting, account change or expiry; the public code remains single-use and exact identity approval is unchanged.
- Forgetting/cancelling did not release the pending preview. It now clears the local preview and the UI directs the user to a fresh code.
- Concurrent setup could run before the per-host guard, and cancellation could race an unfinished trust import. The guard now owns the entire setup, and forgetting waits for its cancelled operation to settle before deleting trust.

Four focused regressions cover retries, cancellation/preview capacity, identity/account/expiry checks and concurrent setup cancellation. The browser qualification now deliberately stops the connector after code lookup, observes the failed attempt, restores connectivity and completes pairing with the same reviewed preview. Existing settings primitives are reused.

Checks: focused regressions 4/4; PostgreSQL API 318/318; rebuilt desktop/server 5/5 build tasks; typecheck 13/13; lint 0 errors / 792 existing warnings; format passed. Full Node 24 E2E passed 16/16 in 79.53 seconds. The first E2E attempt ran under the shell's Node 26 and was refused by the intended runtime gate; it was rerun on Node 24.21.0 without weakening that gate. Final full repository suite passed with Node 24 and cache bypass: 11/11 tasks, 13,918 tests passed / 246 skipped, 305.53 seconds. Database/build-dependent skipped cases passed in the separate API/E2E runs above.

The disposable PostgreSQL instance has been stopped again. This review used logs `/private/tmp/synara-remote-review-*` and browser evidence `/private/tmp/synara-remote-review-evidence`. No external credentials were configured, no real tunnel was provisioned and no live/signed/two-Mac qualification is claimed.

Follow [Configure the remote MVP](READINESS.md) for the remaining service setup and live test. API hosting is still required alongside WorkOS, PostgreSQL and Cloudflare. Internal test enrollment remains distinct from commercial paid-entitlement enforcement.

## Supabase database selection — 2026-09-28

The selected stack is WorkOS AuthKit for identity, Supabase PostgreSQL for account
metadata, and Cloudflare Tunnel for remote transport. WorkOS tokens and session
flows are unchanged. The API continues using `pg`/Drizzle with a server-only
`DATABASE_URL`; no Supabase Auth, client SDK or third-party JWT bridge is needed.

Migration `0015_account_table_rls` enables default-deny RLS on all 15 account API
tables. This prevents untrusted database roles with table grants (such as
Supabase's Data API roles) from reading or changing rows outside Synara's API.
The database-owner runtime remains authoritative for WorkOS-scoped checks. The
new PostgreSQL regression verifies table coverage, denied reads/writes and
preserved access for a non-superuser table owner. No historical migration was
changed; the generated snapshot adds only RLS flags.

The API README, environment example and readiness checklist now cover Supabase
direct/session-pooler URLs, verified TLS/project CA, disabled Data API, database
ownership and isolation from automated-test fixtures. Future migration to another
standard PostgreSQL host remains possible.

Validation uses a disposable local PostgreSQL instance, not the connected
Supabase project. The first parallel API run raced while creating the empty
Drizzle migration table; applying migrations once before the test run resolved
that fixture bootstrap race. The full API suite passed 319/319. Workspace
checks and migration lineage are recorded with the completion report. Live
Supabase TLS, WorkOS and Cloudflare qualification remains pending service setup;
no hosted database or authentication settings were changed.

## Shared account service update — 2026-09-29

The profiles trial now has a deployed Cloudflare account API, verified Supabase
TLS/database role and hosted synthetic privacy checks. See
[profiles qualification](../cloudflare-profiles/READINESS.md) for current service
state; earlier no-resource statements describe the preceding remote-only work.
Real WorkOS login and the migrated account session have now been verified on
`synara-account-api-trial.synara-orgs.workers.dev`. Tunnel provisioning, remote
enrollment and two-Mac acceptance remain unverified. This deployment does not
mark remote access complete.

## Remote deployment review — 2026-09-29

The Worker was missing the five optional remote runtime bindings, so setting
them in Cloudflare would not configure the API Container. Its explicit
forwarding list now includes the four `CLOUDFLARE_*` tunnel settings and
`REMOTE_TEST_USER_IDS`. Container configuration tests cover forwarding and
the unconfigured case; unrelated Worker bindings remain excluded. The API's
existing config tests cover rejection of incomplete tunnel settings.

Live inspection found no zones or tunnels in Synara Orgs and none of those five
bindings on the API. The operator chose `trysynara.com` and deferred its DNS
move from Vercel. The website can remain hosted on Vercel. The
[readiness checklist](READINESS.md) records the remaining DNS preparation,
runtime token/enrollment, Container restart and two-Mac acceptance steps.
No live remote connection is claimed, and this code correction is not itself
a deployment or DNS change.

### Live Quick Tunnel transport proof

A disposable test on the Mac Mini successfully routed through a real Cloudflare
Quick Tunnel using the branch's `startCloudflareIngress`, `RemoteTlsServer`,
host gateway and `dialHost`. It exchanged an authenticated, native-TLS-encrypted
synthetic application frame. An incorrect pinned host identity and an
unapproved device were rejected; public admin paths returned 404. The connector
was stopped and fixture state cleaned up afterward.

The test used ephemeral fixture account grants and approvals, not a real
WorkOS session, and ran both endpoints on one Mac through Cloudflare's public
edge. It does not qualify the two-Mac UI flow, managed provisioning, pairing-code
delivery or unattended recovery. The normal app still needs managed tunnel
configuration; Quick Tunnel support is not wired into its pairing flow.

Initial attempts failed resolving the newly allocated hostname. Public DNS over
HTTPS returned the Cloudflare address while the Mac's normal resolver returned
NXDOMAIN. The passing test waited for public DNS publication and used that
resolution only inside its own process, with TLS verification enabled. No OS
DNS settings or domain nameservers changed. A user-facing temporary-tunnel test
also needs hostname resolution verified on the controller's network.

The forwarding fix passed workspace formatting, lint (zero errors; existing
warnings) and typecheck, plus 29 focused API tests and 19 server remote tests.
The live Quick Tunnel transport check passed separately. PostgreSQL-dependent
API tests and the two-Mac acceptance suite were not rerun for this deployment
binding change.

## Managed DNS activation — 2026-09-29

After the operator approved the exact nameserver change, Namecheap saved
`cecelia.ns.cloudflare.com` and `eric.ns.cloudflare.com` for `trysynara.com`.
The registry confirms the delegation and Cloudflare reports the zone active in
Synara Orgs. The full ten-record Vercel inventory was copied before switching;
website records remain DNS-only and point to the original Vercel destinations.
HTTPS checks returned 200 from Vercel and its project Analytics history remained
present. No DNSSEC DS delegation existed. No interruption was observed in these
checks; they are not continuous uptime monitoring or a mail-delivery test.

The zone's Free website plan is separate from the account's verified Workers
Paid plan. Some resolver caches initially retained the Vercel nameservers.
Direct DNS requests from this Mac returned recursive, not authoritative,
responses; do not treat them as direct checks of Cloudflare nameservers.

The tested Worker forwarding fix was deployed as version
`e4641bcd-79ef-43e5-93c4-5f54af5f1e89`, preserving the existing API Container
image and runtime secrets. Remote token creation, installation of all five
remote bindings, Container restart and real two-Mac acceptance remain pending.

## Remote service configured — 2026-09-29

The operator explicitly approved creating `synara-remote-tunnels-trial` with
no expiration, cloudflared connector write in Synara Orgs and DNS write limited
to `trysynara.com`. The token was stored outside the repository with private
filesystem permissions and in the account API's Worker secrets. A single bulk
secret update installed all four Cloudflare settings plus the one-user trial
allowlist, preserving unrelated secrets. Runtime-token verification, tunnel
listing and DNS listing succeeded; the DNS baseline still contained the ten
preserved website/mail records and there were no tunnels before testing.

Container rollout `e3b5f8d2-4e2d-46d4-8e4c-0a25987f7f9c` completed with one
healthy instance and no reported rollout errors. Public API discovery and JWKS
checks returned 200. This verifies deployment health, not managed provisioning
or a real remote connection.

The current branch's CLI and web build passed (four build tasks). A separate
Node 24 test instance runs on loopback port 4775 with its own home, after the
dev runner dry-run and IPv4/IPv6 listener checks. The older profiles test and
the regular Synara instance were left running. The new instance uses the
Synara Orgs API directly. The operator completed a fresh WorkOS login, the
machine linked successfully, and Hosts & devices exposes the pairing controls.
The new login selected a different WorkOS identity than the earlier profiles
test. After verifying it through `/api/v1/me`, the allowlist was replaced with
only the current Mini user; rollout `5ff927a9-475c-4a50-85a5-21aa798ee595`
completed and API discovery returned 200. The older profile session is still
bound to the legacy API URL, so it was not silently rewritten or copied to the
new installation.

The operator requested coordination with Codex on the connected MacBook. A
separate MacBook task prepared an isolated worktree at commit
`20b8f71b342f11532cc7caee4ef03a04fd6e7f52`, matching the Mini's application
sources, and passed the frozen-lockfile install and CLI/web build. Its Node
24.21.0 server listens only on `127.0.0.1:4776`, with a separate test home.
The MacBook task verified local UI and API discovery HTTP 200. The operator
completed login, and both machines' WorkOS user and organization IDs match.
The MacBook device thumbprint was independently recomputed from its public key
and matched the registered device. The operator explicitly approved pairing
that exact device with the isolated Mini instance.

Creating a pairing code through the Mini UI initialized its remote identity.
Synara automatically provisioned one named Cloudflare tunnel and its proxied
DNS record; Cloudflare reported healthy with four connector connections. The
ten existing website/mail records remained present. Cloudflare and Google
DNS-over-HTTPS resolved the generated hostname to Cloudflare, but the Mini's
system resolver still returned the old Vercel wildcard destination. A probe
using the public DNS result only within that process, with normal TLS
validation, returned 200 for `/health` and 404 for `/` and `/api/v1/instance`.
The normal system-resolution probe reached Vercel instead. This is a DNS
propagation limitation, not a passing normal-path remote connection. No OS
DNS setting or certificate validation was changed. The MacBook's normal DNS
path also reached Vercel. Its first code lookup returned the exact Mini root
and expected controller thumbprint, but UI navigation discarded the preview
before the access request. That invitation was cancelled on the Mini.

To continue transport qualification during propagation, a temporary preload
outside the repository limits a DNS override to the exact generated hostname
inside the MacBook test process. The Cloudflare address came from public
DNS-over-HTTPS; the MacBook's independent HTTPS probe returned 200 with normal
certificate validation. This workaround is test-only and does not qualify
ordinary DNS resolution.

A fresh code then completed the real two-Mac UI flow: the MacBook compared
every Mini identity group, the Mini approved the exact operator-confirmed
device thumbprint, and the MacBook reported successful pairing and connection.
The Mini displayed the authenticated MacBook session with Cloudflare transport.
From the MacBook editor, the operator's coordination task opened a disposable
project and read the exact random proof value from a file created only on the
Mini. No provider request was sent. Approval survived a Mini page reload.
After that read, the MacBook renderer remained on `Connecting…` and the Mini's
active RPC session disappeared before any intentional connector interruption.
The unchanged connector and public health endpoint remained healthy. A separate
authenticated controller bridge remained open for 60 seconds, with successful
requests at 0, 20, 40 and 60 seconds. Wire evidence identified the cause: the
remote renderer subscribed to `device.subscribeEvents` and
`computer.subscribeEvents`, which the host correctly rejects as local-only.
Those stream failures triggered a global renderer reconnect. The controller
observed `Renderer detached` closures, without a transport error. The web
adapter now skips these two subscriptions in remote execution while retaining
them locally and preserving the server-side denial. The regression failed
before the change, and all 90 focused adapter/transport tests pass after it.
The rebuilt MacBook UI remained connected for over a minute, with no further
renderer-detached loop. The controlled connector interruption then exposed a
second defect: cloudflared restarted automatically, but the MacBook remained
connecting beyond the 120-second observation window. Its durable desired host
and connection view were `stopped`; a temporarily missing published route had
been classified as terminal. Missing routes now use bounded reconnect backoff,
while revocation, identity, authentication and compatibility failures retain
their existing handling. A supervisor/registry regression fails before this
change and passes after it.

The controller restart check found a separate lifecycle defect. Runtime
instrumentation showed its remote supervisor starting and stopping two
milliseconds apart: `Effect.provide` closed the handler layer when the HTTP
factory returned. Handler provisioning now belongs to the router layer, whose
scope lasts until server shutdown. After rebuilding and restarting the
isolated MacBook controller, the existing page reconnected automatically and
read the Mini's proof file again, with no reload, `hosts.connect`, or pairing.
The built-workspace E2E now waits for restored connections before any manual
action and no longer reloads the page after controller restart; it passes.

A second live interruption forcibly terminated only the isolated Mini's
cloudflared process at 11:57:58.574 UTC. Synara replaced it automatically.
The MacBook recorded socket closure at 11:58:04.343 and a restored connection
at 11:58:07.715: approximately 9.1 seconds from termination and 3.4 seconds
from the observed close. A subsequent authenticated file read matched the
Mini's proof. No retry button, page reload, manual connection, or new pairing
was used. These timings are one measured trial, not a recovery guarantee.

Final checks: format, lint (792 warnings, zero errors), typecheck (13 tasks),
CLI/web build (4 tasks), 90 adapter/transport tests, 55 lifecycle/auth/host
tests, and the strengthened built-workspace E2E passed. The first full suite
passed all 12 tasks; subsequent full runs on the recovery changes passed 11
of 12, failing the unchanged `accountCredentialLock.test.ts` real-process
contention test with `ENOTEMPTY`. Its isolated rerun passed 3/3; the final
full suite is therefore not reported as green. Database/E2E cases skipped by
the ordinary root run are not included in its passing count. The E2E used a
disposable local PostgreSQL cluster, now stopped.

Live revocation has not been performed: automatic approval review required
separate operator consent for interrupting the approved device. The key
remains approved. Ordinary DNS, sleep/wake, authorization-outage behavior and
long unattended qualification also remain incomplete. This is not a signed
distribution or an unattended reliability result.

The newly installed official `cf` CLI (`1.0.0-beta.5`) is authenticated to
Synara Orgs with read-only OAuth scopes. A DNS listing through this CLI matched
all ten baseline records exactly, including DNS-only website CNAMEs. Runtime
tunnel writes use the separate scoped service token, and deployment operations
use the existing authorized deployment credentials.

## Multi-host navigation — 2026-09-29

The previous whole-window host selection is replaced by a local controller shell with a combined
project/chat sidebar. Each verified remote environment retains a separate application runtime;
chat navigation changes the visible pane, not the destination of pending operations. The built
Chromium test passes with identical IDs on both servers, separate local/remote drafts, approval
routing, connector and controller restart, and local use after remote refusal. This uses the
deterministic provider fixture, not a real provider account.

The existing transport/pairing and per-environment storage boundaries are reused. The sidebar
uses the shared sidebar, button, disclosure and status components. A remote workspace is a
same-origin frame loading the bundled app; no provider/repository content creates frames.
File-backed Electron and large numbers of connected hosts remain separate qualification steps.
The MacBook browser UI result is recorded below. No DNS, Cloudflare, trust, provider-choice or database change is
part of this renderer update.

Validation: root formatting passed; lint reports 0 errors and the unchanged 792 warnings;
typecheck passed 13/13 tasks; desktop/server build passed 5/5 tasks. The complete repository
test run passed 12/12 tasks with the isolated PostgreSQL database. The separately built browser
workflow passed in 22.42 seconds, including new-chat buttons on both projects and keeping the
local composer usable during the remote connector outage. A first unfiltered build encountered
the sandbox's port-binding restriction in the unrelated profiles/Turbopack build; the relevant
desktop/server build above completed.

### Two-Mac project/chat navigation follow-up

The MacBook browser test initially exposed a creation race: activating a hidden remote pane at
its previous Home route could supersede creation in the selected remote project. Commit
`59922f0` returns the exact destination from the owning workspace and only then opens that route.
Catalog project opening uses the same ordering; late completion after an account/connection
change cannot select a stale workspace. Ready panes no longer leave an obscured "Opening…"
status in the outer accessibility tree, and connection failures name the affected computer.

After rebuilding the isolated MacBook controller at `59922f0`, the live browser check passed:
local chat → remote new-project "+" → correct project heading → Mini README, without using the
inner project picker. A fresh disposable Mini project had no existing chats/drafts before the
check. Separate local/remote drafts survived navigation in both directions. Earlier reads also
verified distinct README contents for the same filesystem path on the two computers. The
controller retained login/pairing and served the verified rebuilt index. No real provider prompt
was sent and the approved device was not revoked.

Follow-up validation: formatting, lint (0 errors / 792 existing warnings), typecheck (13 tasks),
desktop/server build (5 tasks), and 38 focused tests passed. The strengthened built Chromium
workflow passed in 17.96 seconds, including remote creation from an active local draft, Files
in the selected remote project, distinct drafts, streaming/approval fixtures and connector/
controller recovery. The full repository run preceding this focused follow-up passed 12/12
tasks. The disposable test PostgreSQL instance is stopped. The live MacBook controller continues
to use its process-scoped DNS override; ordinary DNS and signed Electron distribution are not
qualified by these browser checks.

### Computer and project pickers — 2026-09-29

The first combined sidebar lacked an explicit destination picker for a new chat, a project-name
field, and source-folder browsing in a browser. The follow-up adds a shared computer picker in
unsent chat controls and Create project, reusing existing menus, dialog fields, folder browser,
project-create recovery and ownership boundaries. Local/remote drafts remain separate. The source
folder resets when the selected computer changes; unavailable connections cannot silently fall back.
A remote create uses its host's settings and an explicit unassigned Space rather than local IDs.

The built browser workflow passes (23.37 seconds): choose a computer in both directions, preserve
project drafts, browse/select a remote folder, create a custom-named project, verify it exists only
on the remote server, then run the existing streaming, approval and recovery fixtures. It exposed
and covered two additional UX defects: deferred composer focus closing a newly opened computer
menu, and a slow initial folder listing overwriting a manually entered path. Eight focused browser
tests pass, including the delayed-listing regression. Final repository and physical MacBook results
are recorded after this entry. These changes add no provider prompts, secrets or infrastructure.

Automated final pass at `9163d31`: full repository suite 12/12 tasks passed in 321.9 seconds;
web suite 4,262 passing tests; formatting passed; lint 0 errors / 791 existing warnings;
typecheck 13/13 tasks; desktop/server build 5/5 tasks. The eight focused Chromium tests and
23.37-second two-server workflow passed separately. The updated E2E source also typechecks.
The disposable PostgreSQL cluster is stopped. No Windows process boundary or migration changed.

The physical MacBook browser check also passed at `9163d31`: Run on selected the Mini and returned
to This computer; both menus stayed usable. Create project accepted a custom name, browsed a
folder present only on the Mini, and opened its README with the expected proof marker. A separate
read-only RPC check on the Mini confirmed that project's name and canonical folder. The existing
paired connection briefly showed Reconnecting during startup and recovered without intervention.
No enrollment, DNS, provider prompt or device-revocation change was needed. The browser preview
is left on the new Mini project; this is not a signed desktop release. The existing process-scoped
DNS override remains in use, so this check does not qualify ordinary DNS resolution.

A controlled unsent-draft check on the MacBook retained a harmless test marker on the same
local route through MacBook → Mini → MacBook and a normal browser reload. Returning from a
project-specific draft via Run on selects the destination computer's home draft; it does not
move that project's text. The earlier observation of an empty composer was a different draft,
not a reproduced loss. GitHub cloning still targets the local computer; remote project creation
uses a source folder on the selected computer.

One live reconnect limitation remains: after the controlled reload the Mini pane briefly reported
`fetch failed` although Settings subsequently showed Connected over Cloudflare. The existing Retry
action restored the project and its README without restarting or pairing again. Its cause was not
diagnosed; the picker and draft results above do not establish seamless live reconnect on every reload.

### Unified sidebar follow-up — 2026-09-29

The earlier combined runtime still appended a separate section for each computer, including empty
remote folders and technical Home/Studio containers. Projects now share one list across computers,
with environment-qualified manual order and the existing date sorting. Chats, Studio, Pinned, and
Activity merge their respective remote rows. Empty remote folders stay out unless pinned or active.
Same IDs, paths, or names on different hosts do not merge ownership. Revealed subagent families stay
together and respect the existing pinned-parent exception.

The project row content is extracted from the existing local row and reused remotely. Thread rows,
provider icons, status glyphs, disclosure motion, and paging reuse existing components. Redundant
server icons, the footer/global host control, and the remote “Local chats” bar are removed. The
computer name appears on a project or top-level chat and in the active chat header. Embedded panes
share only the controller's sidebar controls, so the collapse/reopen button is unique and operates
the real sidebar; execution clients and stores remain isolated.

The reference review used the installed Codex bundle's sidebar/device-picker components and
the recorded upstream main `d2c9281b81`. Both retain host-qualified identities while allowing a combined
project/task view. No external source code was copied into Synara. Synara retains its own classic
and Activity views. Remote mutation menus and cross-host keyboard cycling remain follow-ups; the
outer remote rows expose navigation and project chat creation, and never invoke local mutations.

During validation, the built browser caught an empty-path branded-ID failure at remote Home; the
publisher now guards the empty route. The compiler regression caught an incompatible manual memo;
the paging derivation now allows React Compiler to manage its memoization. Neither issue was left
as an accepted failure.

Validation for `65021d0`: formatting passes; lint has 0 errors and 790 existing warnings; typecheck
passes 13/13 tasks; the complete repository suite passes 12/12 tasks with disposable PostgreSQL.
The sidebar compiler guard and ten Chromium component regressions pass. The final built two-server
browser flow passes in 24.22 seconds, covering unified rows, Activity routing, same-ID isolation,
independent drafts, remote files/terminal/attachments, approvals, connector/controller restart,
refused remote access, local recovery, and sidebar collapse/reopen from the remote pane. These
provider checks use a deterministic fixture. The disposable database has been stopped.

A small rendering follow-up keeps the new remote row components eligible for React Compiler and
adds them to the existing compiler regression guard. The sidebar-control bridge publishes after
layout commit instead of writing its ref during render. Formatting/lint/typecheck and the compiler
guards pass; the rebuilt two-server workflow passes again in 23.01 seconds. No runtime API or data
schema changed in this follow-up.

Physical MacBook status: the isolated controller was rebuilt at `eae747b`; its served HTML matches
the freshly built web/server artifacts and its health/projection checks pass. The existing account
session had a durable uncertain-refresh marker predating this rebuild, so it correctly reports
signed out. Credentials and device pairing were not reset or bypassed. The Mini remains signed in.
The normal sign-in dialog is ready on the MacBook. Mixed-host navigation on this exact live build
still requires the operator to complete sign-in; the passing two-server fixture is not a substitute
for that remaining physical-device check. The installed app and primary checkouts were untouched.

### Internal agent MCP routing — 2026-09-29

Implementation `ac27fd7` closes the gap between the combined sidebar and the provider-session
MCP gateway. `synara_list_connections` discovers the executing server and its paired outgoing
connections. Existing project/thread tools accept an explicit `environmentId`; local remains
the default. Results and wait/read continuations retain the owning environment. Remote calls
reuse paired TLS, caller runtime/worktree limits, and durable creation/recovery; no provider
bearer is forwarded. External MCP integration grants remain local and unchanged. See the
[agent-tool boundary](../../remote-connections-v2.md#agent-tools-across-computers) for supported
operations and cross-computer completion/automation limitations.

Validation: formatting passed; lint 0 errors / 790 existing warnings; workspace typecheck 13/13;
final full repository tests 12/12 tasks (server 6,778 passed, 26 intentionally skipped). Focused
provider-policy and delegation regressions passed 337/337, and the JSON contract checks passed
12/12. The final rebuilt two-server browser flow passed in 26.33 seconds, including actual
provider-scoped MCP discovery, listing, reading, provider discovery, idempotent creation,
rename, message dispatch and wait over the paired transport. It keeps a colliding local ID
untouched and verifies test-turn cleanup. The provider in this fixture is deterministic.
The disposable PostgreSQL server is stopped.

Both isolated physical-Mac servers were rebuilt/restarted at `ac27fd7` after confirming no active
chats, preserving their homes, login and approved pairing. The MacBook now reports signed in;
the earlier sign-in prerequisite above has been satisfied. A read-only `agentGateway.call` from
the MacBook over the existing Mini bridge listed three threads and read the existing test chat
successfully. This physical check used the real local caller's metadata and read capability;
it did not submit a new model prompt, create a task, or alter messages. One bridge negotiation
returned HTTP 503; a fresh negotiation succeeded without reconnecting or re-pairing the host.
That transient transport failure remains an observation, not a claim of seamless reconnect.
The physical RPC check and provider-fixture MCP check establish different parts of the path;
they do not qualify a signed release or every live provider.

### Automation and remote surface audit — 2026-10-09

Six focused read-only audits reviewed tasks/boards, automation scheduling, projects/Git,
runtime tools, Hubs/Inbox/reviews and the agent gateway. The implementation reuses the
existing computer picker and per-owner workspace frames:

- Automation creation selects the execution host; its project, model and persisted scheduler
  stay on that host. The combined automation panel retains owner-qualified navigation.
- Tasks, Kanban, Inbox and Code review expose a computer selector. Selection opens that
  owner's overview, without copying foreign project/thread IDs or filters. List/board
  navigation preserves ownership; existing tasks are not transferred.
- Remote MCP creation no longer attempts a host-local principal lookup for the foreign
  replay identity. The source server still checks coordinator/worker restrictions;
  destination project, privilege, active-turn and replay checks remain in force.
- The Codex fixture now reads its thread-scoped MCP credential from the private protocol
  config, not a removed environment variable. Credentials are not logged or re-exported.

Qualification uses two built servers, disposable PostgreSQL, Chromium and deterministic
provider/Cloudflare/WorkOS fixtures. All three browser scenarios pass in their final runs:
remote chats (33.45 s), automations, and Tasks/Kanban surfaces. The last two explicitly
finish host-owned work after the controller process exits. Project IDs deliberately
collide across the servers. The surface test fails on the previous build at the missing
picker, and the real MCP creation test failed before the principal-lookup repair.

The long chat scenario also required updating a stale folder-button accessible name in
the test; no production UI was changed to make that assertion pass. Direct web/server
builds, formatting, lint (950 warnings, zero errors) and all 12 typecheck tasks pass.
The repository-wide test command remains recorded as failed: a desktop driver test hit
its two-second timeout and interrupted the server package. That exact desktop test
passes alone (518 ms); the completed web package passed 5,286 tests. The separate full
server run passes all 8,372 tests (609 files, 27 tests intentionally skipped) in
480.41 seconds. These follow-up passes do not rewrite the original full-command failure.

No production migration, deployment, signed build or physical-Mac installation is part
of this audit. The temporary PostgreSQL server is stopped. Remaining feature gaps are
documented in [Remote surface audit](../../cloudflare-remote.md#remote-surface-audit-2026-10-09):
remote GitHub provisioning, aggregate Hub status/navigation, tracked dev-server preview,
native computer/browser/device control, and remote MCP automation/Kanban delegation.

## 2026-10-09 — APNs development implementation and qualification boundary

Scope: ActivityKit updates/end for an already-started iOS activity while the app
is suspended, including subscribed turns on multiple owned hosts. Not ordinary
notification delivery or push-to-start. Local implementation is on
`codex/cloudflare-remote-mvp`; matching clients are in the existing iPhone and iPad
worktrees. No new UI primitives, model changes, key material in Git, physical
phone use, or destructive database operations.

MacBook configuration handoff reports all five APNs secrets installed on
`synara-account-api-trial` in Synara Orgs, with all 16 pre-existing secrets
preserved. Configuration is Sandbox only. The replacement key remains outside
Git; the unused exposed key was revoked by that chat with specific user consent.
This ledger deliberately contains no private key/token values.

Implementation: authenticated ActivityKit registration/rotation, session/device
and host-generation fences, two additive default-deny RLS tables (migration
0021), durable coalesced APNs delivery, exact-turn host reporting, HTTP/2 ES256
sender, Worker-to-container secret forwarding. Background payloads use generic
titles. iOS transport suspension does not itself mean turn completion. Existing
account, identity, activity renderer and native lifecycle code are reused.

Checks so far: iPhone and iPad Debug simulator builds passed; four existing iOS
Display Island lifecycle tests executed and passed. iPhone app launch and Inbox
rendering verified on the Mini simulator using Device Hub. The unsigned test
build initially could not read Keychain; rebuilding with ad-hoc simulator signing
restored the existing account without a new login. The simulator and current
Mini Dev use different accounts, so their remote access remains isolated. The optional browser
mirror download failed TLS certificate validation; no verification was disabled.

With explicit operator approval, migration 0021 was applied to the live Synara
Supabase project on 2026-10-09. Both tables are owned by `synara_account_api`,
have RLS enabled and deny public client roles; the original Drizzle hash and
timestamp were verified. Worker/container deployment completed as version
`a9611fbf-fa9c-4298-b53d-4bcb7459ae69`, image digest
`sha256:c6287a5f3bbfafbbe448cdc13b59ee09d3563f1b01fbb0c2db029a777f3cbb33`.
After the asynchronous container rollout, `/health` returns 200; unauthenticated
`PUT /api/v1/live-activities` and host watch requests return 401, proving that
the configured routes are live and protected (not the former 404). The deployed
activity table still has zero registrations: actual Apple delivery, background
push rendering/end, Production key and TestFlight remain unqualified. Mini
Wrangler's TLS failure was isolated to local Node 26; Node 24 LTS refreshed the
existing Keychain-backed OAuth session and deployed without disabling TLS. Local PostgreSQL checks use only the
throwaway database on port 58439. Secret installation and HTTP health alone must
not be presented as APNs success. See the operations guide for poll intervals,
expiry, retry limits and the separate live qualification steps.

Final local evidence for this pass: root `bun run test` passed all 11 packages
(server 8,375; web 5,286; desktop 1,413; API initially 358). The final API pass
after widget-state and expiry regressions passed 361 tests against disposable
PostgreSQL; reporter tests passed 3/3. The widget-state regression failed first
on lowercase host protocol states, then passed after mapping to the actual Swift
ContentState values. `fmt:check`, `lint` (zero errors), `typecheck` (12/12), and
`migrations:check` passed; both mobile diffs pass whitespace checks. Existing
skips and lint warnings remain. These are local checks, not production/APNs proof.

### 2026-10-10 — Real Sandbox delivery on the Mini simulator

The earlier account/enrollment blocker is resolved. With operator approval, the
simulator signed in with the Mini's account and paired through the Cloudflare
tunnel after comparing its pinned root fingerprint. Existing trial accounts were
preserved using the optional cumulative `REMOTE_TEST_ADDITIONAL_USER_IDS` binding.
Worker `bee3ac73-c7fa-486f-8355-9278336d158a` and container image
`sha256:f815437c085f016b0f5bada7f9a597dca7a28a6ac3bf717730530b014d251fce`
are deployed. A second rolling restart was needed to load the new environment;
the Mini test instance also restarted after its earlier authorization denial.

Both mobile targets now include their existing APNs entitlements in simulator
builds as well as device builds. Both Debug builds pass. On iPhone 18 Pro / iOS
27 Simulator, a real provider turn requested only `sleep 45`; approval was given
from desktop while iOS stayed in the background. ActivityKit registered a real
update token, the live outbox recorded accepted APNs updates, and simulator
`liveactivitiesd` recorded Apple push reception at 00:19:47, 00:19:56, 00:20:34
and 00:21:22 CEST. At 00:21:22 ActivityKit processed the remote end event and the
lock screen visibly changed from approval needed to Ready without reopening
Synara. The activity disappeared automatically after the configured 60-second
dismissal. No `simctl push`, database state injection, or physical iPhone was used.

This qualifies the single-host Sandbox path, not Production/TestFlight,
multi-host concurrent activities, revocation during delivery or network-loss
recovery. Low-priority intermediate pushes may be coalesced by Apple; acceptance
does not establish instant visible delivery of every intermediate state.
The final cumulative-enrollment Worker tests pass 12/12; final `fmt:check`,
`lint` (zero errors) and `typecheck` (12/12 packages) pass.

## 2026-10-15 — Early-access preparation and test audit

Integrated desktop main `566efb1` through merge `e2c1c19`. The account API and
clients now contain confirmed self-service erasure: an additive private queue
(`0022_account_deletions.sql`), immediate access/host fencing, retried provider
and account-scoped cloud cleanup, and preservation of local computer history.
Desktop confirmation pins both the user and account authority. A regression
with the same user/email at another authority first reproduced one unwanted
request, then passed after rejecting the stale confirmation before network I/O.
All 70 account-session/RPC cases pass. No real account was deleted.

APNs configuration supports `both` alongside the existing single-environment
modes. Registrations still store exactly Sandbox or Production and delivery
selects the fixed matching Apple gateway. SQL-backed restart tests and HTTP/2
boundary tests pass; they are not live Production delivery proof. Deploy the
compatible API before changing the current Sandbox setting.

The audit retained security, migration and transport recovery contracts. It
strengthened two weak API tests (same-user cross-organization uniqueness and
non-enumerable error redaction) and replaced the migration fixture's pooled
connection with an awaited dedicated connection before dropping its temporary
database. This fixes a reproduced unhandled teardown error without ignoring it.
The final root suite passes all 11 packages: 18,396 tests passed, 43 skipped.
Format, lint (zero errors; 1,009 existing warnings), typecheck (12 packages) and
released migration lineage checks pass. Tests used disposable local PostgreSQL.

The phone/universal audit removes 640 net production lines, 42 obsolete native
cases and two nonfunctional performance cases. Unreachable transport helpers,
synthetic image ingress, retired loading state and an unused mention parser
are removed. Live reasoning/punctuation regressions are fixed; the shipping
file-mention tokenizer is unchanged after checking its rendering consumer.
The Core suite passes 313 cases; final focused native coverage passes 116 cases
(one fixture skip); current workspace UI flows and iPad docked-sidebar tests
have separate simulator evidence. All 86 Swift/desktop fixtures match. The broad
native suite still requires old Git/skill/composer fixtures to move to modern
owners; it is not represented as fully green. See the mobile handoff.

Publication boundary: these changes are branch code, not a new cloud deployment
or distributed app. Migration 0022 is not applied live; Production APNs, Apple
upstream token revocation, and provider-side personal-organization retention
remain unqualified. App Store Connect now has the Synara mobile app entry, but
the local Release archive is development-signed and App Store export requires
ordinary Apple-ID distribution signing. No App Store Connect API key was
created. No main merge, Beta tag, TestFlight upload or physical-phone update
was performed in this pass.

## 2026-10-15 evening — Pairing recovery and universal TestFlight 131

An installed Remote `.2` session could show signed out while its persisted
credential still authenticated successfully. A delayed account-status request
was rejected when a concurrent refresh rotated the access token. The fix accepts
the refreshed credential only when the already-known user, organization and
account authority still match; logout and identity changes remain fenced.
The regression failed before the fix; 110 focused account/auth/device/pairing
tests, format, lint (zero errors) and twelve-package typecheck pass.

Remote `1.0.6-remote.3`, source `56c90173152bf15fa22a1282f1166d7f4b65054a`,
passed [the complete release-candidate workflow](https://github.com/Emanuele-web04/synara/actions/runs/38794054496),
including signing, notarization and packaged startup. This is a build-only run;
no public release, tag or update feed was published. Standard public-repository
runners were used; no billing or spending setting changed.

The iPad branch was merged into the mobile feature branch through mobile PR #2;
mobile PR #1 remains separate from main. The native authentication consent names
Synara, and the light icon is rendered from the current vector at the scale of
the existing dark/custom icons. WorkOS keeps its existing domain and email
sender; no paid branding service was activated.

A real-account iPhone simulator completed fresh short-code enrollment to both
Macs after comparing their host identity pins. Both connections coexist: eleven
projects, 36 visible Mini chats and 24 visible MacBook chats. Existing transcripts
open from both computers. This also exposed a first-pair completion defect:
remote trust installation now finishes onboarding and enables foreground
reconnect, matching the local-pair completion path. Installing simulator build
131 over the existing app and relaunching preserved the account and both hosts.
The original phone screenshot failure was not reproduced with fresh invites;
a camera QR scan and cellular network were not tested.

Universal TestFlight `0.1 (131)` finished processing and is attached to the
existing internal Synara Early Access group. App and widget retain their bundle
IDs, include device families 1 and 2, have valid distribution signatures and
disable debugging; the app carries production APNs entitlement. Eight QR
classification tests, two iPhone navigation UI cases and one iPad docked-sidebar
selection/collapse/rotation case pass. The UI cases use fixtures; real remote
enrollment and transcript reads were checked separately on the simulator.
External Beta Review and physical TestFlight background push delivery remain
unverified. No physical iPhone was used in this pass.

Remote `.3` is installed and open on both Macs after local provenance,
package hash, Developer ID, Gatekeeper and stapled-ticket verification. MacBook:
102 threads and 1,737 messages have identical full-table fingerprints before and
after installation. Mini: all 46 thread identities and all 215 complete message
rows are preserved, with unchanged project/thread/message counts. Account scope,
environment ID and host/device/TLS identity files are unchanged. Both hosts
restored their existing account and simulator trust without another login or
pairing. On the final simulator build, switching between the two computers and
opening each existing smoke transcript passed. These were reads, not fresh
provider turns. Remote `.2` and private database backups remain available for
rollback; Stable/Beta installations and their data homes were not changed.

### Follow-up — Codex runtime warnings and copy controls

The MacBook's new Codex conversation completed its turns but displayed 59
`process/stderr` events as generic runtime warnings. The actual payloads were
single-line JSON diagnostics: WARN-level skill/credential/memory/analytics
notices and ERROR-level OAuth failures for MCP servers from the user's external
Codex configuration. The existing classifier understood text logs only.

Classification now shares one pure implementation between server ingestion and
historical web replay, recognizes both text and complete JSON log envelopes
(including `fields.error` without `fields.message`), and retains unknown errors,
Synara-owned connector failures and explicit retry feedback. Ignored external
MCP OAuth failures keep their existing bounded host-log notice. Historical
records are filtered when rendered, not deleted or rewritten. A remaining real
runtime notice uses its readable message instead of the generic row title.
The regressions failed before the repair; final focused server coverage passes
285 tests with two fixture skips, and the web/clipboard/row/font checks pass
205 tests. The initial sandbox run could not prove synthetic-process teardown;
repeating with OS process inspection available passed all three server files.

The requested UI change reuses CopyTextButton: a compact icon copies the exact
root fingerprint in both comparison dialogs, and Copy code copies the live
short pairing code. The shared button gains an icon-only variant with the same
accessible label and copied-state feedback; its existing callers are unchanged.
The expired code has no copy action. No new package dependency or account/trust
change is introduced. The twelve existing browser Connections cases also pass.
Manual copy/paste checks with the actual shared controls preserve both the raw
64-character fingerprint and the short code exactly, with copied-state feedback.
The installed Mini app also exposes Copy code and shows Copied code after a
real click. TestFlight 131 is not replaced by this desktop change.

Remote `1.0.6-remote.4`, source `922f21bdc385b404639b8e0a4e685f5fa9340197`,
passed [the complete candidate workflow](https://github.com/Emanuele-web04/synara/actions/runs/38800710107)
and is installed and open on both Macs. This remains a build-only artifact:
no public tag, release or update-feed publication. Local artifact hashes,
provenance, Developer ID, Gatekeeper and stapled-ticket checks passed before
installation. Private database backups and the previous app bundles remain
available for rollback.

Mini: all 46 chats and 215 complete message rows are preserved. MacBook: all
103 chats and 1,745 message rows are preserved, with identical messages. Both
accounts, machine identities and existing pairing approvals are unchanged; the
simulator reconnected to both computers after restart without another login or
pairing. Existing smoke messages from both computers load on the simulator. The actual
MacBook conversation now renders without generic runtime-warning rows while
retaining its real failed-tool activity. All 101 historical warning records,
including the 59 investigated events, remain in the database. Replaying those
59 original payloads through the exact classifier returned 53 ignored diagnostics,
six external MCP OAuth notices and no conversation notices. The external Stripe
and Polar credentials themselves were not refreshed or changed.

These checks did not start new provider turns, use the physical iPhone, test
cellular delivery or qualify TestFlight production background pushes. Stable and
Beta homes remain untouched. No paid service or billing setting was enabled.

### Follow-up — Recovery ownership after a client disconnects

A post-install read found a separate MacBook thread stuck on Starting Codex:
the native resume completed, but the runtime's generation differed from the
coordinator and its ready events were discarded. The existing logs prove that
mismatch, not the operation that changed the generation. A model-list refresh
timeout also predates Remote `.4`; it is not attributed to this update.

A focused regression reproduces a concrete ownership gap: cancelling the
prewarm request during adapter startup used to cancel recovery and abandon
its generation. Prewarm now runs in the existing provider-service scope;
clients may stop waiting while recovery finishes binding persistence. Service
shutdown still owns the job, deduplication and idle cleanup are retained, and
the stale-event checks are unchanged. No new orchestration abstraction, timeout
policy or provider choice is introduced. The regression failed before the fix
and passes afterwards, including acceptance of the recovered runtime's ready
event. All 397 provider service/coordinator/adapter/ingestion tests pass, as do
format, lint (zero errors), twelve-package typecheck and Windows runtime guards.
The recovery change is not in the installed `.4` package yet.

Remote `.5` (source `27bc3d7431b2b56062c678cac22736b0cb0b2a9a`) subsequently
passed [the complete signed-candidate workflow](https://github.com/Emanuele-web04/synara/actions/runs/38806243530)
and is installed on both Macs. Mini retains 46 chats and 215 complete messages;
MacBook retains 103 chats, 1,745 complete messages and 357 turn rows. Account,
machine identity and device approvals are unchanged. Both simulator connections
recovered without pairing again. Opening the existing MacBook x-limiter chat
from the simulator produced starting, ready and session.started at
21:28:18.253Z–21:28:19.019Z with the runtime's matching generation, and no
post-restart stale-generation drops or new runtime warnings in the checked
window. The Mini smoke runtime also reached ready with session.started. These
were existing-transcript reads, not new turns or a deliberate live cancellation.
Rollback `.4` remains available. The temporary transfer exposed only the verified
public ZIP over the existing private mesh; its listener is now confirmed closed.

### Latest main and pairing-dialog update

The user requested another candidate with main through `1c72bae` (history-read
performance, refetch-storm reduction and client-side RPC queues), plus the
updated pairing dialog from `892e3c7`. The merge retains controller-frame routing,
remote server-generation callbacks, product-event handling and settings-change
filtering; it adopts main's removal of the server-busy popup and expensive
keep-awake snapshot seed. Both shared subpath exports remain available.

Focused integration checks pass: 970 server tests, 156 web unit tests and 60
browser cases, format, lint with zero errors, twelve-package typecheck and Windows
runtime guards. The separate opt-in history benchmark was not run. The new QR
uses the same pairing-link payload and keeps dark modules on a light tile. Apple
CoreImage decoded the actual component's screenshots at 196px and 120px module
area sizes, matching the complete synthetic payload; the tiles included the
component's normal quiet-zone padding. Browser coverage includes pending
approvals and renewal/expired/used-code behavior. The synthetic preview used a
separate home and ports; its file, browser tabs and both listeners were removed
or closed after verification. This does not claim a physical camera test.

No wire-schema change requires a native mobile rebuild for these updates.
TestFlight 131 remains the mobile build; the next desktop candidate must still
pass signed packaging and installation qualification before replacing `.5`.

The subsequent user UI commit `a26c1e8` is also included: capsule/button
segmented-control variants and plain Add actions in Connections. The pairing
illustrations now use the existing UI typography tokens so they follow the font
setting. The final UI pass passed format, lint, twelve-package typecheck, four
typography/selector guards and 26 browser cases covering Connections, inline
visual blocks and the preview toolbar. No test threshold was relaxed.

### Synara Remote .6 qualification

Build-only CI [38811340707](https://github.com/Emanuele-web04/synara/actions/runs/38811340707)
passed all gates for candidate `11094322e38de4dcef5c4f4997506202821b3125`. Remote
`1.0.6-remote.6` is installed and open on both Macs, with `.5` retained for
rollback. The Mini verified the full GitHub artifact digest, provenance and
lockfile; both Macs verified the ZIP hash, Developer ID signature, Gatekeeper and
notarization. The temporary single-file transfer listener is confirmed closed.

The Mini preserves 46 chats, 215 message rows and 91 turns; the MacBook preserves
all original 103 chats, 1,745 messages, 357 turns, 16 projects, 57 attachments and
seven icons. Account, machine identity and approvals remain unchanged. Separate
user activity added two chats, four messages and two completed turns on the
MacBook after the initial comparison; no original row was lost. The MacBook
also logged two model-catalog refresh timeouts on other chats; this qualification
does not claim those were repaired.

The installed Mini dialog passed Phone/Computer switching and Copy code / Copy
fingerprint feedback. Connections tab switching was also verified on the
MacBook; the invite/copy actions were not repeated there. The existing iOS
simulator build 131 reconnected to both Macs and read their existing transcripts
without pairing again or sending new turns. MacBook x-limiter reached ready and
session.started with a consistent runtime generation at 00:02:55 CEST on
16 October. No physical phone was used. This is desktop candidate qualification,
not public publication, a physical-camera test or a TestFlight background-push
test. A subsequent user request to improve mobile first-send titles/provider
icons is separate native work and is not included in build 131.

### 2026-10-16 — Packaged desktop workspace startup

The `.6` subframe navigation guard admitted only `about:blank` and
`about:srcdoc`, blocking the application's own workspace document. MacBook →
Mini pairing completed, but the pane stayed blank and never reported ready.
The previous qualification covered desktop dialogs and mobile-to-Mac RPC,
not this packaged desktop workspace startup path.

The guard now permits the main app to initialize a fresh direct child with its
exact shell document, and that initialized workspace to reload the same document
for recovery. Inline visuals, foreign initiators, other app identities and URL
data remain blocked. No pairing, account or transport policy was changed.
Nineteen guard tests pass, including regressions that fail before the fix.
A real Electron fixture also confirms initial loading, retry/reload and continued
containment of an inline visual. Signed installation and MacBook → Mini live
qualification are the remaining candidate checks.
