# Mobile Companion Experimental Release Checklist

Use this checklist for experimental desktop releases that include Companion Protocol v1. It
supplements the repository release process in [release.md](release.md) and the design constraints in
the [Mobile Companion ADR](architecture/mobile-companion.md).

Do not treat repository tests as evidence that Tailnet routing, platform push, background execution,
or install behavior works on physical devices. Record those results separately in the release notes.

## Release identity and scope

- [ ] Record the release commit, desktop/server/PWA version, build platform, and build timestamp.
- [ ] Keep **Remote Access / Mobile Companion** labeled **Experimental** and off by default.
- [ ] Confirm the release contains the server, desktop, `/mobile/` PWA, contracts, and
  `@synara/client` from the same revision.
- [ ] Confirm no native application or native-only backend operation is included; this release is
  the PWA implementation of Companion Protocol v1.
- [ ] Review the diff for generated builds, source maps, databases, uploaded files, `.env` files,
  credentials, VAPID private material, local settings, signing files, or EAS secrets.

## Build and automated checks

Run checks through package scripts (`bun run test`, never bare `bun test`) and follow the repository's
authorization requirements for formatting, linting, and typechecking.

- [ ] Install with the frozen lockfile and confirm the lockfile does not change.
- [ ] Run contract serialization/compatibility tests and build `@synara/contracts`.
- [ ] Run `@synara/client` auth, reconnect, sequence-gap, and idempotency tests and build the package.
- [ ] Run affected server tests, including auth, restricted RPC, projection, upload, push, static
  route/cache policy, trusted Origin, startup access, and migrations.
- [ ] Run desktop Remote Access, Tailscale diagnostics, owner control-plane, IPC authorization,
  fixed-port, readiness, and tray lifecycle tests.
- [ ] Run desktop-web Remote Access settings tests.
- [ ] Run PWA pairing, cache policy, request-ID, routing, and service-worker tests; typecheck both app
  and service-worker configurations.
- [ ] Confirm Expo/React Native dependencies are absent from the PWA release lockfile.
- [ ] Build the production server and inspect that it bundles `/mobile/index.html`, the service
  worker, manifest, icons, and hashed assets under the expected server client directory.
- [ ] Measure the initial PWA JavaScript; keep it at or below 350 KiB compressed before on-demand
  thread/diff chunks.
- [ ] Run `git diff --check` and resolve errors. Platform line-ending notices alone are not content
  failures.

Record the exact commands and results in the pull request or release evidence. Do not replace a failed
full-suite run with a smaller passing subset without documenting the reason and remaining coverage.

## Migration and compatibility gate

- [ ] Apply migrations `070_AuthAccessProfile`, `071_CompanionAttachmentUploads`, and
  `072_PushSubscriptionsAndDelivery` to a copy of an existing Synara state database.
- [ ] Confirm existing pairing/session rows receive `access_profile = 'full'` and still authenticate
  to the desktop surface.
- [ ] Confirm existing projects, threads, attachments, settings, and provider configuration remain
  readable after migration.
- [ ] Confirm a new mobile pairing creates a `companion` session and does not change existing owner
  sessions.
- [ ] Restart the upgraded server and verify session, upload cleanup, outbox recovery, and desktop RPC
  behavior.
- [ ] Verify migration rollback policy: leave additive tables/columns in place; do not downgrade the
  user's SQLite database.

## Authentication and authorization gate

- [ ] A `companion` session is rejected by `/ws`.
- [ ] When remote mode is enabled, `/ws` is not anonymously reachable and accepts only the desktop
  compatibility credential or a valid full session.
- [ ] `/api/companion/v1/ws` exposes only the fixed v1 RPC group and contains no generic dispatch
  method.
- [ ] Attempts to invoke terminal, filesystem, project mutation, settings, provider management,
  automation, pull-request administration, or Git mutation operations fail at the server boundary.
- [ ] A full owner session entering the Companion endpoint still receives only Companion operations.
- [ ] Pairing credentials are 12 characters, single-use, expire after five minutes, and are rate
  limited.
- [ ] The QR pairing credential remains after `#token=` and is cleared by the PWA before normal
  rendering; it never appears in HTTP request targets, referrers, or server access logs.
- [ ] PWA bootstrap issues `HttpOnly; Secure; SameSite=Strict`; native bootstrap issues a bearer
  session; both expire after 30 days.
- [ ] WebSocket credentials expire after five minutes, are sent only through the dedicated
  `Sec-WebSocket-Protocol` value, and are rejected from a query string on the Companion endpoint.
- [ ] Cookie-authenticated mutations and browser sockets accept only the saved exact Tailnet HTTPS
  Origin and reject missing, opaque, wildcard, lookalike, path-bearing, and unrelated origins.
- [ ] Desktop owner bootstrap completes after each backend start/restart; the owner bearer exists only
  in Electron main-process memory and is never sent through renderer IPC or persisted.
- [ ] Renderer IPC rejects untrusted/subframe callers and exposes only the explicit Remote Access
  control-plane methods.
- [ ] Device revocation and session expiry close active socket leases and prevent subsequent HTTP,
  upload, and push work.
- [ ] Client-facing errors contain no stacks, secrets, environment variables, raw payloads, or
  unrestricted filesystem paths.

## Desktop and Tailnet gate

- [ ] With Remote Access disabled, the desktop keeps its existing random loopback-port behavior,
  `/api/companion/v1/info` reports `enabled: false`, and restricted Companion data/socket routes
  return `404`.
- [ ] Enabling Remote Access restarts on exactly `127.0.0.1:<configured-port>` (3773 by default).
- [ ] A port conflict produces an actionable failure and never an unannounced port change.
- [ ] Test Tailscale CLI missing, signed-out, stopped, malformed status, no MagicDNS name, matching
  Serve, no Serve config, different root target, and Funnel-detected states.
- [ ] Confirm diagnostics only run `tailscale status --json` and
  `tailscale serve status --json`; Synara never signs in, enables Serve/Funnel, or resets routes.
- [ ] Save only the exact discovered `https://<machine>.<tailnet>.ts.net` origin and reject paths,
  query strings, fragments, credentials, wildcards, and non-HTTPS schemes.
- [ ] Confirm pairing remains disabled until Remote Access is enabled, Tailscale is connected, the
  saved/discovered origin matches, the root Serve handler targets the exact loopback port, no Funnel
  is present, and the HTTPS route test succeeds.
- [ ] Verify the copied Serve command targets the configured port and the mobile/pairing URLs use the
  exact saved origin.
- [ ] Confirm **Test route** reaches an enabled Protocol v1 `/api/companion/v1/info` response and does
  not follow an unrelated redirect.
- [ ] Verify enabling Remote Access defaults **Keep Synara running** on and leaves
  **Launch at login** off.
- [ ] Closing the last window hides it only when the opted-in tray/menu-bar lifecycle is available;
  the first close explains that Synara is still running.
- [ ] Exercise **Show Synara**, status, **Copy Mobile URL**, **Pair a Device**, **Pause Remote
  Access**, and **Quit Synara** tray actions.
- [ ] On Linux with no usable tray, confirm close prompts instead of leaving an invisible process.
- [ ] **Pause/disable** closes Companion access but preserves devices and never changes Serve;
  **Quit** stops the backend; **Revoke all devices** affects only Companion sessions.

## PWA functional gate

Test at minimum 390x844 and 430x932 viewports, in light/dark mode and with reduced motion.

- [ ] Pair by QR fragment and by manual code; test expired, consumed, malformed, and rate-limited
  credentials.
- [ ] Complete install/notification onboarding and edit the device label.
- [ ] Browse/search/filter existing projects and threads; verify no filesystem, repository, branch,
  worktree, provider-configuration, or secrets controls appear.
- [ ] Create a thread only in an existing project. Verify provider/model availability is server
  supplied, approval-required is the default, and full access requires explicit confirmation.
- [ ] Stream a response and activity updates without per-token layout failure; exercise queue, steer,
  interrupt, approval, and multi-question structured input.
- [ ] Force a delivery-state race and confirm queue/steer returns a typed conflict rather than applying
  stale intent.
- [ ] Inspect turn/thread diffs, large file lists, and long transcripts; verify virtualization and no
  Git mutation controls.
- [ ] Check keyboard-open composer behavior, safe-area navigation, Android back behavior, focus order,
  accessible labels, contrast, reduced motion, and minimum 44x44 touch targets.
- [ ] Verify Markdown raw HTML is not rendered and every external link requires confirmation.
- [ ] Lose the connection during a stream. Confirm exponential reconnect, a fresh WebSocket token,
  snapshot replacement, duplicate suppression, and sequence-gap resynchronization.
- [ ] Reload while offline and confirm only the application shell/connection screen remains: no
  projects, threads, transcript, diff, attachments, notification previews, or queued commands.
- [ ] Confirm retry occurs on browser online/visibility changes and explicit user action.

## Attachment gate

- [ ] Upload a valid 10 MiB supported image and 25 MiB supported non-image while monitoring that the
  body is streamed over HTTP rather than buffered as WebSocket base64.
- [ ] Verify one upload per multipart request, metadata before the file, a maximum of eight attachments
  per turn, and progress/cancel/retry behavior.
- [ ] Reject empty, oversized, mismatched declared/multipart type, invalid image signature, SVG or
  unsupported image type, malicious filename/path, extra multipart field, multiple-file, foreign
  session, wrong-thread, duplicate-ID, expired, revoked, and already-consumed uploads.
- [ ] Verify the same `requestId` can safely retry consumption while a different request cannot consume
  the upload twice.
- [ ] Reach the per-session outstanding limit (16 uploads/200 MiB) and confirm the next reservation is
  rejected without leaving a body behind.
- [ ] Verify cancel, 24-hour expiry, session revocation, startup cleanup, and periodic cleanup remove
  unconsumed bodies while consumed normal attachments remain.
- [ ] Confirm browser blobs are released after upload and no attachment body enters Cache Storage,
  IndexedDB, or localStorage.

## Notification gate

- [ ] Create one persistent VAPID keypair and envelope key through the server secret store; confirm
  private material is absent from responses, logs, and packaged output.
- [ ] Register, update preview preference, replace, remove, expire, and revoke a Web Push subscription.
- [ ] Reject non-HTTPS, credential-bearing, non-default-port, root-only, unknown-host Web Push
  endpoints.
- [ ] Produce completion, failure, approval, and input domain events and verify the durable outbox is
  populated once per event/device/kind.
- [ ] Verify interruptions/cancellations do not create completion or failure notifications.
- [ ] Verify previews are at most 160 sanitized characters and never include control characters, raw
  tool arguments, terminal output, file contents, prompts, secrets, attachment data, paths, or stacks.
- [ ] Verify failures use a generic notification body and per-device preview-off omits the preview.
- [ ] Confirm a visible PWA already on the target thread receives an in-app refresh and suppresses the
  OS notification; otherwise click opens/focuses the correct thread route.
- [ ] Confirm there are no lock-screen approve/deny actions.
- [ ] Exercise transient retry through five attempts, ten-second network timeout, 24-hour expiry,
  startup recovery/deduplication, 404/410 invalidation, and seven-day
  diagnostic cleanup.
- [ ] Inspect logs and confirm they contain no push endpoint/token, encrypted subscription plaintext,
  notification preview, auth token, or full prompt.

## Real-device acceptance

These checks require a real Tailnet and physical devices. Record OS, browser/PWA, Synara, and Tailscale
versions plus the Tailnet policy used.

- [ ] Install and pair a current iPhone/iPad Home Screen PWA through private Tailscale Serve HTTPS.
- [ ] Install and pair a current Android Chrome PWA through private Tailscale Serve HTTPS.
- [ ] On both devices, run the full browse/create/stream/queue/steer/interrupt/approve/input/diff flow.
- [ ] On both devices, upload the maximum supported image and file from camera/gallery/file picker as
  applicable.
- [ ] Validate notification permission accepted, denied, and unavailable states.
- [ ] Validate completion, failure, approval, and input notifications in foreground, background, and
  fully closed PWA states; confirm lock-screen preview behavior and preview disabling.
- [ ] Exercise desktop-window close with tray host alive, explicit quit, host sleep/wake, Tailscale
  disconnect/reconnect, Tailnet ACL denial, expired session, and live device revocation.
- [ ] Confirm disconnect/reload exposes no cached conversation data and queues no mutation.

Do not call the PWA MVP complete until these real-device checks pass. A desktop-only CI or local test
run cannot close this gate.

## Expo private-beta gate

Future work only. Run this separate gate after Protocol v1 and the PWA are stable; no native source,
Expo Push transport, EAS configuration, or signing material belongs in the initial PWA release.

- [ ] Configure a real Expo project ID without committing account or signing credentials.
- [ ] Verify bearer bootstrap and session persistence in Expo SecureStore, QR/manual pairing, native
  file/photo picking, deep links, and session revocation.
- [ ] Register a real Expo push token and repeat the four notification-kind and preview tests.
- [ ] Build signed artifacts through EAS and distribute only through TestFlight and Google Play
  Internal Testing.
- [ ] Record app/build identifiers, signing owner, tester groups, rollback build, and store-review
  limitations.

## Rollout

- [ ] Enable only through the explicit opt-in setting and keep the default disabled for upgraded
  users.
- [ ] Publish setup/troubleshooting instructions from [REMOTE.md](../REMOTE.md), including Funnel and
  lock-screen preview warnings.
- [ ] Include known device/browser/Tailscale limitations and the real-device evidence in release notes.
- [ ] Confirm local diagnostics do not emit external analytics and no telemetry leaves the host.
- [ ] Monitor local connection count, reconnect reasons, push outbox depth/result categories, and
  upload/outbox cleanup failures without logging sensitive payloads.

## Rollback

Mobile Companion changes are additive. If a release must disable the feature:

1. Turn off **Remote Access / Mobile Companion** (or ship the feature flag disabled). This closes
   Companion sockets and stops push projection/delivery while leaving desktop RPC and data intact.
2. Leave migrations 070-072 in place. Do not downgrade or rewrite the user's SQLite database;
   historical auth rows retain the backward-compatible `full` access profile.
3. Do not automatically change Tailscale Serve. Explain that its private route may remain. If the user
   wants to remove it, they must review and run `tailscale serve reset`; the command affects every
   Serve route on that device.
4. Offer explicit **Revoke all devices**. Disabling the endpoint intentionally preserves paired-device
   records; revocation deletes their push subscriptions and unconsumed upload authority.
5. Preserve attachments already consumed by normal Synara turns. Clean only expired, cancelled,
   revoked, or otherwise unconsumed Companion upload records through the normal cleanup path.
6. Verify the desktop app returns to its existing random loopback-port lifecycle and standard desktop
   workflows remain available.

If only push delivery is faulty, disable the push worker and test-notification control while keeping
the authenticated Companion endpoint available. Do not revoke sessions or remove conversation data as
an incidental push rollback.
