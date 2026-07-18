# ADR: Local-hosted Mobile Companion

- Status: Accepted
- Protocol: Companion Protocol v1
- Date: 2026-07-18
- Initial design baseline: `f9d365c2070b6491b868b139164a5701e1466afb`

## Context

Synara's server already owns projects, threads, provider sessions, orchestration, event projections,
attachments, authentication, and SQLite persistence. Electron starts that server locally, while
`apps/web` is one client of it. A phone interface therefore does not need a second source of truth or
a cloud synchronization service.

The existing `/ws` surface is intentionally broad: it includes terminals, filesystem access, project
mutation, settings, provider management, automations, and Git mutation. Granting a paired phone access
to that surface would make UI hiding the only security boundary. Its Effect wire format is also an
implementation detail that should not become a permanent mobile application dependency.

## Decision

Synara exposes a separate, versioned Companion Protocol from the existing local server. The desktop
computer remains the only host and source of truth. This change ships an installable PWA at
`/mobile/`. A private Expo client can be built later from the same contracts and client package, but
native application code and Expo Push are intentionally outside this change.

```text
iOS/Android PWA
        |
        | HTTPS + cookie
        | Companion WebSocket
        | Web Push
        |
                  Tailscale Serve HTTPS
                           |
                  127.0.0.1:<fixed-port>
                           |
                    apps/server + SQLite
```

There is no public relay, synchronization database, offline command queue, or Funnel route. The host
being asleep, offline, disconnected from Tailscale, or explicitly quit is a normal unavailable state.

## Repository boundaries

| Component | Responsibility |
| --- | --- |
| `packages/contracts/src/companion.ts` | Schema-only Protocol v1 contracts, method names, errors, snapshots, events, uploads, and push payloads |
| `packages/client` | Framework-independent auth, connection, reconnection, subscription restoration, sequence validation, and typed transport errors |
| `apps/server/src/companion` | Restricted RPC projections/commands, streaming uploads, push outbox/delivery, and cleanup |
| `apps/desktop` | Owner-only control plane, Tailnet diagnostics, fixed-port lifecycle, pairing, device revocation, and tray behavior |
| `apps/mobile-web` | React/Vite/TanStack Router PWA under `/mobile/` with a custom service worker |

`packages/client` contains no React, Electron, DOM storage, or React Native dependency. The PWA owns
its browser adapters and presentation state; a future native client can provide its own adapters
without adding native-only server operations.

## Protocol surface

The WebSocket endpoint is `GET /api/companion/v1/ws`. Its Effect RPC group is declared independently
from the desktop group and contains exactly these methods:

| Method | Purpose |
| --- | --- |
| `companion.hello` | Negotiate Protocol v1 and return server, capability, and session metadata |
| `companion.subscribeShell` | Full authorized shell snapshot followed by ordered shell events |
| `companion.listProjects` | List safe project projections |
| `companion.listThreads` | Cursor-paginated, project/status-filtered thread summaries |
| `companion.getThread` | Read one safe thread detail projection |
| `companion.subscribeThread` | Full thread snapshot followed by ordered thread events |
| `companion.listComposerOptions` | Available provider/model, runtime, and interaction choices for an existing project |
| `companion.createThread` | Create a thread only in an existing project workspace |
| `companion.sendTurn` | Send attachments/text using queue or steer delivery |
| `companion.interruptTurn` | Interrupt the active turn |
| `companion.respondToApproval` | Answer a pending approval request |
| `companion.respondToUserInput` | Answer a pending structured input request |
| `companion.getTurnDiff` | Return a read-only turn diff |
| `companion.getThreadDiff` | Return a read-only full-thread diff |

There is no generic dispatch method. Unsupported protocol versions fail with `ProtocolMismatch`; a
client must not fall back to `/ws`.

Companion projections intentionally omit workspace paths, worktree configuration, raw provider/tool
payloads, terminal output, environment values, and other fields not needed by the mobile UI. Diffs
are read-only. The server returns tagged, bounded errors and does not return stack traces or raw local
paths.

## HTTP surface

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `POST /api/auth/bootstrap` | One-time credential | Issue the PWA's HttpOnly session cookie |
| `POST /api/auth/bootstrap/bearer` | One-time credential | Issue a native bearer session |
| `POST /api/auth/ws-token` | Session | Issue a five-minute WebSocket credential |
| `POST /api/auth/logout` | Session | Revoke the current session and clear its cookie |
| `GET /api/companion/v1/info` | None | Route diagnostics: enabled flag, protocol, and server version |
| `PATCH /api/companion/v1/session/device-label` | Companion-capable session | Change this device's label |
| `POST /api/companion/v1/attachments` | Companion-capable session | Stream one multipart attachment |
| `DELETE /api/companion/v1/attachments/:id` | Owning session | Cancel an unconsumed upload |
| `GET /api/companion/v1/push/config` | Companion-capable session | Read Web Push capability and public VAPID key |
| `POST /api/companion/v1/push-subscriptions` | Companion-capable session | Register/replace a Web Push destination |
| `DELETE /api/companion/v1/push-subscriptions/:id` | Owning session | Remove a push destination |
| `POST /api/companion/v1/push/test` | Companion-capable session | Queue a device-scoped test notification |

Owner-only pairing, device listing, and revocation continue to use the existing `/api/auth/*`
control-plane routes. The Electron renderer never receives the owner credential.

## Authentication and authorization

Authentication records have `full` and `companion` access profiles. Migration 070 defaults and
repairs historical rows to `full` so an upgrade cannot silently reduce desktop access. A normal
mobile pairing link issues `companion`. A full owner session may enter the Companion endpoint for
diagnostics, but it receives only the fixed Companion method set.

The credential flow is:

1. Electron main generates the process-local `SYNARA_AUTH_TOKEN` as before.
2. After the backend is ready, Electron main exchanges it through
   `/api/auth/bootstrap/bearer` for an owner/full bearer session.
3. The owner bearer stays only in Electron main-process memory. Typed, allowlisted IPC methods perform
   pairing, listing, revocation, status, and route-test control-plane work.
4. A mobile pairing link has a 12-character, five-minute, single-use credential. Its URL is
   `/mobile/pair#token=<credential>` so the credential is not part of an HTTP request, referrer, or
   proxy access-log URL. The PWA clears the fragment before rendering; manual entry uses the same
   exchange.
5. PWA exchange returns a 30-day `HttpOnly; Secure; SameSite=Strict` cookie. Native exchange returns a
   30-day bearer value stored by Expo SecureStore.
6. Before each socket connection, the client requests a five-minute credential. Companion sockets
   require both `synara.companion.v1` and a dedicated credential value in
   `Sec-WebSocket-Protocol`; query-string credentials are rejected.

Cookie-authenticated state changes require an exact trusted Origin. Companion WebSocket upgrades also
validate Origin. Native bearer requests do not rely on browser Origin. The desktop persists one exact
`https://<machine>.<tailnet>.ts.net` origin; wildcard hosts, credentials, non-HTTPS schemes, paths,
queries, and fragments are rejected.

A `companion` session is rejected by `/ws`. In remote mode the broad desktop WebSocket is no longer
anonymous; it requires the desktop bootstrap compatibility credential or a full authenticated
session. Authentication failures and bootstrap exchanges are rate-limited, and credential comparison
uses timing-safe verification.

Active sockets are registered by session ID. Revocation or natural session invalidation closes their
leases. Device cleanup deletes push subscriptions and revokes/removes unconsumed upload bodies.

## Commands, idempotency, and streaming

Every mutation contains a client-generated UUID `requestId`. The server derives stable orchestration
command IDs from it, and upload consumption records the same request ID. Retrying an unacknowledged
request after a lost connection therefore returns/reuses the existing command receipt instead of
duplicating a thread, message, approval, interruption, or attachment consumption.

`createThread` accepts a project ID, provider/model, runtime mode, interaction mode, optional title,
and client-proposed thread ID. The server verifies that the project already exists, uses the project's
stored workspace, verifies provider/model availability, and accepts no client path, working directory,
branch, or worktree setting. Approval-required is the UI default; `full-access` is rejected unless the
request explicitly contains `fullAccessConfirmed: true`.

`sendTurn` accepts text, up to eight upload IDs, and `queue` or `steer`. The server rechecks current
thread state so a stale delivery choice returns a typed conflict.

Each subscription starts with a complete authorized snapshot containing `snapshotSequence`.
Subsequent items carry a monotonically increasing, contiguous per-subscription `sequence`. Duplicates
are ignored. A gap, dropped-event report, or `resync-required` item closes the subscription and obtains
a new snapshot.

The client reconnects with jittered exponential delay (1, 2, 4, 8, 16, then at most 30 seconds),
obtains a new short-lived credential, and restores the shell and visible-thread subscriptions. It
replaces in-memory state from each new snapshot. Conversation content and pending mutations are not
recovered from browser storage; acknowledged request IDs are only short-lived in-memory bookkeeping.

## Attachment lifecycle

`POST /api/companion/v1/attachments` accepts one `multipart/form-data` file plus `threadId`, `filename`,
and `mediaType`. Upload bytes stream to a server-controlled temporary path with limits enforced during
streaming. The request may not place metadata after the file body or include unsupported fields.

- Maximum image: 10 MiB.
- Maximum other file: 25 MiB.
- Maximum consumed by one turn: eight attachments.
- Maximum outstanding per session: 16 files and 200 MiB.
- Unconsumed lifetime: 24 hours.

The server discards client paths, sanitizes the basename/media type, validates supported image magic
bytes, and atomically renames the completed body into the normal attachment store. Upload IDs are
bound to the authenticated session and target thread. Consumption is one-time except for an
idempotent replay with the same request ID. Cancellation, expiry, session revocation, and periodic
cleanup remove unconsumed bodies.

## Notification lifecycle

Notifications are projected from persisted `thread.activity-appended` domain events, not from mobile
UI state. Protocol v1 supports `task_completed`, `task_failed`, `approval_required`, and
`user_input_required`. Interrupted or cancelled turns do not generate completion/failure alerts.

Each device registers one current Web Push destination. Destination material is encrypted with
AES-256-GCM using an envelope key from the server secret store; only a SHA-256 identity hash is kept
for deduplication. The persistent VAPID keypair is also held by the secret store. Web Push endpoints
are restricted to the known Apple, Google, and Mozilla HTTPS hosts. Push requests time out after ten
seconds.

Previews default on per device and are limited to 160 characters after control-character removal and
whitespace normalization. Completion previews use sanitized final assistant text. Approval/input
previews use a safe human-readable summary or first question. Failure notifications deliberately use
no provider error body. Raw tool arguments, terminal output, file contents, prompts, secrets,
attachments, paths, and stacks are never copied into push payloads.

The outbox uses an event/device/kind dedupe key. Pending deliveries expire after 24 hours, transient
failures retry up to five attempts, and HTTP 404/410 disables the destination. Delivery diagnostics
are retained for seven days. Startup replays still-deliverable
domain events into the deduplicated outbox, and delivery/cleanup run periodically.

The service worker suppresses an OS notification when a visible PWA window already has the target
thread open and sends an in-app refresh event instead. Otherwise notification click focuses or opens
`/mobile/threads/<threadId>`. There are no lock-screen approve/deny actions.

## Network and desktop lifecycle

Remote access is opt-in. While disabled, Electron preserves its random loopback-port behavior. While
enabled, the backend restarts on the configured unprivileged port (3773 by default), still bound to
`127.0.0.1`. A port conflict fails visibly; Synara does not select another port.

The desktop reads `tailscale status --json` and `tailscale serve status --json`. It discovers the
machine DNS name, checks that the root handler for that name proxies the exact loopback target, and
detects Funnel. It never runs Serve, Funnel, or reset commands. Pairing is gated on enabled remote
access, connected Tailscale, an exact saved/discovered origin match, an exact Serve target, no Funnel,
and a successful HTTPS `/api/companion/v1/info` route test.

Enabling remote access defaults keep-running-on-close on and leaves launch-at-login off. Closing the
last window hides Synara only when a tray/menu-bar icon exists. The tray can show Synara, report
status, copy the mobile URL, open pairing settings, pause remote access, or explicitly quit. Linux
prompts instead of leaving an invisible process if no usable tray exists. Explicit quit, shutdown,
and update installation stop the backend normally.

Pausing/disabling closes Companion sockets and stops push projection/delivery but preserves device
records and does not alter Tailscale configuration. Revocation cleanup continues so stale device
authority is removed. Resetting Serve and revoking all devices remain explicit, separate actions.

## Persistence

The change uses additive migrations:

| Migration | Change |
| --- | --- |
| `070_AuthAccessProfile` | Add/index `access_profile` on pairing links and sessions; normalize existing values to `full` |
| `071_CompanionAttachmentUploads` | Add session/thread ownership, safe storage metadata, expiry, consumption, revocation, and cleanup indexes |
| `072_PushSubscriptionsAndDelivery` | Add encrypted subscriptions, notification outbox, per-device deliveries, dedupe, retry, and expiry indexes |

Migrations remain in place if the feature is rolled back. Consumed attachments are normal Synara
attachments and must not be deleted by Companion cleanup.

## PWA cache and presentation boundary

The PWA is built with base path `/mobile/` and bundled by the server build into
`dist/client/mobile`. The server applies SPA fallback within `/mobile/*`, serves HTML and dynamic
responses as `no-store`, and gives hashed assets immutable caching.

The custom service worker precaches only the application shell, hashed JavaScript/CSS, fonts, and
icons. It does not cache projects, threads, messages, diffs, attachments, auth responses, WebSocket
data, or notification previews. On disconnection the application clears authorized content from its
active state and shows only the connection screen. It queues no offline mutations or uploads.

Markdown is rendered without raw HTML. External links require confirmation before opening. Transcript
and diff lists are virtualized, and the UI accounts for safe areas, dynamic viewport height, reduced
motion, keyboard interaction, and mobile back navigation.

## Compatibility and versioning

Protocol v1 may add optional fields without changing its version. Removing a field, changing its
meaning, adding a required field, or changing sequence semantics requires a new protocol version.
Existing desktop RPC behavior remains supported, and legacy persisted authentication rows decode as
`full`.

The PWA and server should be shipped from the same revision. A newer server must continue to support
the existing desktop client; an older server is not expected to understand a newer Companion client.

## Rejected alternatives

- **Expose `/ws` and hide methods in the mobile UI:** rejected because it is not a server-side
  authorization boundary.
- **Bind Synara to a LAN or Tailnet interface:** rejected because the backend should remain loopback
  only and let Tailscale terminate private HTTPS.
- **Use Tailscale Funnel:** rejected because it creates public internet exposure.
- **Add a cloud backend/synchronization store:** rejected because it introduces a second source of
  truth, multi-user authorization, and data residency concerns outside this feature.
- **Cache conversations or queue commands offline:** rejected because the device would retain
  sensitive workspace state and could replay stale approvals or mutations.
- **Send attachments through WebSocket base64:** rejected due to memory overhead, payload expansion,
  and poor cancellation/backpressure behavior.

## Consequences

- Mobile access depends on a running, awake, Tailnet-connected desktop host.
- The server carries explicit projection and authorization code instead of returning desktop records
  verbatim.
- Push notification metadata leaves the host through platform push infrastructure when enabled;
  users can disable previews or notifications per device.
- Real-device behavior depends on iOS/Android, browser, Tailnet policy, and push-provider behavior that
  unit/integration tests cannot fully reproduce.
- A future native distribution through TestFlight or Google Play Internal Testing will require a
  separate implementation, Expo project, signing credentials, push credentials, and store accounts.

## Security invariants

1. A companion session cannot authenticate to `/ws`.
2. The Companion RPC group contains no terminal, arbitrary filesystem, settings, provider-management,
   automation, project-mutation, pull-request-administration, or Git-mutation operation.
3. Pairing credentials and WebSocket credentials do not appear in HTTP request URLs or access logs.
4. Cookie state changes and browser sockets require the exact saved HTTPS origin.
5. Revoking a session closes its sockets and removes its unconsumed upload/push authority.
6. Server errors and mobile projections expose no stacks, secrets, raw tool payloads, or unrestricted
   local paths.
7. No mobile client stores conversation state or pending mutations for offline use.
8. Remote mode remains bound to loopback and is never paired while Funnel is detected.

## Validation boundary

Repository tests, package typechecks, production builds, migration tests, and static security checks
are necessary but not sufficient for release. The feature remains experimental until the
[Mobile Companion release checklist](../mobile-companion-release-checklist.md) passes on real iOS and
Android devices through an actual Tailnet, including background/closed-app push, host sleep/wake,
session revocation, and maximum-size streaming uploads. Expo/EAS distribution remains future work
and is not part of this PWA release.
