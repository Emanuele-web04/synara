# Personal remote connections v2

The transport now uses managed Cloudflare tunnels; see [operations](cloudflare-remote.md) and [ADR 0016](adr/0016-managed-cloudflare-remote.md). The historical TLS and owner-pairing admission gates passed local integration and an isolated `app.asar` test under Electron 43 / Node 24; those results do not qualify the new connector. Remote admission is available only for Beta/Canary or explicitly opted-in Node 24 development; Stable and Bun-hosted remote admission remain disabled. Release qualification on two physical Macs and with a real provider is still outstanding. The presence of UI, migrations or passing tests is not release qualification. This document supersedes plaintext transport and automatic device-enrollment assumptions in the earlier remote-host ADRs and slice specifications.

## Boundaries

A window shows projects and chats from the local computer and its connected hosts together. Opening a chat selects its owning environment; it does not switch or reload the whole application. Account, host directory and connection management always use the local controller. Projects, provider sessions, filesystem, Git and terminals remain owned by their execution host. Each remote workspace uses a persistent, same-origin application frame with its own verified execution context, RPC clients, stores, query cache, resume cursors and router. The outer sidebar receives project/thread navigation summaries; it never substitutes the active host in an in-flight operation. Frames load only the bundled application, never repository HTML. The local workspace stays available when a remote workspace cannot start or reconnect. Scoped editor recovery survives explicit disconnection. “Export editor drafts” also retrieves remote recoveries for the currently verified account when the window is local. It never writes those paths on the controller.

Remote v2 requires Node 24, including Electron's Node runtime. Local Bun development still works; Bun cannot enable v2. Stable rejects remote connections. Beta/Canary enable the locally qualified transport; a headless development server requires `SYNARA_REMOTE_CONNECTIONS=1`. Importing Stable state into Beta suspends remote activation and preserves the destination identity. Account profile sync and host secrets sync remain disabled on both client and server.

The outer binary WebSocket carries TLS 1.3. Direct, SSH-forward and Cloudflare use the same authenticated TLS tunnel. The inner RPC WebSocket and typed HTTP resources use a host-specific P-256 root and SAN, never a public-CA fallback or plaintext downgrade. Roots last ten years; server leaves last ninety days and renew thirty days before expiry. Missing or replaced roots require explicit repair and pairing. Keys stay in the installation's private secret store; no system trust-store installation is needed.

The owner creates a nine-minute, single-use code in Settings. The same-account controller redeems it, explicitly compares the root fingerprint across both screens, and requests access. Headless private-file invitation transfer remains available. The controller authenticates the pinned host before submitting its device proof. When the pairing proof also carries the owner's account grant bound to the requesting key (`grant` on `pairing_proof`) and Allow connections is on, the host approves that device in the same step (`enrolledVia: "qr"`); otherwise the owner approves the exact requesting device JKT on the execution host. A cloud grant alone, outside a fresh owner-created code, never authorizes an unapproved device. Turning Allow connections off refuses new sessions and closes live ones without forgetting approved devices. SQLite trust generations and revocation tombstones survive restart. Device-key revocation and WorkOS account-session revocation are separate operations; the UI reports per-host delivery pending until that host acknowledges durable revocation. Authorization snapshots are polled every ten seconds with jitter. A successfully applied snapshot grants a sixty-second lease; expiry closes existing streams, and hard host-proof denial disables the old scope. Offline hosts cannot promise instantaneous revocation.

The controller persists desired connections. Each renderer attachment gets a new RPC stream, including after reload. Renewal prepares a replacement stream; requests are never generically replayed. Discovery/connection completions are fenced against stop, disconnect and account changes. HTTP resources use an independent pool of at most two TLS transports per host generation, bounded queues, streaming backpressure, Range and cancellation. Typed references choose allowlisted host routes; controller cookies and bearer credentials are not forwarded. Remote attachment ownership is stable across short-lived session leases.

## Capacity and setup

Connections are directional: pairing a MacBook to a Mini does not automatically authorize the
Mini to control the MacBook. Each execution host needs its own eligible Synara runtime, account
registration, reachable endpoint and explicit device approval. The tested setup uses managed
Cloudflare tunnels. `--ssh-forward-port` exposes a loopback entry point for manually arranged
SSH forwarding; there is no complete SSH machine/key setup flow or automatic SSH route discovery.

The controller allows eight pending/open RPC streams per destination and 32 overall, including
renderer, renewal and agent-tool streams. These are stream budgets, not a supported computer count.
The supervisor restores only the first 32 desired hosts and runs at most two background dials
concurrently. Each execution host also defaults to 32 outer TLS connections, shared with resource
transports and other controllers. Each connected workspace keeps its own application frame and
caches, so memory grows with connected computers. Large-host-count qualification remains pending;
raising a single limit would not establish support for unlimited connections.

## Headless owner pairing

Run on the execution host, against its existing verified loopback server, using its configured home directory and Node 24. These commands use the same owner RPC and capability gate as Settings; they do not edit trust databases directly.

```sh
synara --home-dir /path/to/isolated-home remote invite --output /private/path/invitation.json
synara --home-dir /path/to/isolated-home remote list
synara --home-dir /path/to/isolated-home remote approve --invite-id INVITE_ID --device-jkt EXACT_REQUESTING_JKT
synara --home-dir /path/to/isolated-home remote reject --invite-id INVITE_ID
```

The invitation file is created exclusively with mode `0600`; its secret is not printed. If a response is lost, inspect the host state before retrying. An existing invitation file is never overwritten. Where the loopback server requires a bootstrap token, use its existing `SYNARA_AUTH_TOKEN` environment configuration.

## Linked projects

“Linked projects” in the host menu opens a controller-origin catalog. Its storage key includes the verified controller EnvironmentId and account authority/user/organization. Opening the catalog records a project-only snapshot of its owning environment; its other entries remain cached metadata. The combined sidebar receives live summaries from every connected workspace. The optional grouping catalog retains its separate snapshot-based behavior.

A checkout is `{environmentId, projectId}`; a thread remains `{environmentId, threadId}` in its original environment. Group names, appearance, members and preferred checkout are local presentation metadata. Linking, unlinking or splitting never moves files or chats. A preferred checkout is a visible preference, not execution failover. Opening another member explicitly checks its host identity and navigates to its workspace inside the same application. Local and remote projects remain visible together. Missing checkouts fail explicitly. Offline catalogs are read-only.

GitHub suggestions normalize SSH/HTTPS and `.git` conservatively and require confirmation. Fork owners remain distinct; multiple repository identities do not produce suggestions. Other Git servers and no-remote projects can be linked manually. The normalization utility preserves significant case and ports on self-hosted servers. Dismissed suggestions and unlink/split corrections persist. Two clones remain two members even on the same computer.

## Unsupported remote surfaces

Agent-controlled browser, dev-server previews, Computer Use, device control, AppSnap and external editors are unavailable in remote execution. Both RPC admission and UI capabilities enforce this boundary. Local clipboard, export of received files and opening public links remain controller operations. Remote folder selection uses the execution filesystem.

## Persistence and verification

Main SQLite migrations 1–108 are unchanged. The historical private account tails are recognized by exact manifests before tracker repair; unknown hybrids fail closed. Usage migrations occupy 109/110, durable remote trust and pairing metadata 111, and desired host state 112. API PostgreSQL migrations are a separate chain: verified device/session binding and revocation delivery records are additive.

Qualification uses disposable SQLite, PostgreSQL and fake WorkOS fixtures, real Node sockets, an HTTPS Cloudflare-boundary fixture, Chromium and Electron. No user state or production account is needed. Relevant owners include `remoteSessions/httpRoute.test.ts`, `hostConnections/resourcePool.test.ts`, `hostConnections/registry.test.ts`, `hostConnections/port.test.ts`, API host authorization tests, execution-storage tests and browser host/catalog/picker tests. `SYNARA_RUNTIME_SMOKE=remote-tls` runs certificate generation/renewal and a 512 KiB encrypted round trip from the built runtime dependency smoke entrypoint.

Two physical Macs, authenticated providers, Linux headless behavior, Windows packaging, signed distribution and network/sleep recovery require separate qualification. A local bundle or Electron fixture does not establish those results. Do not claim release qualification until the corresponding evidence is recorded.

## Historical local qualification before the Cloudflare migration (28 September 2026)

The paragraphs below record the prior relay implementation. Its source and control protocol have since been removed; their regressions remain in Git history. Current migration evidence lives in [STATUS.md](implementation/cloudflare-remote/STATUS.md); do not reuse the old counts or Docker commands for the new transport. The current harness exercises the host gateway through the Cloudflare boundary fixture.

The migrated `apps/e2e` harness uses the production relay application in a Bun child process, the real Node/Effect host gateway, TLS and explicit exact-key owner approval, against isolated PostgreSQL and fake WorkOS. It covers relay/direct bytes, grant replay, account/relay outages, owner-only admission, backpressure and targeted session closure/expiry. It does not launch a paid agent. The inactive Host Secrets cryptographic core retains its tests; server admission for that feature stays disabled.

Run it on Node 24 with an isolated database and `SYNARA_E2E_AGENT=0 TEST_DATABASE_URL=... bun run --cwd apps/e2e test`. Each fixture uses an ephemeral home and loopback ports. This transport suite is separate from the full-workspace qualification below.

The packaged TLS proof ran the built server smoke entry from an isolated `app.asar` with its copied runtime dependencies, using Electron 43.4.1 / Node 24.18.1. It generated P-256 certificates, checked private permissions, renewed the leaf without replacing the root and transferred 524,288 bytes. This is not a signed full application artifact or a Linux/Windows runtime qualification.

A separate build-dependent workflow runs with `SYNARA_E2E_AGENT=0 TEST_DATABASE_URL=... bun run --cwd apps/e2e test:workspace`. It launches two built Node servers, the real Bun relay and Chromium with isolated homes. A deterministic provider CLI replaces only the external provider process. The real adapter and orchestration stream a task, continue while the controller is stopped, and restore the completed transcript after restart without replay. It also checks remote filesystem routing, attachment bytes and hashes across reconnect, approval and cancellation, and local recovery. This establishes fixture-provider continuity, not authenticated provider success. The expanded scenario also passes Git branch and terminal routing, attachment Range requests, revocation cutting off RPC/resources, and provider-process cleanup on host shutdown. Cancelling or refusing a relay splice must preserve the control connection and other sessions; native WebSocket regressions cover both this isolation and deferred errors during opening cancellation. The same browser workflow also interrupts the actual Bun relay during a running turn, records a provider delta while disconnected, and recovers that text after restarting the relay at the same origin without a browser reload. The provider PID and single-turn assertion cover both relay recovery and controller restart. Accelerated authorization expiry and one-use renewal remain separate real-socket tests; this does not claim a one-hour end-to-end credential soak.

The Cua benchmark snapshot test now creates a temporary repository from the actual checkout inputs, preserving its checksum and license assertions. It no longer depends on an unrelated committed `HEAD` while validating pending work.

The root `TEST_DATABASE_URL=... bun run test` command passes the isolated database URL to API/E2E tasks. The E2E package enables development remote admission only inside its Vitest configuration; do not globally opt the server's default-gate tests into remote access. The ordinary root suite skips the build-dependent browser workflow intentionally; run `test:workspace` separately after `bun run build`. The obsolete browser-owned grant/mint helper has been removed: credentials and dialing belong to the controller server.

The browser workflow also verifies the persisted interrupted turn after Stop. Successful parent interrupts retire the runtime generation, which can fence late terminal events; the command reactor now settles the targeted projection after confirmed retirement using the existing session compare-and-set. It preserves replacement turns and leaves targeted child interrupts scoped to the child. The real workflow reproduced the stuck-running state before the fix and passes after it.

## Multi-host renderer qualification (29 September 2026)

The built Chromium workflow now keeps both projects visible, asserts that Connect preserves the
outer renderer, and gives both servers identical project and thread IDs. It alternates local and
remote composers and verifies that each retains its own text. Provider streaming, approval,
connector/controller restart, attachment routing and offline local navigation continue to use the
existing isolated fixture. This is not authenticated provider or signed-desktop qualification.

The implementation deliberately preserves the existing single-environment runtime inside each
application frame instead of making hundreds of ambient API/store reads depend on a mutable
selected-host variable. Only controller WebSocket connection configuration is passed in memory;
it is never placed in the frame URL or persisted with navigation metadata. Remote native-only
capabilities remain denied. Frames stay mounted while another host's chat is visible. Sign-out
removes remote summaries and frames even if recovery storage is unavailable.

The combined sidebar supports opening existing chats and creating chats in a selected remote
project. Cross-host split panes and moving an existing chat between computers are not implemented.
A frame retains one environment's UI and caches, so memory use grows with connected workspaces;
large host counts and file-backed Electron behavior need separate qualification.

The physical MacBook browser check also passed with the Mini connected: a new remote project
chat opens directly from a local chat, its Files pane reads the Mini's directory, and switching
between chats preserves distinct drafts. Same-path projects on both Macs returned their own
README contents. New-chat and catalog navigation wait for the exact destination from the owning
runtime before revealing it; activating an old route must not supersede draft creation. This
live check used the isolated controller's DNS override and did not send a real provider prompt.

## Choosing a computer when starting work

Unsent chats expose a **Run on** computer picker beside the project picker. Selecting another
computer opens that computer's own draft and project choices. The original draft remains on its
owner; text, attachments and an existing provider session are not migrated. Started chats retain
their execution host. Offline computers stay identifiable and unavailable; **Connect a computer**
opens the existing connection setup. Entry points remain gated by the controller's remote capability.

**Create project** now separates its display name from its source folder. Choose a computer before
**Add folder**, browse that computer's filesystem, then confirm the project. A manual path remains
available. Changing computers clears the folder selection; local drops and Spaces do not carry over
to a remote host. The browser uses the same folder UI without requiring a native desktop dialog.
A project still owns one physical folder on one computer. The existing GitHub clone flow remains
available for the local computer; a remote computer can add an existing folder through this dialog.

Folder and project actions retain their selected runtime across awaits. A removed/replaced connection
cannot redirect their completion to another host. The folder picker preserves edits made while a
listing is loading, and cannot confirm an unvisited typed path. Deferred composer autofocus yields
to an open menu or dialog, including when a remote pane first receives focus.

## Unified sidebar

Projects from connected computers participate in the existing Projects list, including its sorting,
manual order, collapse controls, and paging. There is no separate computer block or global computer
switch in the sidebar/footer. Home chats and Studio chats join their respective lists; Activity and
Pinned include remote chats. A muted computer name identifies remote rows and the active chat header.
The existing project, thread, disclosure, and status components provide the shared appearance.
Connection setup remains in Settings and the new-chat computer picker.

Remote folders without chats do not populate the sidebar merely because a computer was connected.
Pinned folders and the active new project remain available. Home/Studio storage containers are not
rendered as ordinary project folders, and unsent drafts are not listed as synthetic “New chat” rows.
Subagent families preserve their owning host and the existing parent/reveal rules. Local Spaces remain
local; an identically named or numbered remote Space does not implicitly acquire local membership.

Every merged row uses an environment-qualified identity. Activity's synthetic IDs are presentation
keys only; opening a remote row uses its original environment and thread ID. Local selection,
dragging, and bulk mark-as-read are not applied to remote Activity rows. Remote chat menus reuse
rename, pin and archive actions on the owning runtime, including its archive confirmation and undo.
Classic and Activity rows share these controls. A captured menu or dialog cannot mutate a
disconnected or replaced workspace. Same-named folders are not automatically grouped as one logical
project.

The outer search palette includes connected-computer project and chat metadata, with computer
labels and disabled results when their host is unavailable. Remote message bodies are not copied
into search. Project/thread IDs remain qualified by environment when choosing a result.
Next/previous and numbered chat shortcuts follow the merged visible rows, including paging and
collapse state; local detail prefetches remain local. Sidebar shortcuts originating in a remote
frame reach the outer sidebar while terminal and model-picker shortcut ownership stays intact.

## Agent tools across computers

The internal Synara MCP gateway follows the executing chat's computer. The sidebar's
combined navigation does not implicitly broaden a tool's target. An agent first calls
`synara_list_connections`, then passes the returned `environmentId` to the existing
project/thread tools. Omitting it retains local behavior. List projects and threads once
per computer; retain `{environmentId, projectId}` and `{environmentId, threadId}` even
when the raw IDs happen to match. Connections belong to the executing server, so a
remote chat does not automatically inherit the viewing computer's outgoing connections.

Supported operations are project/thread listing, provider discovery for an explicit
project, transcript/diagnostic reads, create, send, interrupt, rename, archive, goals,
PR association, and wait. A create/wait batch targets one computer. Remote creation
requires a destination project and checks providers/models on that computer. Durable
creation keys and the one-plan-per-turn limit are scoped by peer, originating
computer/thread/turn, and destination; retrying the exact same creation request returns
the existing result. Remote children are standalone tasks, with no fabricated local
parent. Passive `notifyCreatorOnComplete` delivery is not supported across computers;
use qualified wait/read calls instead.

Both servers need the `agent-gateway.remote-v1` capability. Requests use a separate
paired, pinned-TLS RPC stream and the existing connection lifecycle; no provider MCP
bearer travels to another computer. Disconnect/account changes cancel the stream, and
an inactive originating turn cancels pending writes. The destination enforces the
originating runtime/worktree restrictions. Calls are bounded to two minutes and are
never automatically replayed after a transport failure: an interrupted mutation can
have an uncertain outcome. Recheck its destination before doing more work.

This does not pair new devices, grant computer/browser control, or delegate automations.
The separately paired **External MCP** integration remains local and restricted to its
approved projects/scopes; connecting a computer does not silently expand that grant.

Verification includes colliding IDs, lost authority/account generations, refusal of
unpaired callers and Stable, private-stream cleanup, JSON wire round trips, and a
built two-server fixture that uses a real provider-scoped MCP credential. The provider
process in that fixture is deterministic; it is not a live model or physical-Mac test.
