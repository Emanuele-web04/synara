# Managed remote access: operations and qualification

The execution host runs cloudflared; the account API owns Cloudflare administration. The controller obtains an HTTPS endpoint from the account directory and verifies the existing pinned TLS 1.3 channel inside its outer WebSocket. No Synara traffic-relay deployment or `SYNARA_RELAY_URL` is required. WorkOS and one PostgreSQL database remain account-service dependencies.

For the ordered service setup and first two-Mac test, follow [Configure the remote MVP](implementation/cloudflare-remote/READINESS.md).

## Test service configuration

Keep the existing API variables described in [apps/api/README.md](../apps/api/README.md), including its exact issuer/JWKS and persistent signing key. Add all four values below together. A partial Cloudflare configuration fails boot; absent configuration answers provisioning with an explicit unavailable error.

| Variable                     | Scope                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`      | Cloudflare account, 32 hexadecimal characters                                                                                                                     |
| `CLOUDFLARE_ZONE_ID`         | Dedicated test DNS zone, 32 hexadecimal characters                                                                                                                |
| `CLOUDFLARE_API_TOKEN`       | Secret in API hosting configuration only; account tunnel write and zone DNS write permissions                                                                     |
| `CLOUDFLARE_TUNNEL_DOMAIN`   | DNS zone hostname, without scheme or path                                                                                                                         |
| `REMOTE_BETA_ACCESS_ENABLED` | `true` opens hosted beta enrollment to every authenticated account; unset/`false` keeps private deployments restricted. Ownership and pairing checks still apply. |
| `REMOTE_TEST_USER_IDS`       | Comma-separated selected WorkOS user IDs when public beta enrollment is off; an empty list then denies remote provisioning, pairing, grants and authorization.    |

Use a single generated hostname label directly beneath the configured zone. Multi-level names may require a different certificate product. Public DNS is a proxied CNAME to the allocated tunnel's `cfargotunnel.com` target. Each configuration ends in a 404 catch-all. Never point the tunnel at the normal local app/admin port.

Cloudflare's [published account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) reviewed on 2026-09-28 list 1,000 tunnels per account and 25 active replicas per tunnel (with separate route limits). These are ceilings, not a pricing promise. Check the selected account's current limits, plan, contract and permitted product use before provisioning live resources. [Official API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/) describes the scoped permissions. No real services were provisioned by the local fixture workflow.

## Distribution and lifecycle

Version `2026.10.3` is pinned in `packages/shared/src/cloudflared.ts`, with official GitHub asset SHA256 digests. Desktop packaging stages the verified executable outside asar at `Resources/cloudflared/cloudflared` (`cloudflared.exe` on Windows); macOS signing includes it. Universal Mac packaging joins the verified arm64 and x64 executables. The Apache 2.0 license is retained in desktop runtime resources. CLI development installs the same verified release in its own home under `tools/cloudflared/2026.10.3`. An absolute `SYNARA_CLOUDFLARED_PATH` is an operator/test override, never an account-provided value. Packaged desktop chooses its bundled path.

Native assets are pinned for macOS arm64/x64, Linux arm64/x64 and Windows x64. Windows ARM desktop packaging carries the official x64 executable and therefore needs OS emulation; this has not been runtime-qualified. The local MVP qualification targets macOS arm64. Linux, Windows, universal Mac and signed distribution need their respective runtime evidence.

The host owns one connector child at a time and waits for shared process-tree teardown before replacing it. Readiness comes from cloudflared's local `/ready`, not process existence. Restart delay grows from approximately one second to sixty seconds with jitter. The child uses an installation-owned home and explicit empty local configuration, so a personal cloudflared configuration cannot change the managed ingress. Tokens travel only in the child environment, with no inherited provider credentials, command-line token, log forwarding or renderer exposure. Connector restarts reuse the current allocation. API administrators' credentials never reach the host.

The dedicated listener binds IPv4 loopback on an unused port and requires the exact assigned hostname. Spoofed forwarded headers do not grant local authority. Controller dial/probe operations are bounded; transport switching creates a fresh verified stream and does not replay arbitrary commands.

## Pairing and revocation

Sign in to the same account/workspace on both computers. On the execution host, open **Settings → Connections → Control this computer → Add** (the tab says **Control this Mac** on macOS). Use **Phone or iPad** for the QR or **Computer** for its short code. On the controller, open **Control other devices → Add**, enter the code, compare all root fingerprint groups across both screens, then request access. A controller signed in as the host owner is approved automatically with its account grant; otherwise the host displays the exact requesting device fingerprint; approve only after comparing it with the controller. Subsequent connections use the durable device key and pinned root. Code lookup alone does not establish trust.

Codes expire after nine minutes (leaving one minute of clock-skew headroom below the API publication limit) and are claimed once, transactionally, by a registered nonrevoked device key. Per-IP, per-account and per-code attempt budgets use PostgreSQL so multiple API instances share limits. Renewal cancels older rendezvous and pending local invitations. Cancellation revokes locally even if the API is temporarily unreachable. Invitation bundles remain only on the trusted servers and are removed from rendezvous storage on redemption/cancellation/expiry. The normal UI does not copy JSON. A redeemed bundle remains on the controller server until successful pairing, explicit cancellation/forgetting, account change or expiry. A temporary directory/dial failure can therefore retry the reviewed identity without redeeming the public code again. Cancellation waits for the in-flight setup before forgetting local trust. Existing [headless private-file pairing](remote-connections-v2.md#headless-owner-pairing) remains supported.

### Diagnosing a rejected pairing code

The account API deliberately returns the same `400 challenge_expired` response for
an unavailable code and an invitation outside the caller's account/workspace.
It is not evidence that the login expired or that the host tunnel is offline.
Fixed-category `[api] Remote pairing rejected: reason=…` warnings distinguish
device, proof, session lookup, host identity and invitation-lifetime failures
without recording codes, proofs, tokens, identities or account content. The
categories describe rejected attempts, not distinct users; a missing log entry
does not prove that no attempt occurred. They become available after deploying
the compatible account API, independently of desktop or native app releases.

An owner's hosts remain visible across active workspaces, but pairing requires
the same account and workspace on both devices. Refreshing into the old workspace
does not repair a workspace mismatch.

Renewal invalidates an older code. A lost HTTP response after the redemption
transaction commits leaves that code consumed, even for the same device.
Use a fresh code in those cases; do not erase app data,
accept another account's invitation or replay a spent code to recover. A generic
pairing `400` is not a reason to force account logout or blindly spend another
single-use refresh token.

Authorization polls have ±10% jitter around ten seconds and account requests have fifteen-second deadlines. Successful snapshots renew a sixty-second lease only after local application; the expiry check closes remote streams within approximately one additional second. Online revocation normally arrives on the next poll, with request/application latency added. Do not promise a strict wall-clock bound if the operating system or event loop is suspended. During outages the last lease expires; a failed refresh never extends it. Local provider tasks remain execution-host work when controllers disconnect.

Remote .15 treats the legacy temporary enrollment refusal as unavailable access and keeps polling without revoking device trust. Admission still requires a fresh successful snapshot. Opening a populated remote workspace on its home route also no longer treats the home as an empty chat identifier. If an older build already revoked a pairing, updating does not restore it automatically: create a fresh code and pair normally. Do not erase local app data or restore revoked devices through database edits.

Remote .16 treats rejected/stale proofs and transient API/proxy failures as retryable checks; they expire the existing authorization lease rather than revoking every paired device. Known ownership denials close admission immediately and only retire local trust after repeated checks spanning at least five minutes. Successful snapshots reset that window. Explicit device revocation and durable tombstones still apply immediately. Proof timestamps are sampled after private-key import, and desktop backends default to a 16-worker libuv pool so blocked filesystem work is less likely to starve DNS/crypto.

Device revocation closes RPC/resources before durable tombstone/ACK. Missing ACK is retried by later snapshots. Host unlink, replaced keys, owner removal and hard proof denial fence old admission. Ordinary network loss retains the allocation. Explicit remote disable retires it, and the account sweeper removes DNS/tunnel resources in bounded batches. Failed cleanup retains resource ownership evidence. Retired names are revisited hourly to catch a provider create that completes after a timeout; cleanup never uses a newer generation's name.

## Automations on another computer

In builds with remote connections enabled (Remote/Beta/Dev), open
**Automations → New automation → Run on** and select a connected computer,
then choose its project, provider/model and schedule. Switching computers carries
only the title, prompt and scheduling/options draft; project, target chat and model
are selected from the destination's own state. The draft stays in renderer memory,
not in the navigation URL. An unavailable computer cannot accept a new automation.

The selected host owns the saved automation, its scheduler and its runs. Once
saved on a Mac Mini, it runs there with the MacBook/controller closed. Keep the
execution host awake with Synara running, the project available and its provider
authenticated. Cloudflare supplies connectivity, not execution or automatic
failover. Existing automations keep their original host; selecting a computer
while creating one does not migrate earlier automations or their history.

The Automations panel combines local and connected-host entries with computer
names. Opening a remote entry edits and runs it on that host; disconnecting the
controller does not stop the host scheduler. Revoking access prevents further
management from that controller, without deleting the owner's scheduled jobs.

Qualification (2026-10-09): the dedicated `remote automations` case in
`apps/e2e/src/workspace.e2e.test.ts` passes with two built servers, an isolated
PostgreSQL database and Chromium. It verifies computer selection in both directions,
private draft transfer, host-only persistence, shared-panel navigation, and exactly
one successful scheduled run after the controller process exits. Cloudflare/WorkOS
and the provider executable are fixtures; this is not a new live-provider or physical
Mac sleep/wake qualification.

The earlier chat/MCP failure was investigated and fixed during the surface audit
below. The workspace-wide build still hits the existing contracts declaration-emission
limit (`rpc.ts`, TS7056); direct web and CLI builds succeed. See the latest
[qualification ledger](implementation/cloudflare-remote/STATUS.md) for test results
and remaining gaps rather than treating a focused pass as a clean full-suite run.

## Native goal command compatibility

Hosts advertise `orchestration.thread-goal-visible-start` when they accept
`goalStartBehavior: "start-with-message"`. Native clients use it only for a new,
idle goal outside Plan mode, so the visible message and first turn are committed
together. Older hosts keep the existing goal path; this optional capability does
not change the required protocol revision or require re-pairing.

## Remote surface audit (2026-10-09)

Tasks, Kanban, Inbox and Code review now expose the existing **Computer** picker.
Selecting a computer opens its own overview, stores and authenticated RPC client;
project IDs, thread IDs and review filters are not copied between computers. The
List/Kanban view switch retains the selected owner. A task created there belongs
to that computer, and its agent uses that computer's projects and provider login.
Existing tasks and cards are not migrated by changing the picker.

Six read-only audit lanes covered tasks/boards, scheduling, projects/Git, runtime
tools, Hubs/Inbox/reviews and agent MCP. Confirmed remaining limitations:

| Area                                         | Current boundary                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal, project scripts, Git and worktrees | Execute inside the selected owner's workspace; no controller fallback.                                                                                                                           |
| Scheduled automations / CI auto-fix          | Owner-server work; keep that server awake and running. No automatic failover.                                                                                                                    |
| Remote project creation                      | Existing remote folders work. GitHub clone/provisioning has no remote dialog flow yet.                                                                                                           |
| Hubs                                         | Existing remote hub chats are accessible; the controller does not aggregate their coordinator/attention metadata or provide a dedicated remote Hubs landing picker.                              |
| Dev-server Run and preview                   | Tracked lifecycle RPCs remain unavailable remotely. Preview needs authenticated port forwarding; opening an owner's localhost URL on the controller is incorrect. Terminal scripts are separate. |
| Native computer/browser/device actions       | Explicitly unavailable remotely; require a separate capability/permission and resource design.                                                                                                   |
| Agent MCP delegation                         | Remote project/thread tools work. Remote automation and Kanban tools are not delegated; use the destination workspace UI or an agent running there.                                              |

The previously failing MCP fixture read a credential from the child environment,
although production now deliberately sends it only in thread-scoped app-server
configuration. The fixture now reads that private protocol field without logging
it or restoring the secret to the process environment. No production authentication
guard was weakened.

The authenticated MCP test then exposed a real creation bug: the destination tried
to resolve the foreign caller's synthetic replay ID as a local thread. Creation
now skips that local-only principal lookup for authenticated remote callers, whose
roles are checked at the source. Hub coordinator/worker restrictions, explicit
destination project selection, runtime privilege checks and durable replay remain
in place. The existing two-server MCP test failed before this fix and passes after
it; the complete chat continuity scenario also passes (33.45 seconds).

The new `remote surfaces` browser case reproduces the missing picker against the
previous build, then passes with the changes. It selects Inbox, Code review and
Tasks in both directions, creates a remote-only todo, switches to Kanban without
changing owner, and starts a task that finishes after the controller process exits.
The fixture deliberately uses the same project ID on both servers to detect wrong-host
writes. These checks use real application servers and a deterministic provider,
not a new live-provider or physical-device qualification.

## Local and live evidence

The Beta Inbox's **Save privately** action uploads an explicit snapshot to the
account service, including project names. Saved recaps belong to one account
and workspace and are independent of public profiles, pairing records and
source-host lifetimes. A fresh sign-in can restore history while every Mac is
offline. The desktop server refuses saved-recap RPCs on Stable; it also refuses
a pending save if the account or workspace changed before upload.

This feature requires additive account migration
`apps/api/drizzle/0016_private_inbox_recaps.sql` and deployment of the updated
account API. Neither production migration nor deployment is part of this local
implementation. See the [private recap API contract](../apps/api/README.md#private-saved-inbox-recaps)
for endpoints, ownership checks, pagination and default-deny RLS.

Run affected PostgreSQL API tests against one disposable database, then the E2E transport suite against that database without concurrent destructive fixture setup. After `bun run build:desktop`, `TEST_DATABASE_URL=... SYNARA_E2E_EVIDENCE=/private/path bun run --cwd apps/e2e test:workspace` launches two built Node servers and Chromium with separate homes. Its external HTTPS proxy and connector subprocess simulate the Cloudflare boundary; WorkOS and provider CLI are deterministic fixtures. The inner TLS, actual account coordinator, approvals, resources, persistence and reconnect code are production paths. No public-CA verification is disabled: an ephemeral fixture certificate is trusted only by the isolated test processes.

The authoritative execution ledger is [STATUS.md](implementation/cloudflare-remote/STATUS.md). Record the final checks and limitations there. Root checks alone skip database/build-dependent cases when their explicit environment variables are absent.

Live qualification is a separate final step: secure API/Cloudflare/WorkOS configuration, a dedicated test domain and database, the build installed on both Macs, and approved real-provider use. Test different networks, connector/network interruption, app restart, sleep/wake, revocation and a declared-duration soak covering a real credential renewal. Measure connection/recovery/transfer behavior before making performance claims. The hosted early-access beta is open to authenticated accounts under `REMOTE_BETA_ACCESS_ENABLED=true`; the operator has authorized that tester rollout. This enrollment policy is not a billing authority. Any future paid rollout needs its own authoritative entitlement policy; do not infer a subscription from this flag or from a test allowlist.

## Completion notification delivery

Ordinary completion alerts use the phone's APNs device token, separately from
ActivityKit tokens. The phone registers one exact live turn with the account API
at `PUT /api/v1/notification-subscriptions`. Each subscription is bound to its
current account/workspace, registered device session and owned host generation.
It remains registered when the phone suspends or the turn disappears from its
foreground running list; completion must not race removal of the watch.

Migration `0023_turn_notifications.sql` extends the existing private outbox with
an explicit delivery kind and a unique device/exact-turn key. Existing ActivityKit
rows retain their original kind and behavior. Completion watches expire after
24 hours, with at most 64 active watches per account. The existing host reporter
and five-second delivery sweep serve both destinations. Only authoritative
`completed` or `error` turns produce alerts; stopped, expired and missing/offline
reports do not invent a completion. An offline host can report later within the
watch lifetime. Device/session revocation, membership and host generation are
rechecked before sending. Logout/forget revoke all matching device/host watches
in one authenticated `DELETE /api/v1/notification-subscriptions` request.

The sender reuses the existing environment-specific APNs credentials, with the
ordinary app bundle topic, `apns-push-type=alert` and a per-turn collapse ID.
Payloads contain generic “Synara” / “Response ready” or “Run failed” text and opaque
routing IDs only. Delivered, invalid-token, rejected or exhausted watches erase
the token and retain a deduplication tombstone until one day after expiry.
A fresh UUID cannot resend the same device/exact-turn watch during that window.
APNs remains at-least-once; a process failure after Apple accepts a request can
retry the same collapse ID. Native foreground handling suppresses banners, and
local completion alerts are a fallback for local peers or unacknowledged cloud
watches while iOS still permits their socket to run. A local-only paired host has
no account-backed cloud destination after iOS suspends its connection.

Deploy the additive migration and compatible API before publishing the native
client. Preserve the existing APNs secrets, verify table ownership/default-deny
RLS and the exact Drizzle hash/timestamp, then test an actual registered sandbox
or Production device. HTTP tests, `simctl push`, secret configuration and an APNs
synthetic-token acceptance probe do not prove visible background delivery.

## Live Activity push delivery (development)

The account API can deliver ActivityKit updates while the iOS app is suspended.
This is separate from ordinary notification delivery and does not start tasks.
The iOS client starts the activity in the foreground and registers its rotating
ActivityKit token using its existing account session and registered device key.
The API accepts only hosts owned by that same account/workspace, binds their key
generations, and rechecks device/session revocation and membership before sending.

Configure all five server-only secrets together: `APNS_PRIVATE_KEY` (P-256 PKCS#8
PEM, real newlines or escaped newlines), `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_BUNDLE_ID`, and `APNS_ENVIRONMENT` (`sandbox`, `production`, or `both`). The Worker
forwards these to the API container. No private Apple key belongs in a client or
Git. Missing configuration leaves foreground ActivityKit behavior available;
partial/invalid configuration fails startup. Use `both` to accept development and
TestFlight registrations together. The client still reports one environment per
token; the API stores it and selects the corresponding fixed Apple gateway on
delivery. Single-environment settings continue to reject mismatched registrations.
An Apple key restricted to Sandbox cannot sign Production requests merely by
setting `APNS_ENVIRONMENT=both`. Keep that Sandbox key in `APNS_PRIVATE_KEY` /
`APNS_KEY_ID` and configure a separate `APNS_PRODUCTION_PRIVATE_KEY` /
`APNS_PRODUCTION_KEY_ID` pair for the same app. The API validates both pairs and
keeps their JWT caches separate. Existing keys that Apple permits in both
environments can continue using only the original pair.
Deploy the compatible API before changing the trial's current Sandbox setting to
`both`. Sandbox delivery does not qualify TestFlight or App Store delivery.

Migration `0021_woozy_dreadnoughts.sql` adds default-deny RLS tables for expiring
activity registrations and host snapshots. The ordinary API startup migration
runner applies it on deployment. Registrations have a four-hour maximum lifetime,
a per-account limit of eight, and durable coalescing/retry state. Tokens are
cleared on retirement. No prompt, output, project path, or conversation title is
uploaded; the background widget uses the generic title “Synara task”.

The Beta host reporter polls only explicitly subscribed turns (15 seconds while
idle, 5 seconds while watched); delivery sweeps run every 5 seconds. This is
bounded polling, not instantaneous streaming. Completion across multiple hosts
ends the activity only once all watched turns settle. Ninety seconds without a
fresh host report stops its displayed run; retry exhaustion retires the server
registration, so an Apple/network outage is not proof of lock-screen dismissal.
Foreground reconnect remains responsible for reconciling local activity state.

Qualification must distinguish: database/transport tests, simulator lifecycle
checks, Apple accepting a real APNs request, and visible background update/end on
a device or supported simulator. `simctl push`, mocks, a successful build, and
installed Cloudflare secrets do not prove real Apple delivery.

For the TestFlight qualification, install the existing mobile build, sign in with
the same Synara account as the desktop host, and pair that installation through
Connections. Keep the host online and enable Live Activities for Synara in iOS
Settings. From a scratch chat on the phone, start a turn long enough to observe
(for example, ask the agent to run only `sleep 45`, wait for it, then reply).
Wait until the activity appears, then background Synara or lock the phone without
force-quitting it. Verify its running state changes to Ready without reopening
the app and the ended activity dismisses after about 60 seconds. Repeat over
cellular with Wi-Fi disabled. A failure report should include the test time and
visible state; correlate it with the account-scoped registration/outbox rather
than asking for a device token or private key.
