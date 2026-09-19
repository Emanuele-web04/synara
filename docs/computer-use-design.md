# Computer use on Linux

Computer use lets an agent thread drive a Linux desktop: enumerate windows, look at them, click, type, scroll, read the accessibility tree, and use the clipboard. This document describes the design as it stands. Backend-specific sections (KWin plugin, nested KWin, Hyprland plugin) follow the core sections.

## Purpose and product rule

One rule outranks every other decision in this feature.

The agent never drives the seat the human is sitting at. It gets a cursor and an input path of its own. The human's pointer, keyboard focus, and active window are untouched, so the human keeps working while the agent works.

Four consequences follow from it.

- The agent's cursor is drawn by the compositor plugin, in a distinct colour, with a badge naming the driving thread. It is never the human's cursor moved somewhere else.
- When the human is active in a window, agent actions aimed at that window are refused. The refusal is retryable and carries the token `computer_human_active`, whether the compositor or the server raised it.
- Nothing the machinery needs ever appears on the host desktop. No compositor window, no consent dialog on a probe, no nested session mapped as a window (except by explicit debugging opt-in).
- The Computer pane in the web app is the only view the human is expected to use. On a nested desktop it is the only view that exists.

Anything that would break the rule is refused rather than approximated. Protocol drag-and-drop, client-side titlebar moves, and shared-seat virtual input devices are all in that category. No shared-seat backend exists in the tree, so none can be selected, forced, or fallen back to.

## Architecture

```
packages/contracts/src/computer.ts        schemas, WS method names, tool input/output types
apps/server/src/computer/
  ComputerManager.ts                      one per server; desktop lease, perception, publishing
  ComputerBackend.ts                      the backend interface every desktop implements
  KWinComputerBackend.ts                  compositor-plugin engine (D-Bus), used by three backends
  nestedComputerBackend.ts                KWinComputerBackend pointed at a private compositor
  HyprlandComputerBackend.ts              KWinComputerBackend with hyprctl plugin management
  FakeComputerBackend.ts                  CI and unit tests, no display
  UnavailableComputerBackend.ts           reports why there is no desktop
  Layers/ComputerService.ts               platform gate and Linux backend selection
  Layers/ComputerLeaseReactor.ts          releases the lease on turn end
  wsComputerHandlers.ts                   WebSocket RPC group
  computerFrameRoute.ts                   /ws/computer-frames still-image stream
apps/server/src/agentGateway/computerTools.ts   the computer_* MCP tools
apps/server/native/computer-use-kwin/     KWin plugin (C++), prebuild scripts, systemd units
apps/server/native/computer-use-hyprland/ Hyprland plugin (C++)
apps/web/src/components/computer/         ComputerPanel and hooks
apps/web/src/components/settings/ComputerSettingsPanel.tsx
```

### Contracts

`packages/contracts/src/computer.ts` is schema-only. It defines `ComputerAvailability` (`available`, `unsupported-platform`, `permission-required`, `backend-unavailable`), `ComputerHealth` (`connected`, `reconnecting`, `unavailable`, plus failure counters and `captureAvailable`), `ComputerCapabilities` (`windows`, `windowBounds`, `stacking`, `capture`, `input`, `clipboard`, `focus`, `raise`, `ghostCursor`, `visibleDesktop`), `ComputerWindow` (id, title, bounds, `focused`, `active`, `stackingIndex`, `occludedBy`), `ComputerUiNode`, `ComputerScreenshot`, `ComputerState`, `ThreadComputerState`, every RPC input and result, and the size bounds every layer clamps to. Backend names are constants: `kwin`, `nested-kwin`, `hyprland`, `mac`. `COMPUTER_RELEASE_CONTROL_HOTKEY` is `Meta+Shift+Esc` and may only be advertised for backends listed in `COMPUTER_RELEASE_HOTKEY_BACKENDS`.

### ComputerManager and the desktop lease

One `ComputerManager` serves every thread. There is one desktop, one agent cursor, and one agent keyboard focus, so exactly one thread drives it at a time.

The first mutating action from a thread takes the desktop lease. Every other thread's mutating tools are refused with `ComputerLeaseError` (retryable, token `computer_controlled_by_other_thread`); perception stays free so a blocked thread can watch and retry. Clipboard reads and writes take the lease like input. Pane input from the human neither takes nor is blocked by it.

`ComputerLeaseReactor` releases the lease when the owner's turn ends, driven by the provider runtime stream (`turn.completed`, `turn.aborted`, `session.exited`), keyed on both thread and turn so a late event for an earlier turn cannot release a newer one. `COMPUTER_LEASE_IDLE_MS` (five minutes, matching the plugin idle timeout) is a crash backstop that never fires while a call is in flight.

When the lease changes owner the manager calls `backend.resetInputDelivery()` (falling back to `clearFocusWindow()` on backends without it) and `backend.setDrivingAgent(label)` so the cursor badge names the new owner. Reset clears the explicit target, forgets any direct-injection enter bookkeeping, releases held buttons and keys, and hands shared client objects back to the human's seat. A new owner sends no input until that reset succeeds.

The manager also owns perception: fusing AT-SPI trees with plugin window bounds, resolving semantic targets, the per-thread `ScreenshotFrameRegistry` (`screenshotFrames.ts`) that maps model pixel coordinates back to desktop points, scroll gearing calibration, the post-action observation screenshot, and publishing `ThreadComputerState` to every subscribed thread.

### ComputerBackend

`ComputerBackend.ts` is the contract every desktop implements. The shape that matters for maintainers:

- `probeAvailability()` is side-effect free by contract: no session start, no install, no plugin load, no connection that outlives the call. Boot and UI seeding call it. `availability()` is the establishing counterpart and may connect, install, and load. `statusAvailability()` is the passive read for backends that must not respawn on polling.
- `provision()` is the only path that installs system packages or compiles, and only the settings panel's Set up button calls it.
- `health()` and `capabilities()` are synchronous and cheap; changes arrive through `onEvent` as `health-changed` and `capabilities-changed`.
- Input methods take a `windowId` the caller resolved the point to. A plugin backend delivers to that window even when it is partly covered.
- `attachStream` and `detachStream` carry the still-frame stream; `stillFramePublisher.ts` is the shared timer, dedupe, and force logic.
- Errors are `ComputerBackendError` with `retryable`, `dormant`, `rejectedOperation`, and `setupRequired` flags. `retryable` is what the tool surface turns into "wait and try again".

### Agent gateway tools and approval

`computerTools.ts` registers the `computer_*` MCP tools when the thread's session lease carries the `computer:control` capability. The capability is granted per thread by the composer's Computer control switch (`enableComputerControl` on turn start), never as a provider default. `allowComputerControlInNewChats` in settings defaults off. All computer tools are deferred; a chat that never touches the desktop pays no schema tokens for them.

Perception tools (`computer_list_windows`, `computer_get_state`, `computer_screenshot`, `computer_get_screen_size`, `computer_wait`) are read-only and not approval-gated. Every tool in `COMPUTER_APPROVAL_REQUIRED_TOOLS` goes through the provider's native approval flow, or through `ComputerApprovalGate` for providers with no permission callback. The set includes every input tool (including `computer_move_cursor`: the manager reveals the target before a hover, which may raise its window), `computer_launch_app`, `computer_activate_window`, `computer_set_value`, `computer_perform_action`, `computer_write_clipboard`, and `computer_read_clipboard`. The clipboard read is the one read that requires approval because the clipboard is the human's and can hold a secret they copied. `ComputerApprovalGate` never grants session-wide approval. Providers in `PROVIDERS_WITHOUT_APPROVAL_GATE` are refused outright.

Pointer tools take `x`/`y` in the pixels of the most recent screenshot delivered to that thread (or the one named by `screenshot_id`). The server does the geometry. A point outside the image is refused, and a pointer call before any screenshot is refused with a nudge to look first. Every image handed to a model is at most `COMPUTER_AGENT_IMAGE_MAX_DIMENSION` (1536 px) on its long side so the model reads coordinates off the picture the server produced.

### WebSocket surface

`COMPUTER_WS_METHODS` names the RPC group served by `wsComputerHandlers.ts`. Only methods with a web caller exist on it.

- `computer.getStatus` and `computer.provision`, for the settings panel. Reading status never installs anything.
- `computer.getThreadState`, `computer.changePermission`, `computer.subscribeEvents`, for the pane and the composer switch.
- `computer.input.click`, `computer.input.scroll`, `computer.input.key`, for human input from the pane. These send resolved desktop coordinates only and work with no agent turn in flight.

Push events travel on channel `computer.event`. Still frames travel on the dedicated `/ws/computer-frames` socket (`computerFrameRoute.ts`) using the shared `FrameTransport` from `packages/shared`.

### Web pane, settings, opt-in

`ComputerPanel.tsx` is a right-dock pane showing the still-frame stream letterboxed to the reported screen size, the agent cursor overlay, the driving-thread indicator, `controlledByOtherThread` and human-active badges, and availability or setup-required states. `autoOpenComputerPane` opens it when an agent starts driving a desktop whose `visibleDesktop` capability is false. `ComputerSettingsPanel.tsx` shows the backend, health, and capabilities, and offers Refresh (passive status) and Set up (`computer.provision`). The composer's permissions menu holds the per-thread Computer control switch. All disclosure animation in these components goes through `apps/web/src/lib/disclosureMotion.ts`.

## Backend tiers on Linux

`Layers/ComputerService.ts` gates on platform (`linux` only; anything else gets `UnavailableComputerBackend` with `unsupported-platform`) and then calls `selectLinuxBackend` (`linuxBackendSelection.ts`). Resolution order, with no fallback in any direction:

1. `SYNARA_COMPUTER_BACKEND` if set: one of `kwin`, `hyprland`, `nested`, `nested-window`. An unknown value throws rather than being ignored. A forced backend that fails stays failed and says why. `SYNARA_COMPUTER_BACKEND=fake` selects `FakeComputerBackend` at the service layer.
2. `SYNARA_COMPUTER_NESTED=1` (headless) or `window` (debugging) selects the nested backend.
3. A live Hyprland session (`HYPRLAND_INSTANCE_SIGNATURE` with a connectable `$XDG_RUNTIME_DIR/hypr/<sig>/.socket.sock`) selects the Hyprland plugin backend. This is checked before KWin so a stray test `kwin_wayland` owning `org.kde.KWin` cannot misroute a real Hyprland desktop.
4. `org.kde.KWin` owned on the session bus selects the KWin plugin backend. The bus is asked rather than `XDG_CURRENT_DESKTOP` because the compositor, not a label, decides whether the plugin can load.
5. Otherwise, and when the session bus is unreachable, the headless nested KWin backend.

The tiers, best first:

- The KWin plugin on a Plasma Wayland session and the Hyprland plugin on a Hyprland session drive the human's real desktop with the agent's own seat. See "Backend: KWin plugin (Plasma Wayland)" and "Backend: Hyprland plugin".
- Every other Wayland desktop (GNOME, the wlroots family, anything without an in-process plugin system) gets a headless nested KWin the server owns, with the Computer pane as its only screen. This is the floor. See "Backend: headless nested KWin".
- An X11 session (`XDG_SESSION_TYPE=x11`) has no tier. Every mechanism here is a Wayland one and the probe refuses with a message saying so. Xwayland clients inside a Wayland session are in scope.

The three Linux backends share one engine. `KWinComputerBackend.ts` owns connect, plugin load planning, authentication, reconnect with backoff, capture serialization, input sequencing (`pointerSequencing.ts`, `evdevInput.ts`), clipboard (`wlClipboard.ts`), and AT-SPI perception. The nested and Hyprland classes replace only the pieces that differ (`KWinComputerDbus` implementation, provisioning, availability gate, `visibleDesktop`).

Other environment overrides read by the engine. Each degrades to its default on bad input; only the backend override throws.

- Session tuning: `SYNARA_COMPUTER_IDLE_TIMEOUT_MS`, `SYNARA_COMPUTER_HUMAN_ACTIVE_MS`.
- KWin install locations: `SYNARA_KWIN_PLUGIN_DIR`, `SYNARA_KWIN_PREBUILT_DIR`, `SYNARA_KWIN_SOURCE_DIR`, `SYNARA_KWIN_STATE_ROOT`.
- Hyprland install locations: `SYNARA_HYPRLAND_PLUGIN_DIR`, `SYNARA_HYPRLAND_PREBUILT_DIR`, `SYNARA_HYPRLAND_SOURCE_DIR`, `SYNARA_HYPRLAND_STATE_ROOT`.
- Nested session: `SYNARA_COMPUTER_NESTED_SIZE` (`WxH`, default 1920x1080), `SYNARA_COMPUTER_NESTED_ATSPI`.
- Perception helper: `SYNARA_ATSPI_PYTHON`, `SYNARA_ATSPI_HELPER`.

## The compositor plugin contract

Both plugins export the same D-Bus object: service `org.synara.ComputerUse`, path `/org/synara/ComputerUse`, interface `org.synara.ComputerUse1`. `kwinDbus.ts` (`KWinComputerPluginApi`) is the server-side typing of it. The engine never learns which compositor it is talking to.

### Authentication and ownership

The server takes the exclusive bus name `org.synara.ComputerUse.Server` and writes a random 32-byte token to `/tmp/synara-computer-use-<uid>-<bus id>.token`, mode 0600 (`computerSessionAuth.ts`). It calls `authenticate(s token) -> s`. The plugin accepts only if the caller is the current owner of the server name, the file is a regular file owned by the same uid with mode 0600, and its contents match. Every other method except `healthJson` requires the authenticated caller's unique bus name; anything else gets `org.synara.ComputerUse.Error.Unauthorized`. When the server name changes owner the plugin drops the authenticated caller and stops the session. `authenticate` returns a per-load instance id, which the engine uses to confirm that a reload produced a new instance and to talk to the plugin by its unique name rather than the well-known one.

### Session lifecycle

`start() -> b` and `stop() -> b` bracket a session. The engine starts lazily on the first real action so the agent cursor appears only when something happens. `stop`, an idle stop, and plugin destruction all release held buttons and keys, drop pointer and keyboard targets, hide the cursor, and cancel an in-flight capture. Every input method returns `false` while stopped. The `sessionStopped(s reason)` signal reports `request`, `idle-timeout`, or `user-release`.

The idle timeout lives in the plugin because the server's finalizers do not run on a hard kill. Default five minutes; `setIdleTimeout(u ms) -> b` accepts `0` (off) or 1 s to 1 h. Input and capture methods reset the deadline; `healthJson`, `stateJson`, `windowsJson` do not, because the server polls them. The engine restarts a session stopped for idleness on the next action.

`setAgentName(s) -> b` sets the cursor badge; the engine resends it after every start.

### Input injection

Input is evdev-shaped: `movePointer(d x, d y)`, `button(u code, b pressed)`, `axis(d horizontal, d vertical)` in desktop pixels (80 px per wheel notch on the way out), `key(u code, b pressed)`. `evdevInput.ts` holds the codes and the US-QWERTY text table.

On the human's desktop the plugin delivers each event to the target client over one of two paths, chosen by where the client's pointer object lives.

- Dedicated seat. The plugin creates a second `wl_seat` named `synara-agent` with its own xkb state. A client that created its pointer on that seat (Qt, GTK) receives seat events there. The human's seat never sees them.
- Direct per-client injection. A client that only ever binds the first seat (Chromium and Electron via Ozone, Xwayland on behalf of every X11 client) is driven by writing `wl_pointer` and `wl_keyboard` events straight onto its own seat0 resources with serials from the display counter. The seat's state is only observed, never changed.

Direct injection has one extra rule, the same-client rule. Xwayland is one client for every X11 window, and some toolkits share input resources across windows. So a direct enter, key, or button aimed at a surface is refused with `HumanActive` when the human's seat has focus in another surface of the same client connection within the human-activity guard window, and after every direct enter or leave the plugin re-sends the seat's real focus and modifier state to the client so the human's typing stays in the human's window. The Hyprland plugin also invalidates its cached enter whenever the seat enters or leaves any surface of the same client.

`focusWindow(s id) -> b` names the window that receives keys and scopes `button` and `axis` to it, accepting popups in its transient tree. `raiseWindow(s id) -> b` restacks without activating. `clearFocusWindow() -> b` drops the target. A target that closes is an error (`stateJson.targetLost`), never a silent retarget. Held keys never migrate between surfaces: they are released to the old surface or dropped with the xkb state rewound. On KWin the plugin borrows activation (`Window::setActive`) for the keyboard target so toolkits dispatch shortcuts, and undoes it when the target changes.

`ResetInputDelivery() -> b` does everything a lease handover needs in one call: clear the target, forget cached enter bookkeeping, release held buttons and keys, hand shared objects back to the human's seat. The engine calls it whenever the lease changes owner.

A client holding no pointer or keyboard on any seat is refused with `org.synara.ComputerUse.Error.SeatUnsupported`. Modified pointer input (`ctrl+click` and friends) is refused on Linux rather than delivered unmodified.

### Capture

`captureWindow(s id, u maxDimension) -> ay` and `captureRegion(i x, i y, u w, u h, u maxDimension) -> ay` render offscreen at the next safe compositor render point and return PNG bytes. The agent's cursor is painted in; the human's cursor never is. One capture at a time; a second concurrent call and every other failure is `org.synara.ComputerUse.Error.CaptureFailed` with a reason, never an empty array. Render deadline 2 s, encode deadline 5 s; the region is clamped to the workspace and refused above 16384 px a side or 64 megapixels. Captures work whether or not the session is running. The engine serializes captures and feeds `stillFramePublisher.ts` at 500 ms for the pane.

### Human-activity guard

A `button`, `axis`, or `key` whose resolved target is the window the human's seat has keyboard focus on, while the human's seat has produced input within the guard window, fails with `org.synara.ComputerUse.Error.HumanActive` naming the window and the age of the last input. Recency comes from a compositor input spy that sees only real device events, so nothing the agent does counts. `movePointer`, perception, clipboard, `focusWindow`, and `raiseWindow` are exempt; the release half of a press the agent already delivered is never refused. `setHumanActiveGuardMs(u ms) -> b` accepts `0` or 100 ms to 60 s (default 2000). `stateJson` reports `humanFocusWindowId`, `msSinceHumanInput`, `humanActiveGuardMs`. The guard is off when `SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1`, the nested case with no human in the compositor.

### Panic release shortcut

`Meta+Shift+Esc` stops the session from any window and latches, so `start()` fails with `org.synara.ComputerUse.Error.ControlReleased` until the chord is pressed again. The human's seat drives the compositor's shortcut handling and agent input never enters that pipeline, so the agent can neither trigger nor swallow it. The server does not restart a session the human released. `healthJson.releaseShortcut` is the effective sequence string, or `null` when registration failed; the engine surfaces `null` as a setup blocker ("no emergency release shortcut could be registered") rather than advertising a hotkey that does not exist.

### Lock and inactive session

While the screen is locked or the logind session is inactive, both plugins refuse capture and input with `org.synara.ComputerUse.Error.SessionLocked`, checked at request entry and again at capture completion. `healthJson.locked` reports the state. The engine maps the error to a retryable `ComputerBackendError` with code `computer_session_locked` and does not treat it as a connection failure.

### Keyboard layout

`stateJson.keyboardLayout` is the xkb layout name of the seat keymap in use (for example `us`). Text typing and character keys are synthesised through the US-QWERTY evdev table, so the engine refuses `typeText` and character `pressKey`/`hotkey` with a non-retryable `ComputerBackendError` naming the layout and what is supported when the layout is not US-compatible. Named keys (Enter, Escape, arrows, F-keys, modifiers) stay allowed.

### Health and state JSON

Three introspection methods return JSON strings.

- `healthJson` needs no authentication. It carries `capture`, `workspaceGeometry`, `idleTimeoutMs`, `releasedByUser`, `releaseShortcut`, `locked`, build identity (`build`, `gitHash`, `buildTimestamp`, and `kwinVersion` or the Hyprland module path), and on a nested compositor `xDisplay`.
- `stateJson` carries `running`, `stopReason`, `agentName`, `directInjection`, `targetLost`, `keyboardWindowActive`, `borrowedActivation`, `keyboardLayout`, the idle timing fields, and the guard fields.
- `windowsJson` lists windows topmost-first with `stackingIndex`, `occludedBy` (rect overlap, which overstates occlusion on purpose), `active`, and `pid`.

The engine classifies D-Bus failures. Method-level errors (every `org.synara.ComputerUse.Error.*`, plus timeouts on individual calls) fail the call. Connection-level failures (socket close, `NameOwnerChanged` on the plugin service, `Unauthorized` or `UnknownObject` after a reload) invalidate the connection and reconnect with backoff, re-authenticating and re-sending idle timeout, guard, and agent name. An abort from a cancelled turn is neither and is rethrown before classification.

## Perception

`atspi_helper.py` is a Python process speaking newline-framed JSON-RPC on stdio (`read-tree`, `set-text`). `AtspiHelperClient` (`atspiClient.ts`) supervises it with a 10 s request deadline, an 8 MiB frame cap, and bounded restart with backoff. Replies are accepted only from the current helper process; a late reply from a retired one is dropped, and a helper that ignores SIGTERM is killed after a grace period.

The helper's walk is bounded on purpose.

- One desktop pass, keyed by pid, finds window candidates without descending into every application's full tree.
- Each requested window gets its own node and depth budget (`MAX_NODES`, `MAX_DEPTH`), so one large Chromium tree cannot starve the others.
- Each application is isolated with its own timeout, so a stalled one cannot block perception for the rest.
- Partial results are returned with a marker rather than failing the whole read.
- Labels and roles are clamped before serialization so an oversized accessible name cannot break the frame.

Window identity is matched by pid, role (`frame`, `window`, `dialog`), and title. AT-SPI reports extents in client coordinates on Wayland, so `atspiTreeTargeting.ts` fuses each tree with the plugin's window bounds to produce the desktop-space `ComputerUiNode` tree the manager exposes. `computer_get_state` with `include_tree` is what drives that walk; `uiTreeText.ts` renders it to prose only when a caller asked.

Targeting follows the snapshot-then-act rule shared with the device family (`uiTreeTargeting.ts`): a semantic target names a role and label, an ambiguous match returns candidates instead of clicking, an element's own activation point beats its frame centre, and a resolved point outside the target window is refused. `computer_set_value` and `computer_perform_action` re-resolve the node by window and child-index path on every call and check role and label so tree drift cannot redirect a write. Where the accessibility layer cannot confirm an effect the result says `unverifiable` rather than claiming success.

On the nested backend AT-SPI is off by default (`SYNARA_COMPUTER_NESTED_ATSPI=1` opts in) because the accessibility registry is per user, not per bus, and would otherwise read the human's desktop into the nested window list.

## Provisioning

Everything except distribution packages installs under the user's home, without root, from the server process.

Prebuilds. CI (`.github/workflows/kwin-plugin-prebuilds.yml`, assembled by `scripts/assemble-kwin-plugin-prebuilds.mjs`) builds the KWin plugin per distribution image (`fedora-43`, `fedora-44`, `debian-trixie`, `ubuntu-2604`, `opensuse-tumbleweed`, `arch`), per KWin version, per architecture, and writes `manifest.json` with `kwinVersion`, `arch`, `builtOn`, `file`, `sha256`. `selectPrebuilt` matches all three fields exactly; `ID_LIKE` derivatives do not match their parent. `provisioning/prebuiltVerification.ts` rejects manifest entries with path separators or malformed hashes and verifies SHA-256 before install. Hyprland prebuilds use the same manifest shape keyed on exact Hyprland version and architecture.

Source build. When no prebuild matches, `scripts/install-and-load.sh --build-only` compiles against the local headers. The KWin build needs cmake, ninja, ECM, `kwin-devel`, Qt 6 and KF6; Ubuntu before 24.10 and Debian before 13 ship KWin 5 and are refused with a message naming the release to upgrade to (`provisioning/kwinCompatibility.ts`). Builds and package installs run through `provisioning/runCancellable.ts` and are torn down via `platform/supervisedProcessTeardown.ts` when the turn is cancelled.

System packages. `provisioning/systemPackages.ts` installs `kwin_wayland`, `wl-clipboard`, and the build toolchain through `pkexec` in one authorization, selected by the host distribution, and only from Set up. Probes and availability reads never raise a dialog.

Version and ABI. A compositor plugin loads only into the exact version it was built against; KWin refuses a mismatched `PluginFactoryInterface` IID with a bare `false`, Hyprland names the reason. The running version is read from the compositor, not from the binary on disk, so a package upgrade without relogin does not trigger an install the running compositor cannot load. Each install lands as a new `SynaraComputerUsePluginV<n>.so` because both compositors keep a loaded library mapped; superseded generations are pruned only after the new one loads and answers `healthJson`. An install stamp under `~/.local/state/synara/` records plugin id, compositor version, and distribution identity so setup rechecks after a distribution upgrade.

Compositor upgrade. After the compositor updates and the session restarts, the next connect finds the installed generation refused, provisions a matching build (prebuilt or source), and loads it. Until the human logs into the new compositor, the old one keeps running the old plugin and nothing is reinstalled.

Uninstall. Delete the plugin directory and, for KWin, the env script `~/.config/plasma-workspace/env/synara-computer-use.sh`. `scripts/uninstall.sh` unloads and removes every installed generation from every root an install could have used.

## Threat model and trust boundary

The plugin runs inside the compositor with the compositor's authority over input and pixels. The boundary is the user's uid and session bus.

- Any process with the same uid and access to the session bus can call the plugin. Authentication narrows that to the one process holding `org.synara.ComputerUse.Server` and able to read a 0600 token file owned by the uid. This stops a second Synara instance or an unrelated bus client from driving the desktop through a plugin the server loaded. It does not defend against code already running as the user, which can take the name and read the file.
- The prebuild checksums establish that the bytes installed are the bytes CI built and the app shipped. They protect against truncation and tampering in transit and on disk. They do not attest to the build's provenance beyond the manifest that ships with it and do not stop a user from installing a plugin built elsewhere.
- Nothing reachable over the bus can make the plugin drive the human's seat. The nested mode that does ride the compositor's own input stack is enabled only by `SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1` in the compositor's environment, set by `nestedKWinSession.ts` and never by a D-Bus method.
- Agent-launched applications receive a scrubbed environment (`desktopAppEnvironment.ts`): PATH, HOME, USER, LOGNAME, SHELL, LANG and `LC_*`, TZ, `XDG_*`, `DBUS_SESSION_BUS_ADDRESS`, `WAYLAND_DISPLAY`, `DISPLAY`, `XAUTHORITY`, and the Qt, GTK and GDK display variables. `SYNARA_*`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, and tokens are dropped.
- The agent cannot drive the compositor's own authentication prompts or polkit dialogs, so it cannot approve its own escalations. The human's Meta+Shift+Esc, the plugin-side idle timeout, and the human-activity guard all live inside the compositor and survive a dead server.
- Approval gating is a Synara-side control on top of all of this: every mutating tool and the clipboard read require an approval decision from the human, and the capability itself is opt-in per thread.

## Known limitations

- Keyboard layout support is US-only. Text and character keys are refused on any other layout; named keys still work.
- No protocol-level drag-and-drop and no client-side titlebar moves. Both need a button serial on the human's seat, which the agent never has. Press-move-release drags inside a client work. Between windows, use the application's keyboard equivalent.
- X11 sessions are unsupported. Xwayland clients inside a Wayland session are supported, except that their override-redirect menus are not pointer targets on KWin.
- Modified pointer input (modifier plus click or scroll) is refused on Linux.
- Real-desktop control exists only where an in-process plugin can load (KWin, Hyprland). GNOME and the wlroots family get the nested desktop, which is isolated from the human's applications.
- musl distributions get no prebuild and always build from source.
- AT-SPI perception is off by default on the nested backend.
- Compositor plugins are built per compositor version; every KWin or Hyprland release needs a new build.

## Testing

Unit tests (`bun run test` from `apps/server` or `apps/web`) run with no display. `FakeComputerBackend` drives the full snapshot, act, event loop for `ComputerManager`, the tools, the WebSocket handlers, and the pane. Backend tests inject fake `KWinComputerDbus` and `KWinComputerPluginApi` implementations, fake clocks, fake process spawners, and fixture manifests; no test touches a real bus or compositor.

Pane behaviour that needs a real DOM (`useComputerImageStream.browser.tsx`, `useThreadComputerStateSeed.browser.tsx`) runs under Vitest browser mode. Concurrent runs must set distinct `VITEST_BROWSER_API_PORT` values.

Plugin fixture tests compile production functions against stub protocol resources without a compositor: `apps/server/native/computer-use-kwin/tests/pointer_cleanup_test.py` and `apps/server/native/computer-use-hyprland/tests/focus_test.py` (`make test`). `atspi_helper_test.py` covers the helper with a fake `Atspi` module.

Integration tests are opt-in by environment variable and skipped otherwise:

- `SYNARA_NESTED_KWIN_TEST=1` runs `nestedKWinSession.integration.test.ts`: boots a private bus and `kwin_wayland --virtual`, loads the plugin, lists, launches, captures, round-trips the clipboard, and checks health after killing the compositor. Needs `kwin_wayland` and an installed or buildable plugin.
- `SYNARA_COMPUTER_AUTH_PROBE=<path to SynaraComputerAuthProbe>` runs `computerAuth.integration.test.ts` against an isolated `dbus-daemon`, checking that one server authenticates and a stranger is refused. Build the probe with `-DSYNARA_BUILD_AUTH_PROBE=ON`.

Anything involving the human's seat needs a live compositor and cannot run in CI: dedicated-seat versus direct-injection delivery, the same-client rule, the human-activity guard, the release shortcut, lock refusal, and prebuilt loading on each distribution. Development testing for those runs against a disposable nested compositor (headless `kwin_wayland --virtual`, or Hyprland nested inside one), never against the desktop the developer is sitting at.

## Backend: KWin plugin (Plasma Wayland)

`KWinComputerBackend.ts` driving `apps/server/native/computer-use-kwin/` loaded into the human's own `kwin_wayland`. Reports backend `kwin`, `visibleDesktop: true`, and the full capability set.

### Plugin

The plugin is a `KWin::Plugin` built with CMake against the installed `kwin-devel` headers (KWin 6, Qt 6, KF6, ECM 5.240 or newer). `metadata.json` sets `EnabledByDefault: false`, so KWin never auto-loads any installed generation; the backend loads exactly one by id through `org.kde.KWin` `/Plugins` (`LoadPlugin`, `UnloadPlugin`, and the `LoadedPlugins` property, with a `loadedPlugins` method fallback for KWin variants that expose one).

The agent cursor is a scene overlay `Item` at z=1000 under `effects->scene()->overlayItem()`, drawn with `QPainter` as a violet arrow with a light rim and dark outer stroke so it is never confused with the human's theme cursor. It is sized from the human's `themeSize`, rasterized per output scale, and carries the name badge as a child `ImageItem` that fades two seconds after the last action.

The dedicated seat is a second `SeatInterface` named `synara-agent`. It mirrors the real keyboard's xkb keymap and tracks its own `xkb_state`. Delivery goes through `notifyPointerEnter`, `notifyPointerMotion`, `notifyPointerButton`, and `notifyKeyboardKey` on that seat. Path selection reads `PointerInterface::get(resource)->seat()` for the target client: a pointer on the agent seat means seat delivery, anything else means direct injection onto the client's seat0 resources.

Human-input recency comes from a `KWin::InputEventSpy` installed on `InputRedirection`, which runs before any filter and sees only real device events. The release shortcut is registered through `KGlobalAccel` as `SynaraReleaseComputerControl` (listed under KWin in System Settings, remappable). Registration failure is reported as `releaseShortcut: null`.

Capture renders an offscreen filtered `SceneView`. On the shared desktop the human's cursor is claimed by an exclusive `ItemTreeView` that is never painted, so it cannot appear in a capture.

KWin-specific `stateJson` fields: `borrowedActivation` and `keyboardWindowActive`, from the borrowed-activation rule that marks the keyboard target `Window::setActive(true)` so Qt dispatches shortcuts sent to it, and undoes the borrow when the target changes unless KWin has since activated the window for real.

### Backend

Connect order in `ensurePlugin`:

1. Open the session bus and read the current `org.synara.ComputerUse` owner.
2. Plan a load with `resolveSynaraPluginLoad` from the loaded ids and the installed `V<n>` files.
3. Provision when nothing installed will load; a `requiresRelogin` result is reported as-is.
4. Unload stale ids, load the newest, and confirm through `authenticate` that a new instance answered.
5. Re-send idle timeout, human-activity guard, and agent name.

A plan that fails to replace the instance is reported as a refusal rather than retried forever.

Reconnect uses exponential backoff from 250 ms to 5 s, is bounded, and does not re-run provisioning on every attempt. A slow capture reply is a method-level timeout, not a dead connection.

Environment: `SYNARA_COMPUTER_USE_OWNS_COMPOSITOR` is never set on the human's desktop. `SYNARA_KWIN_PLUGIN_DIR`, `SYNARA_KWIN_PREBUILT_DIR`, `SYNARA_KWIN_SOURCE_DIR`, and `SYNARA_KWIN_STATE_ROOT` override the paths below.

### Provisioning

Installs go under the user's Qt plugin root, `~/.local/lib64/qt6/plugins/kwin/plugins` or `~/.local/lib/...` (the split is read from whichever system root exists), as `SynaraComputerUsePluginV<n>.so`. The env script `~/.config/plasma-workspace/env/synara-computer-use.sh` prepends that root to `QT_PLUGIN_PATH`; Plasma sources it at login. Qt reads the variable at compositor start, so the very first install on a machine takes effect at the next login (`requiresRelogin`); every later install loads live. The install stamp lives under `~/.local/state/synara/`.

`provisionKWinPlugin` runs under a file lock, writes the env script on every run, then picks a prebuilt matching KWin version, architecture, and `builtOn` exactly, or builds from source with `scripts/install-and-load.sh --build-only`. The KWin version it matches is the running compositor's. `wl-clipboard` is installed with the toolchain packages from Set up when missing.

`scripts/install-and-load.sh` is the manual and CI path (`--build-only`, `--force`, `--noninteractive`). It creates the same env script as the application provisioner. `scripts/uninstall.sh` unloads and removes every generation from every root. `systemd/` holds an opt-in path unit, timer, and service that rebuild after a KWin upgrade; `enable.sh` installs them without starting them. They do nothing on an unchanged system and never run mid-package-transaction.

### Testing

`tests/pointer_cleanup_test.py` compiles `sendButton`, `releasePressedButtons`, and `clearPointerDelivery` against a fixture and checks that buttons are released before delivery is cleared. `authprobe.cpp` (built with `-DSYNARA_BUILD_AUTH_PROBE=ON`) is the fixture for `computerAuth.integration.test.ts`. Everything about seat delivery, the same-client rule, the guard, the shortcut, and lock refusal needs a live KWin and is exercised against a disposable nested `kwin_wayland`, never the developer's desktop.

## Backend: headless nested KWin

`nestedComputerBackend.ts` is `KWinComputerBackend` pointed at a private `kwin_wayland` this server boots on demand. It is the default on every Wayland desktop that is not KWin or Hyprland, and the only tier there. Reports backend `nested-kwin` and `visibleDesktop: false`, so the Computer pane opens automatically and is the only screen the desktop has.

### Session

`nestedKWinSession.ts` starts a private `dbus-daemon --session --print-address=1 --nofork`, then `kwin_wayland --virtual --xwayland --no-global-shortcuts --socket <name> --width W --height H` on that bus, waits for `org.kde.KWin` to appear, unloads every loaded Synara plugin id, and loads the newest installed one. Size comes from `SYNARA_COMPUTER_NESTED_SIZE` (default 1920x1080, clamped to 64 to 16384 a side).

The compositor's environment:

- `DBUS_SESSION_BUS_ADDRESS` is the private bus.
- `SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1` selects the owned-compositor input mode described below.
- `QT_PLUGIN_PATH` includes the user's plugin root, so no env script or relogin is involved.
- `DISPLAY` and `WAYLAND_DISPLAY` are dropped, so a virtual compositor can never attach to the session the human is sitting in.
- `XDG_RUNTIME_DIR` is a private 0700 directory when the server has none, removed on dispose.

With `SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1` the plugin adds a `SynaraVirtualInputDevice` (a `KWin::InputDevice`) to the compositor's input pipeline instead of creating a second seat. Events then follow KWin's normal routing: focus follows clicks, KWin owns the xkb state, real activation replaces borrowed activation, Xwayland forwards to X11 clients, and the human-activity guard is off because no human sits in that compositor. The plugin still draws the agent cursor and hides KWin's native one so the pointer looks the same on every machine. This mode is enabled only through the environment variable so nothing reachable over the bus can switch it on.

Launched applications get `nestedSessionEnv` on top of the scrubbed `desktopAppEnvironment`: the nested `WAYLAND_DISPLAY`, the private `DBUS_SESSION_BUS_ADDRESS`, `QT_QPA_PLATFORM=wayland`, and `DISPLAY` set to the nested Xwayland display read from `healthJson.xDisplay`. `DISPLAY` is always set, empty when unknown, so an X11 client with nowhere to go fails instead of opening on the human's screen.

The compositor, the bus, Xwayland, and every launched application belong to one process group tied to the server's lifetime. Teardown goes through `platform/supervisedProcessTeardown.ts` (TERM then KILL over the tree), runs from the server's signal handlers as well as `dispose()`, and a startup sweep reaps sessions a crashed server left behind. When either the compositor or the bus exits, the whole session is killed so the backend's bus disconnect fires and the engine sees a real invalidation.

### Lifecycle

Construction and `probeAvailability()` touch nothing. First real use boots the session, installing the plugin into the home directory first when it is missing. `provision()` from Set up is the only step that installs system packages (`kwin`, `wl-clipboard`, and the build toolchain in one `pkexec` authorization); it then provisions the plugin and boots the session.

A dead compositor is never restarted on a timer. The backend reaps the session, reports `dormant`, and the reconnect loop stands down. The next real use (an agent action, a pane attach, Refresh or Set up) boots a fresh session exactly as first use did. `ensureSession` distinguishes "died" from "never booted" so a first-use failure is reported as a failure, not as dormancy. `dispose()` awaits an in-flight boot before tearing down so no compositor leaks.

When the installed plugin generation is incompatible with the installed `kwin_wayland` (after a package upgrade), boot fails with KWin's load refusal, and the backend rebuilds once for that identified failure before booting again. It does not loop.

### Windowed debugging mode

`SYNARA_COMPUTER_NESTED=window` (or `SYNARA_COMPUTER_BACKEND=nested-window`) drops `--virtual` and keeps the host `WAYLAND_DISPLAY`, so the nested desktop maps as an ordinary window on the developer's desktop. It refuses to start without a host `WAYLAND_DISPLAY` rather than falling back to virtual. This mode fails the product rule (a window appears on the host) and exists only for debugging.

### Perception and clipboard

Clipboard works unchanged because wl-clipboard follows `WAYLAND_DISPLAY` into the nested seat. AT-SPI is off by default (`unavailableAtspiReader`); `SYNARA_COMPUTER_NESTED_ATSPI=1` runs the helper on the private bus for hosts that start an accessibility registry there, such as a CI container with no ambient desktop.

### Limits and testing

The nested desktop is isolated from the human's applications and files that are not in the home directory's shared view; it meets the floor, not the bar. Plasma X11 hosts, which own `org.kde.KWin` but cannot load the plugin into a Wayland compositor, are refused with a message saying so.

`nestedKWinSession.integration.test.ts` runs behind `SYNARA_NESTED_KWIN_TEST=1`: boot, geometry, window listing, launch, capture, clipboard round-trip, and health after killing the compositor. Unit tests cover the pure parts (mode and size parsing, environment construction, load planning, dormancy) with fake spawners.
