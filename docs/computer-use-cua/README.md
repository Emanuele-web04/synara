# Computer Use: current implementation and qualification

This directory contains implementation notes and historical experiments. It is
not a release certification. Results belong to the exact application, driver
revision, platform and provider named in each report; an older passing fixture
does not qualify the current branch.

The current driver is Cua 0.28.2 with Synara native revision 38. The
[release manifest](../../packages/shared/src/cuaDriverRelease.json) is the source
of truth for source, patch checksum and Rust version. Packaging must verify the
staged artifact against that manifest. The checked-in
[patch](../../apps/desktop/patches/cua-driver/0001-synara-native.patch) and
[upstream license](CUA-LICENSE.txt) preserve provenance. The separate
[Linux browser patch](../../apps/desktop/patches/cua-driver/0002-synara-linux-browser.patch)
adds a narrow headless-browser runtime; it does not inherit macOS desktop-input
guarantees. Its runtime admission requirements are listed below.

The [remote-feedback follow-up](remote-feedback-fixes-2026-09-21.md) describes
the current input, provider and concurrency corrections and their runtime limits.

## Isolated packaged build

Build the test application with an explicit flavor, rather than modifying a
production bundle after packaging:

```bash
bun run dist:desktop:artifact --platform mac --target zip --arch arm64 --flavor cua --keep-stage
```

This produces `Synara Cua.app`, bundle ID `com.emanueledipietro.synara.cua`,
origin `synara-cua://app`, default home `~/.synara-cua`, and Electron profile
`synara-cua`. Artifacts go to `release-cua/`. The flavor is embedded in the
staged package before signing and cannot be changed by `SYNARA_DESKTOP_FLAVOR`
at launch. The production updater is disabled for Cua and Canary packages.
Local macOS Cua and Canary packages use electron-builder's ad-hoc signing pass
to seal the flavor's bundle identity, Info.plist, resources and nested code with
the existing entitlements. ZIP finalization verifies that identity before and
after extraction. Use the release signing options when a Developer ID signed
build is required; ad-hoc signing is not release signing or notarization and
does not guarantee that TCC grants persist across rebuilds.

`--flavor canary` follows the same identity rules. Omitting the flag builds
production, including when the invoking shell has a source flavor set. Isolated
flavors support macOS and Linux; Windows continues to use its existing production
installer registration. Source development launchers keep their existing
environment-based flavor selection. For a new packaged Cua smoke run, set both
`SYNARA_HOME` and `SYNARA_DESKTOP_SMOKE_USER_DATA` to separate empty test
directories; no source launcher marker is needed.

## Using Computer

Type `/computer-use` followed by a task, for example `/computer-use open
Calculator and calculate 123 × 45`. The shared slash menu offers this command
for every provider. It enables native Synara Computer for that request only;
the next ordinary turn has no new Computer tools or guidance. The command is
stored with your message but removed before provider delivery. An empty command
stays in the composer so you can add the task.

To use Computer by default, enable **Computer control** in Settings. That is a
separate opt-in for every turn and adds Computer context to ordinary requests.
An app name, quoted command, attached file or agent-generated text does not
invoke Computer. The **Getting started** guide explains setup, approval, preview
and Stop and can be dismissed and reopened without another startup dialog.

An explicit invocation checks the actual AppSnap grant state for the local
macOS host; idle backend connectivity does not prove permissions. Remote hosts
and unsupported AppSnap platforms do not request the client Mac's grants. If
local grants are missing, the shared permission guide opens
and the task stays unsent in the composer. Send it after setup; granting access
never sends it automatically. Queued requests retain their original activation
and generation, so a later Stop or revoke cannot silently re-arm old work.
System permission grants and an AppSnap attachment do not themselves authorize
Computer actions.

When the selected approval mode requires it, one Computer approval covers
routine actions in the active task. Clipboard reads keep their existing
separate approval rule. Provider reviews and consequential-action policies
still apply: task consent is not a detector for every Delete, Send or Purchase
button. Full access does not authorize foreground use. To watch an app in front,
request it explicitly, for example “Show me the browser.” Naming an app alone
does not grant that authorization.

The transcript uses the Computer cursor icon and human action labels for native
and browser calls, including compact inspection calls. Summaries omit typed
text, clipboard contents and upload paths. [Preview](native-preview.md) shows
the addressed window or browser tab. Closing the preview hides it; **Stop** in
the chat ends the task.

## Tools and context cost

- Synara owns provider capability, task consent, targeting and cancellation.
  The authenticated desktop host owns the native child process. A socket path
  or a claimed bundle identifier alone does not grant access.
- All nine provider adapters have Computer integration. Live task completion
  across all nine providers on the current packaged build remains unverified.
- Computer tools are conditional on the session's capability. Pi installs no
  Computer descriptors in disabled sessions and retains its existing specialist
  forwarders while enabled. Disabled turns receive no new Computer schemas or
  Computer block in shared host guidance. Previous Computer observations can
  remain in provider-managed history; removing current exposure does not erase
  historical token cost.
- Foreground native actions and visible browser preparation require an explicit
  visible-use request in the latest user-authored message. Negative or ambiguous
  requests remain background. This is conservative text matching, not a general
  natural language authorization system.
- On macOS, browser work can use a driver-owned headless Chromium profile.
  Reusing the same browser executable does not attach to the user's profile or
  cookies. Existing-profile launch/attachment through that prepare route is
  unsupported in this embedding. Linux launch has separate limits below.
- The advertised `computer_run` batches up to 25 known desktop steps. All steps
  are validated before dispatch and retain targeting, consent and refusal
  checks. It stops on failure by default. It accepts no browser steps or
  per-step screenshots; a final screenshot can cover the affected window.
- `computer_inspect` reaches the clipboard-read, zoom, desktop-inventory,
  cursor-position and managed-Space handlers. It retains their permission and cancellation
  behavior. `computer_help({tool: "computer_zoom"})`, for example, returns the
  exact schema and inspection route. Other hidden specialists expose a batch
  route. Help lookup does not install another tool in the provider catalog.
- `computer_help` serves guidance only when requested. Topics include browser,
  menus, forms, foreground use, Finder, Notes/editors, terminals, Electron,
  Calculator, Slack and Spaces. These app chapters are not all injected into
  every active turn. See the [shared guidance](../../apps/server/src/agentGateway/computerGuidance.ts).
- State reads default to bounded text/element data without an image. Actions
  still include a post-action screenshot by default; short batches can omit
  intermediate images and finish with fresh state or a screenshot. Internal
  text-field readback disables screenshot capture. Unknown dispatch
  remains unknown until there is action-specific evidence. Successful dispatch
  or a changed tree alone is not proof that the requested task succeeded.
- Browser navigation proof covers the destination, not the requested page
  task. DOM value readback covers a field, not submission. Download completion
  needs the driver's completed receipt and file proof. Pointer/key dispatch
  can still be unverified; observe the expected result instead of replaying it.
- Preview frames are local UI feedback, not an automatic screenshot stream to
  the provider. Resource and token savings still require equal-workload
  measurement; smaller descriptors alone do not establish billing or latency.

## Permissions and interruption

### Task and application boundaries

On the patched macOS backend, independent tasks can target different apps
without holding the whole desktop while their providers think. Native input
transactions remain serialized. Keyboard, pointer and modal operations reserve
their app process; pure semantic operations reserve their exact window.
Foreground operations, clipboard use and drag gestures retain exclusive desktop
ownership. Other backends retain their existing conservative ownership rules.
Concurrent tasks use still observations when preview ownership cannot be proven;
a shared native preview stream is not attributed to both tasks.

Stopping an idle or queued task cancels that task's work. Interrupting an active
native mutation still drains the shared driver before input resumes, and affected
tasks must observe again. The global emergency Stop continues to stop all input.

Explicit permission to show the app persists through routine continuations such
as “continue” or “retry”. A new task, a stop/background request, imported history,
or an automated/agent-authored message ends it. An app name alone never grants
foreground access. Full access still does not authorize moving the user's screen.

Background launch asks macOS not to activate the app; an app may activate itself.
An observed `focusChangedDuringLaunch` is returned and pauses subsequent input
until fresh observation. The launch is never replayed or countered with a focus
restoration loop. Hidden/off-Space windows permit retained semantic writes and
AX actions when the native backend proves the exact target; pixel input still
requires an available window. Normal modal controls must belong to the active
dialog, and authentication/security dialogs remain protected.

Use an observed field `ref` with `computer_press_key` for background Enter/Return.
The reference reaches the native exact-element route in standalone and batch
calls. A generic shortcut can still be refused when its actual destination is
ambiguous. `focused` denotes the agent's selected target; optional
`keyboardFocused` reports the app's actual keyboard window when proven.

Pi requires the Computer catalog during enabled startup, and Synara-managed
OpenCode requires its thread-scoped MCP connection to be ready. An external
OpenCode server cannot currently receive that isolated Computer connection.
Antigravity retains undelivered Computer guidance when process startup fails.
These checks prevent a missing tool connection from appearing as a ready session;
they do not certify every provider/model or application combination.

Computer and AppSnap reuse the same desktop permission service and native setup
guide. Computer requests three macOS grants:

| Grant            | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| Accessibility    | Read controls and deliver native input.                        |
| Input Monitoring | Detect physical Escape and human takeover during Computer use. |
| Screen Recording | Capture screenshots and preview frames.                        |

Choose **Set up** in Computer settings. The guide checks the running app and
opens only its next missing pane, in Accessibility → Input Monitoring → Screen
Recording order. Use the app chip where the pane accepts drag and drop, or
enable the exact existing app entry. Fresh helper checks advance the guide
while System Settings is in front; merely dropping the app or seeing its name
in the list never counts as granted. The renderer also refreshes when returning
from Settings. Guide monitoring stops on completion, dismissal or its bounded
timeout; setup does not make model calls or send screenshots.

Before an explicit setup attempt, the shared service verifies that macOS can
locate this exact app bundle. It tries the supported LaunchServices registration
API once when necessary; a successful registration call alone is not enough.
If macOS still cannot locate the app, setup stops with instructions to move it
to Applications and reopen. If macOS resolves another copy, quit the other
copies and reopen the installed copy before trying again. Passive status
checks do not register apps, change grants or start a setup guide.

AppSnap remains independent. Its shortcut/picker uses Input Monitoring and
Screen Recording; granting these for Computer does not enable the AppSnap
shortcut. Missing Screen Recording removes image capture while supported
semantic reads can remain available. Missing Accessibility or Input Monitoring
blocks native control. The Input Monitoring grant and listener health are
checked separately: a granted switch cannot stand in for a working listener.
The listener starts lazily for Computer and reports readiness/failure; while
unavailable, native input is refused. It stops its tap and recovery work when
disarmed.

If Settings shows a switch on but the fresh check reports denied, verify the
exact running app and signing identity. Local ad-hoc rebuilds can leave a stale
grant. Remove and re-add that exact updated copy, then complete macOS
authentication or Quit & Reopen when requested. Restarting alone does not
repair a stale signing requirement. Synara cannot diagnose that mismatch from
the granted/denied result; it does not reset grants automatically or treat a
rebuild as permission. Signed-build grant
persistence still needs real validation.

| Event                                   | Implemented recovery boundary                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat Stop or task cancellation          | Ends the current task and fences its queued work. A subsequent user request can start a new task; old actions are not replayed.                                                                                                                                                                                                    |
| Physical Escape                         | Interrupts native and browser input. Each route requires a fresh model observation before continuing. No manual re-arm or repeated routine-task approval is added.                                                                                                                                                                 |
| Human input in the controlled target    | Invalidates the model's view of the exact task/window or browser target/tab and interrupts input. Repeated typing keeps observations stale. Input in another app does not interrupt a background target; during foreground input, physical input does. Input resumes after quiet and fresh state, retaining the same task consent. |
| Lock, sleep or inactive desktop session | Pauses input. Returning requires fresh state and renews routine-task consent in approval-required mode. Full access retains its standing approval mode.                                                                                                                                                                            |
| Permission or listener loss             | Refuses new native input; recovery must restore the relevant grant/listener and obtain fresh state.                                                                                                                                                                                                                                |

The patched macOS driver acknowledges an input epoch, drained operations and
matching releases before input can reopen. Transport cancellation alone is
not cleanup proof. A missing acknowledgement leaves input paused. Escape and
takeover preserve browser bindings. Native and browser observation gates are
separate: previews, readiness probes, discovery, and another task/window/tab
cannot clear them. Isolated browser setup may create a new target while the old
one is paused; the new page still needs its own model observation. Physical-input
and signed-app qualification remain required for this revision.

## Recent action history

**Settings → Computer use → Recent Computer actions** reads retained mutations
across chats on the current server. Open it to load 30 entries, request older
entries up to 100, or refresh explicitly. It does not poll while working.
Rows distinguish **Effect observed**, **Sent; effect unconfirmed**, **Not sent**,
**Blocked** and **Failed**; a row is not proof that the whole task succeeded.

The owner-only `computer.getAuditHistory` API exposes no arguments, results,
targets, titles or paths. Read bounds are 2 MiB and 10,000 lines; retention,
invalid records or an expired cursor can omit older entries and are surfaced
as truncation. I/O failures remain errors. The viewer is not a complete tool
transcript, replay system or token-accounting source. Recording/replay, durable
per-app grants and manual re-arm APIs remain removed; their older documents
are historical.

## Linux and Spaces boundaries

Linux packaging stages the driver outside ASAR and starts an authenticated
host. Browser mutations open only when that host validates revision 32 and the
`synara_browser_input_control: 1` capability from its own driver generation,
and a task-scoped Escape shortcut is available. The qualified code path owns
isolated headless browser profiles and pairs browser cancellation with release
cleanup. Visible browser launch, personal-profile setup and native desktop
input remain unavailable; foreground consent does not bypass those boundaries.

The Escape adapter works only on a positively identified direct X11 session.
It registers while attributed Computer tasks are active and unregisters on the
last task ending, Stop or disposal. It consumes Escape and is not the macOS
listen-only human-input monitor. Native Wayland and XWayland refuse mutation
because portal callback registration does not prove a working, task-scoped
global Escape binding. A shortcut conflict or lost/suspended registration also
closes mutation admission.

Without both runtime capability and Escape availability, browser support is
observation-only: current state, dialog inspection and passive detection of an
existing endpoint. Standalone Linux has no global Escape adapter and stays
observation-only even with the patched artifact. Missing capabilities must not
trigger a visible-launch or personal-profile workaround.

Native pointer/keyboard input, semantic writes, app launch, menus, activation
and window-frame changes are refused on Linux, including with foreground
consent. Clipboard, process-control and the agent overlay retain their existing
approval rules. Native accessibility reads can be available even when integrated desktop
observation cannot start. On pure Weston and Sway, the upstream screen-geometry query
requires unavailable X11 support and exact-window capture can refuse
`surface_identity_unproven`; Synara reports backend unavailability rather than
inventing geometry. The still-image transport previews a selected target only
where capture works. Settings details distinguish observation capabilities
from native input availability. Build and protocol tests do not establish packaged
X11/Wayland behavior, physical Escape or sustained performance.

The isolated Linux runtime checks exercised X11 observation/still preview and
the final browser port with Electron 43, including injected Escape, cancellation,
release cleanup and fresh-state recovery. Native-Wayland browser mutation was
refused before shortcut registration. These are component-level runtime results;
the injected event does not qualify physical-human Escape, and no full Linux
Synara package/provider flow is certified by them.

On macOS, the native managed-Space inventory can include empty Spaces, with
session-local IDs, identity and current-Space information for each display.
Window fields `spaceIds`, `currentSpaceId` and `onCurrentSpace` remain observed
membership; they are not substitutes for that inventory. Incomplete identity
or current-state information prevents a reservation. Linux has no managed-Space
inventory.

`computer_spaces` is available on demand through
`computer_inspect({tool: "computer_spaces", arguments: {...}})`; its schema is
returned by `computer_help({tool: "computer_spaces"})`. It adds no idle schema.

| Operation        | Behavior                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `list` (default) | Read the managed-Space inventory and observed windows, optionally filtered by Space ID.                                                     |
| `reserve`        | Reserve an existing, noncurrent desktop Space explicitly designated by the user for this turn; optionally select one exact existing window. |
| `select`         | Change the task's logical target to an exact existing window in its reservation.                                                            |
| `peek`           | Read inventory metadata and, when an exact window is specified, its semantic text without a screenshot or activation.                       |
| `release`        | Remove this task's reservation without changing the desktop.                                                                                |

Designation uses an explicit current user instruction such as **Use Space ID
42 for this task.** Replace 42 with the actual ID from the inventory, not a
Mission Control position. Tool arguments, quoted content and full access do
not designate a Space. A reservation coordinates Synara tasks for one turn;
it provides neither OS ownership nor continuous desktop isolation. It does
not add input or capture support to an off-Space window.

Before input, the broker rechecks the exact Space identity and selected window.
Entering the reserved Space or changing its identity invalidates the reservation
until it is explicitly replaced; moving the selected window or losing its
proven membership prevents input. Stop, turn completion and teardown release
the bookkeeping. Native app launch, app-wide or visibility changes, and
unscoped input cannot use a reservation.

Native Space creation, window movement between Spaces, switching and following
remain explicitly unsupported. Historical fixture results in
[Space findings](space-management-findings.md) do not establish those abilities.
A refused off-Space action is not permission to switch Spaces or raise the app.
The new inventory/reservation path still requires runtime qualification.

## Qualification still required

1. Current signed, packaged macOS artifact: three-grant setup and listener
   readiness, background action plus readback, physical Escape/takeover,
   cancellation and recovery, permission revocation, focus and Dock/window checks.
2. Verify the implemented browser mutation admission after Escape/takeover
   end to end: it requires a fresh model snapshot for the same task and tab,
   independently of native cleanup. Add action-specific proof for browser/native mutations that still
   return dispatched-unknown, without reclassifying dispatch as verified success.
3. Nine fresh provider sessions with a small real task and cancellation/recovery.
4. Current Linux packaged startup, direct-X11 headless browser tasks, Escape
   and cancellation, still preview, and expected Wayland/XWayland refusals. A standalone connected host does not qualify the package;
   build success does not establish compositor-specific runtime behavior.
5. Qualify managed-Space inventory, including empty Spaces, and per-turn
   reservations in the packaged macOS app: exact-window selection, concurrent
   tasks, user entry, identity/window changes and Stop cleanup. Physical
   create/move/switch/follow and OS ownership remain unsupported; passing unit
   tests does not qualify them or off-Space input/capture.
6. Browser-heavy performance benchmarks with fresh-thread and complete-evidence
   gates. The live SQLite database is exclusively owned by the application;
   collect through its diagnostic APIs or an owner-created coherent snapshot.
   Do not copy live DB/WAL files separately or infer zero usage from empty reads.
7. User-visible smoke checks for the implemented onboarding, history pagination
   and truncation, browser action labels, and errors before the first preview
   frame. Repository tests and runtime measurements for this implementation
   wave must be recorded separately before claiming qualification.

## Historical references

The [initial qualification](qualification.md),
[integration record](integration-refresh.md),
[capability audit](capability-audit-2026-09-16.md) and files under evidence/
retain their original scope and dates. Treat descriptions of removed features
or earlier revisions as historical. Check current source and the release
manifest before following an old operational recipe.
