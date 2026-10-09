# Managed remote access: operations and qualification

The execution host runs cloudflared; the account API owns Cloudflare administration. The controller obtains an HTTPS endpoint from the account directory and verifies the existing pinned TLS 1.3 channel inside its outer WebSocket. No Synara traffic-relay deployment or `SYNARA_RELAY_URL` is required. WorkOS and one PostgreSQL database remain account-service dependencies.

For the ordered service setup and first two-Mac test, follow [Configure the remote MVP](implementation/cloudflare-remote/READINESS.md).

## Test service configuration

Keep the existing API variables described in [apps/api/README.md](../apps/api/README.md), including its exact issuer/JWKS and persistent signing key. Add all four values below together. A partial Cloudflare configuration fails boot; absent configuration answers provisioning with an explicit unavailable error.

| Variable                   | Scope                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`    | Cloudflare account, 32 hexadecimal characters                                                                                             |
| `CLOUDFLARE_ZONE_ID`       | Dedicated test DNS zone, 32 hexadecimal characters                                                                                        |
| `CLOUDFLARE_API_TOKEN`     | Secret in API hosting configuration only; account tunnel write and zone DNS write permissions                                             |
| `CLOUDFLARE_TUNNEL_DOMAIN` | DNS zone hostname, without scheme or path                                                                                                 |
| `REMOTE_TEST_USER_IDS`     | Comma-separated explicitly authorized test WorkOS user IDs; empty denies remote provisioning, code pairing, grants and host authorization |

Use a single generated hostname label directly beneath the configured zone. Multi-level names may require a different certificate product. Public DNS is a proxied CNAME to the allocated tunnel's `cfargotunnel.com` target. Each configuration ends in a 404 catch-all. Never point the tunnel at the normal local app/admin port.

Cloudflare's [published account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) reviewed on 2026-09-28 list 1,000 tunnels per account and 25 active replicas per tunnel (with separate route limits). These are ceilings, not a pricing promise. Check the selected account's current limits, plan, contract and permitted product use before provisioning live resources. [Official API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/) describes the scoped permissions. No real services were provisioned by the local fixture workflow.

## Distribution and lifecycle

Version `2026.9.3` is pinned in `packages/shared/src/cloudflared.ts`, with official GitHub asset SHA256 digests. Desktop packaging stages the verified executable outside asar at `Resources/cloudflared/cloudflared` (`cloudflared.exe` on Windows); macOS signing includes it. Universal Mac packaging joins the verified arm64 and x64 executables. The Apache 2.0 license is retained in desktop runtime resources. CLI development installs the same verified release in its own home under `tools/cloudflared/2026.9.3`. An absolute `SYNARA_CLOUDFLARED_PATH` is an operator/test override, never an account-provided value. Packaged desktop chooses its bundled path.

Native assets are pinned for macOS arm64/x64, Linux arm64/x64 and Windows x64. Windows ARM desktop packaging carries the official x64 executable and therefore needs OS emulation; this has not been runtime-qualified. The local MVP qualification targets macOS arm64. Linux, Windows, universal Mac and signed distribution need their respective runtime evidence.

The host owns one connector child at a time and waits for shared process-tree teardown before replacing it. Readiness comes from cloudflared's local `/ready`, not process existence. Restart delay grows from approximately one second to sixty seconds with jitter. The child uses an installation-owned home and explicit empty local configuration, so a personal cloudflared configuration cannot change the managed ingress. Tokens travel only in the child environment, with no inherited provider credentials, command-line token, log forwarding or renderer exposure. Connector restarts reuse the current allocation. API administrators' credentials never reach the host.

The dedicated listener binds IPv4 loopback on an unused port and requires the exact assigned hostname. Spoofed forwarded headers do not grant local authority. Controller dial/probe operations are bounded; transport switching creates a fresh verified stream and does not replay arbitrary commands.

## Pairing and revocation

Sign in to the same account/workspace on both computers. In Hosts & devices, create a code on the execution host, enter it on the controller, compare all root fingerprint groups across both screens, then request access. A controller signed in as the host owner is approved automatically with its account grant; otherwise the host displays the exact requesting device fingerprint; approve only after comparing it with the controller. Subsequent connections use the durable device key and pinned root. Code lookup alone does not establish trust.

Codes expire after nine minutes (leaving one minute of clock-skew headroom below the API publication limit) and are claimed once, transactionally, by a registered nonrevoked device key. Per-IP, per-account and per-code attempt budgets use PostgreSQL so multiple API instances share limits. Renewal cancels older rendezvous and pending local invitations. Cancellation revokes locally even if the API is temporarily unreachable. Invitation bundles remain only on the trusted servers and are removed from rendezvous storage on redemption/cancellation/expiry. The normal UI does not copy JSON. A redeemed bundle remains on the controller server until successful pairing, explicit cancellation/forgetting, account change or expiry. A temporary directory/dial failure can therefore retry the reviewed identity without redeeming the public code again. Cancellation waits for the in-flight setup before forgetting local trust. Existing [headless private-file pairing](remote-connections-v2.md#headless-owner-pairing) remains supported.

Authorization polls have ±10% jitter around ten seconds and account requests have fifteen-second deadlines. Successful snapshots renew a sixty-second lease only after local application; the expiry check closes remote streams within approximately one additional second. Online revocation normally arrives on the next poll, with request/application latency added. Do not promise a strict wall-clock bound if the operating system or event loop is suspended. During outages the last lease expires; a failed refresh never extends it. Local provider tasks remain execution-host work when controllers disconnect.

Device revocation closes RPC/resources before durable tombstone/ACK. Missing ACK is retried by later snapshots. Host unlink, replaced keys, owner removal and hard proof denial fence old admission. Ordinary network loss retains the allocation. Explicit remote disable retires it, and the account sweeper removes DNS/tunnel resources in bounded batches. Failed cleanup retains resource ownership evidence. Retired names are revisited hourly to catch a provider create that completes after a timeout; cleanup never uses a newer generation's name.

## Automations on another computer

In builds with remote connections enabled (Beta/Dev), open
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

Live qualification is a separate final step: secure API/Cloudflare/WorkOS configuration, a dedicated test domain and database, the build installed on both Macs, and approved real-provider use. Test different networks, connector/network interruption, app restart, sleep/wake, revocation and a declared-duration soak covering a real credential renewal. Measure connection/recovery/transfer behavior before making performance claims. No customer rollout is authorized until a real paid-entitlement authority replaces the test allowlist.
