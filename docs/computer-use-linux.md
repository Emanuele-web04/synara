# Computer use on Linux

How the server chooses and hosts a Linux desktop backend. The Cua host (the
macOS beta, and observation-only on Linux) is described in
[computer-use-cua](computer-use-cua/README.md); the native Linux backends share
Synara's computer-use core with it and are documented here, one section per
backend.

## Seat policy

One rule outranks every other decision here: the agent never drives the seat
the human is sitting at. A Linux backend gives the agent a cursor and an input
path of its own and leaves the human's pointer, keyboard focus and active
window untouched, or it does not exist. No shared-seat backend is in the tree,
so none can be selected, forced or fallen back to.

## Core seams

The core is shared with the macOS Cua backend and lives in
`apps/server/src/computer/`. The seams a Linux backend plugs into:

- `ComputerBackend.statusAvailability()`: the passive status read for a
  backend whose desktop boots on demand. `ComputerManager.getStatus` uses it
  for every status read when the backend has one, so the settings screen's
  poll never boots or respawns a desktop; the desktop starts again on the next
  real use or from Set up. Backends without it keep the existing behaviour
  (the passive probe before engagement, the establishing read after).
- `ComputerBackend.resetInputDelivery()`: the full seat hand-back the manager
  runs on every desktop lease change and release, where `clearFocusWindow`
  alone would clear only the aim. A compositor seat outlives the thread that
  drove it.
- `ComputerBackend.dedicatedSeat`: the opt-in a backend sets when the agent
  drives the desktop through a seat of its own. The computer service registers
  the manager's `ComputerGuidanceProfile` (dialect plus this flag) for the
  process, because the session-start guidance is rendered by provider adapters
  that never see the backend. A backend that sets nothing keeps the Cua host's
  wording unchanged.
- `ComputerBackend.textRangeSelection`: `false` refuses `computer_select_text`
  in the manager before the lease is claimed and the window restacked and
  aimed for a dispatch the backend would refuse anyway.

Optional performance and reliability hooks. Each is absent on the Cua backend,
which keeps its behaviour exactly:

- `launchApp` results may name `appId` (the desktop or flatpak id windows
  report as `appName`) beside `pid`. Window readiness then accepts a window of
  that app, or of the launch name, when none carries the pid, because a
  flatpak or `gio launch` wrapper hands the window to another process. Without
  `appId` the pid rule stays exact.
- `writeClipboardForPaste(text)`: a single-use clipboard offer
  (`wl-copy --paste-once`) whose `consumed` promise settles once the paste
  target read it. Paste restores the human's clipboard then, bounded at
  `COMPUTER_PASTE_CONSUME_TIMEOUT_MS` (2 s), instead of after the fixed 250 ms.
- `captureLuma(request)`: raw 8-bit luma for the scroll-measurement baseline
  nobody looks at. Same geometry and scale as `captureScreenshot(request)`,
  luma as `decodePngLuma` computes it; a failure falls back to the PNG
  baseline.
- `defaultObservationRegion()`: the output an untargeted model observation
  photographs when no window holds the agent's focus, instead of the whole
  multi-monitor workspace. The backend's own `getState` screenshot should
  scope the same way.
- `ComputerStreamFrame.mimeType`: a preview frame may be `image/jpeg`; the
  frame envelope carries the type and the pane decodes it as such. Model
  screenshots stay PNG. `StillFramePublisher` capture callbacks return
  `{ data, mimeType }` for a non-PNG still.
- The `desktop-gone` backend event: the desktop the backend was bound to has
  ended for good (its compositor exited). The service re-runs selection
  and swaps in a different tier; an explicit override is never re-selected.

## Backend selection

`Layers/ComputerService.ts` resolves the backend at startup, with no
fallback in any direction once a choice is made. On Linux selection asks the
session bus, so it runs off the startup path: the service waits at most
`COMPUTER_SELECTION_STARTUP_BUDGET_MS` (1.5 s, shared with the passive probe),
and past that starts the manager on a slot (`switchableComputerBackend.ts`)
that reports `checking` availability and takes the selected backend when
selection answers. The guidance profile is registered again when it does.

1. `SYNARA_COMPUTER_BACKEND`, when set. `fake` and `cua` are platform-neutral;
   the Linux tiers are refused off Linux. An unknown value is not ignored: it
   becomes an unavailable backend whose message lists the names that exist, so
   a typo never boots a different backend and looks like the variable does
   nothing. A forced backend that fails stays failed and says why.
2. The Linux detection tiers in `linuxBackendSelection.ts`, best desktop first.
   `LINUX_BACKEND_CHOICES` and the service layer's `LINUX_BACKENDS` factory
   table are filled by the backend layers; each backend registers its choice,
   its detection tier and its constructor together, so the three cannot drift.
3. The Cua host, on macOS or wherever `SYNARA_CUA_HOST_SOCKET` names an
   endpoint. It comes after the Linux tiers on purpose: the desktop app
   configures its host socket on Linux too, so socket presence cannot be what
   decides between a compositor backend and the observation-only Cua host.
4. Otherwise an unavailable backend that says why.

## Backend: KWin plugin (Plasma Wayland)

`apps/server/native/computer-use-kwin/` is a `KWin::Plugin` loaded into the
human's own `kwin_wayland`: the agent's seat, cursor, input delivery and
capture, behind a D-Bus interface. No backend selects or loads it yet;
`scripts/install-and-load.sh` builds, installs and loads it by hand, as the
plugin's README describes.

### Seat policy, as the plugin implements it

- The agent's cursor is a scene overlay item drawn by the plugin, in its own
  colour, with a badge naming the driving thread. It is never the human's
  cursor moved somewhere else.
- The dedicated seat `synara-agent` delivers to clients that bound their
  pointer on it (Qt, GTK). Clients that only bind the first seat (Chromium and
  Electron through Ozone, Xwayland for every X11 client) are driven by direct
  per-client injection onto their own seat0 resources; the human's seat state
  is observed, never changed, and the same-client rule refuses input aimed at
  a surface whose client the human is active in.
- When the human is active in a window, agent actions aimed at that window
  are refused with `org.synara.ComputerUse.Error.HumanActive`. Every refusal
  is decided before the plugin sends anything; a raise that would bury their
  window is refused too, and no activation is borrowed in an application they
  are typing in. Serials the agent's events carry never count as the human's
  interaction: KWin refuses an activation token that quotes one, so a client
  cannot use an agent click to take the human's keyboard (Chromium did,
  between two of its windows), while a launch the human started still takes
  focus when it maps in the middle of the agent's work.
- `Meta+Shift+Esc` stops the session and latches until pressed again; a plugin
  that could not register the shortcut says so in `healthJson` rather than
  advertising a hotkey that does not exist.
- A popup the agent opens never grabs. KWin ignores the seat in
  `xdg_popup.grab` and would move seat0's keyboard onto any grabbing popup,
  swallowing the human's keys and next click, so the plugin attributes each
  popup at creation, withholds an agent popup's grab, and closes it itself on
  a human press outside it (the press still goes through).
- Anything that would break the policy is refused rather than approximated:
  protocol drag-and-drop, client-side titlebar moves, modifier-held clicks.

### Plugin contract

The plugin exports the D-Bus object `org.synara.ComputerUse` at
`/org/synara/ComputerUse`, interface `org.synara.ComputerUse1`, described in
`org.synara.ComputerUse.xml`. Its client takes the exclusive bus name
`org.synara.ComputerUse.Server`, writes a random token to a 0600 file and
calls `authenticate`; every other method except `healthJson` requires the
authenticated caller, and the plugin drops the caller when the server name
changes owner.

- `focusWindow`, `raiseWindow` and `clearFocusWindow` aim keys and scope
  pointer input without activating; `resetInputDelivery` does everything a
  lease hand-over needs in one call.
- A locked or inactive session refuses capture and input with
  `SessionLocked`.
- Captures render offscreen at the next safe compositor point; the agent's
  cursor is painted in, the human's never is. A downscaled capture is rendered
  by the GPU at (or near) the delivered size into render targets reused between
  captures, and PNGs are written at zlib level 1.
- `healthJson` reports `interfaceVersion` 2 and `features`, the optional
  methods on top of the version 1 set (`captureEx`, `keys`,
  `waitForSettle`, `windowsStateJson`). `keys` sends a word of strokes per
  call with `key`'s per-stroke checks; `waitForSettle` replies once a window
  has committed new content after the agent's input and gone quiet, driven by
  damage signals and timers rather than a fixed sleep.
  `captureWindowEx`/`captureRegionEx` take flags for a passive frame (not
  agent activity, so an observer does not keep an idle session alive), JPEG,
  or raw luma, and reply with the bytes' MIME type. Every version 1 method is
  unchanged, so a client that uses a feature only when it is listed keeps
  working with an older plugin.
  `healthJson.xAuthority` names the cookie file of the compositor's own
  Xwayland, which X11 apps launched into a nested session need.

### Provisioning and packaging

Everything except distribution packages installs under the user's home,
without root, from the server process: `provisionKWinPlugin`
(`kwinPluginProvisioning.ts`) and the steps under `provisioning/`, with
distribution packages behind one `pkexec` prompt. With no matching prebuilt,
`scripts/install-and-load.sh --build-only` compiles against the local headers
(KWin 6, Qt 6, KF6, ECM; Ubuntu before 24.10 and Debian before 13 are refused
by name). Each install lands as a new `SynaraComputerUsePluginV<n>.so`, since
the compositor keeps a loaded library mapped; the first install on a machine
takes effect at the next login because Qt reads `QT_PLUGIN_PATH` at compositor
start.

Prebuilds come from `.github/workflows/kwin-plugin-prebuilds.yml` (one job per
distribution image and architecture, assembled by
`scripts/assemble-kwin-plugin-prebuilds.mjs` into `manifest.json` with
`kwinVersion`, `arch`, `builtOn`, `file`, `sha256`); `selectPrebuilt` matches
all three fields exactly, with SHA-256 verified before install. The release
builds them inside the release run, best effort: prebuilds never block or
delay a release. A distribution the matrix cannot build is skipped and
reported, and a prebuild run that fails or finishes late leaves the packaging
jobs to ship with a `::warning::`; the users concerned keep the source-build
fallback. The binaries never enter the portable build, which every packaging
job verifies native-free: the Linux desktop leg polls for the artifact after
the verified import — stopping as soon as the prebuild jobs have concluded —
and passes it to the desktop build (`--kwin-plugin-prebuilt-dir`), which
stages it under the packaged server dist, and the CLI and server-tarball jobs
stage it into the restored dist when the prebuild run succeeded. No packaging
job waits on or is gated by the prebuild matrix.

The plugin sources ship outside ASAR (`LINUX_COMPUTER_USE_ASAR_UNPACK_GLOBS`):
bash and cmake read them off the disk. `apps/server/scripts/cli.ts` copies them
into `dist/`, and `scripts/release-smoke.ts` checks the packaging.

### Testing

The plugin's fixture tests (`native/computer-use-kwin/tests`) compile
production functions against stub protocol resources. Seat delivery,
the same-client rule, the guard, the shortcut and lock refusal need a live
compositor and are exercised only against a disposable nested `kwin_wayland`.

## Known gaps

- Nothing here is verified against a live compositor by the test suite.
- No protocol-level drag-and-drop and no client-side titlebar moves; both need
  a button serial on the human's seat. Modified pointer input (modifier plus
  click or scroll) is refused.
- X11 sessions are unsupported; Xwayland clients inside a Wayland session are
  in scope, except that their override-redirect menus are not pointer targets
  on KWin.
- In the owned-compositor mode and on the agent seat a scroll goes through
  KWin's own `wl_pointer`, which tells a client bound to `wl_seat` older than
  version 8 (GTK 3) nothing about a scroll under half a notch and keeps the
  remainder for one second, so small scrolls a few seconds apart are lost in
  such a client. Direct injection carries the remainder.
- The plugin is built per compositor version, so every KWin release needs a
  new build.
