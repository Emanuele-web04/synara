# Cloudflare Remote — execution state

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
