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

`KWinComputerBackend.ts` drives `apps/server/native/computer-use-kwin/`, a
`KWin::Plugin` loaded into the human's own `kwin_wayland`. It reports backend
`kwin`, `visibleDesktop: true`, the full capability set, `dedicatedSeat` and
`textRangeSelection: false`. Selected when `org.kde.KWin` is owned on the
session bus and the session is Wayland; Plasma on X11 owns the name too, but
the plugin's dedicated seat exists only on Wayland, so that host is left
unclaimed rather than given a backend that refuses forever.

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
  are refused with the retryable token `computer_human_active`, whether the
  compositor or the server raised it. Every refusal is decided before the
  plugin sends anything; a raise that would bury their window is refused too,
  and no activation is borrowed in an application they are typing in. Serials
  the agent's events carry never count as the human's interaction: KWin
  refuses an activation token that quotes one, so a client cannot use an
  agent click to take the human's keyboard (Chromium did, between two of its
  windows), while a launch the human started still takes focus when it maps
  in the middle of the agent's work.
- `Meta+Shift+Esc` stops the session and latches until pressed again; a plugin
  that could not register the shortcut is reported as a setup blocker rather
  than advertising a hotkey that does not exist.
- A popup the agent opens never grabs. KWin ignores the seat in
  `xdg_popup.grab` and would move seat0's keyboard onto any grabbing popup,
  swallowing the human's keys and next click, so the plugin attributes each
  popup at creation, withholds an agent popup's grab, and closes it itself on
  a human press outside it (the press still goes through).
- Anything that would break the policy is refused rather than approximated:
  protocol drag-and-drop, client-side titlebar moves, modifier-held clicks.

### Plugin contract

The plugin exports the D-Bus object `org.synara.ComputerUse` at
`/org/synara/ComputerUse`, interface `org.synara.ComputerUse1`; `kwinDbus.ts`
(`KWinComputerPluginApi`) is the server-side typing. The server takes the
exclusive bus name `org.synara.ComputerUse.Server`, writes a random token to a
0600 file (`computerSessionAuth.ts`) and calls `authenticate`; every other
method except `healthJson` requires the authenticated caller, and the plugin
drops the caller when the server name changes owner.

- `focusWindow`, `raiseWindow` and `clearFocusWindow` aim keys and scope
  pointer input without activating; `resetInputDelivery` does everything a
  lease hand-over needs in one call and is what the manager runs on every
  lease change, release and emergency stop. The backend runs it only on a
  session that is up: a reset never restarts an idled-out session.
- A locked or inactive session refuses capture and input with
  `SessionLocked`. The backend maps it to a retryable refusal carrying an
  `inputPause` (token `computer_session_locked`) that names the window the
  seat was aimed at, when any; the manager latches the pause until a scoped
  observation of that window — or, for a pause naming no window, an unscoped
  observation with a screenshot — sees the desktop unlocked through
  `checkInputReady`, which reads plugin health through the same checks as the
  establishing read. The transition into the lock is announced once as a
  `desktop-interrupted` event so standing task consent does not carry across
  it.
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
  agent activity: the preview no longer keeps an idle session alive), JPEG,
  or raw luma, and reply with the bytes' MIME type. The server uses a
  feature only when it is listed, so an installed older plugin keeps working.
  `healthJson.xAuthority` names the cookie file of the compositor's own
  Xwayland, which X11 apps launched into a nested session need.
- Text selection is refused up front (`textRangeSelection: false`): AT-SPI
  exposes no settable selection this backend can read back, and nothing
  approximates it.

### Guidance

The backend declares `dedicatedSeat`, and the session-start instructions and
the `linux` help chapter render from that profile: native input available,
`ctrl` chords, `computer_human_active` as the wait-and-retry signal, and no
`computer_browser_*` route. Every other profile keeps the Cua host's text.

### Perception

`atspi_helper.py` is a Python process speaking newline-framed JSON on stdio,
supervised by `AtspiHelperClient` (`atspiClient.ts`) with a request deadline, a
frame cap and bounded restart. Its walk is bounded per window and per
application; partial results carry a marker rather than failing the read.
`atspiTreeTargeting.ts` fuses each tree with the plugin's window bounds into
the desktop-space `ComputerUiNode` tree the manager exposes.

### Engine behaviour

How the engine in `KWinComputerBackend.ts` behaves, whichever backend it serves:

- Connection: a dead bus is noticed from the socket itself (dbus-next never
  emits `disconnect`), and every call waiting on it fails at once. Reconnects
  back off from 250 ms to 30 s, and the backoff restarts only after a
  connection stayed up 30 s or carried an input. A plugin the human unloaded
  from the same compositor instance is not reloaded until the next real use;
  a restarted compositor gets it back. A compositor missing for 60 s is
  reported once as `desktop-gone`.
- Action path: a window list read once serves the whole desktop operation
  (75 ms, dropped on any input, focus or raise), through `windowsStateJson`
  when offered. No glide under a pixel or for the human's pane input. Text
  goes through `keys` a word at a time. Model captures
  use the core's 1536 px budget. `launchApp` reports the pid, the app id a
  launcher hands off to, and whether one of its windows took activation.
- Settle: with `waitForSettle`, an action waits until the target window has
  repainted and stayed quiet for 100 ms, for at most the 300 ms the fixed
  wait used to take. At 300 ms, a window that has not repainted at all is
  taken as unchanged and one still repainting as an animation; both are
  photographed then. After three actions in a row that saw no repaint the
  manager's fixed wait comes back.
- Preview: stills are passive JPEGs (`captureRegionEx`) at a 1280 px budget
  through `StillFramePublisher`. They slow from 500 ms to 2 s after four
  identical frames, wake on actions and window changes, and wait while a
  desktop operation runs. Five failed stills mark capture unavailable. A
  locked session or a timed-out capture does not count toward that, and
  health is re-read with backoff until capture works again.
- Typing is refused before any key on layouts the US-QWERTY table cannot
  type: Dvorak, Colemak, `intl`, `alt-intl` and non-US layouts. The short
  name (`us`) and the descriptive one a keymap without a layout list
  reports (`English (US)`) both count as plain US.
- Paste offers the text once (`wl-copy --paste-once`) and restores the
  human's clipboard as soon as it has been read. Any offer still open when
  the backend is disposed is withdrawn.

### Provisioning and packaging

Everything except distribution packages installs under the user's home,
without root, from the server process, and only `provision()` (the settings
panel's Set up) installs anything. With no matching prebuilt,
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

The AT-SPI helper and the plugin sources ship outside ASAR
(`LINUX_COMPUTER_USE_ASAR_UNPACK_GLOBS`): python3, bash and cmake read them off
the disk. `apps/server/scripts/cli.ts` copies both into `dist/`,
`scripts/release-smoke.ts` checks the packaging, and the packaged runtime smoke
loads `dbus-next` the way the backend does.

Environment: `SYNARA_KWIN_PLUGIN_DIR`, `SYNARA_KWIN_PREBUILT_DIR`,
`SYNARA_KWIN_SOURCE_DIR`, `SYNARA_KWIN_STATE_ROOT` override paths;
`SYNARA_COMPUTER_IDLE_TIMEOUT_MS` and `SYNARA_COMPUTER_HUMAN_ACTIVE_MS` tune the
session; `SYNARA_COMPUTER_IDLE_RELEASE_MINUTES` (default 10, `0` off) is how long
an unused desktop keeps its bus connection, the server's bus name and the AT-SPI
helper before letting them go, so a second Synara server can drive it (the next
use connects again); `SYNARA_ATSPI_PYTHON` and `SYNARA_ATSPI_HELPER` point at
the helper, and `SYNARA_ATSPI_EVENTS` switches its event-fed tree cache (off by
default on the real desktop, where registering for events makes every
application emit them, GTK 3 all of them; on in the nested desktop; `1` or `0`
overrides either).
Every variable the server reads for computer use is listed in `turbo.json`'s
`globalPassThroughEnv`, which turbo strips otherwise in strict mode; a backend
that reads a new one adds it there.

### Testing

Backend tests inject `FakeDbus` and `FakePlugin` (`computerPluginTestDoubles.ts`);
no test touches a real bus or compositor. `atspiHelper.python.test.ts` runs the
helper's own unit tests and its stdio framing against the real interpreter with
a fake `Atspi`. The plugin's fixture tests (`native/computer-use-kwin/tests`)
compile production functions against stub protocol resources. Seat delivery,
the same-client rule, the guard, the shortcut and lock refusal need a live
compositor and are exercised only against a disposable nested `kwin_wayland`.

## Backend: headless nested KWin

`nestedComputerBackend.ts` is `KWinComputerBackend` pointed at a private
`kwin_wayland` this server boots on demand. It is the tier every Linux host
gets that is not a KWin Wayland session — GNOME, the wlroots family, Plasma on
X11, a host with no session bus — and the only tier there. It reports backend
`nested-kwin` and `visibleDesktop: false`, so the Computer pane opens
automatically and is the only screen the desktop has. `SYNARA_COMPUTER_NESTED=1`
selects it ahead of detection; `SYNARA_COMPUTER_BACKEND=nested` forces it.

### Session

`nestedKWinSession.ts` gives each session a private runtime directory
(`$XDG_RUNTIME_DIR/synara-nested-sessions/<id>`, mode 0700; the user's cache
directory when there is no runtime directory, never `/tmp`), starts a private
`dbus-daemon` there, then `kwin_wayland --virtual --xwayland
--no-global-shortcuts --no-lockscreen` on that bus (without `--no-lockscreen`
KWin locks along with the human's logind session, and the plugin refuses every
call with `SessionLocked` until they unlock), waits for `org.kde.KWin`, unloads every
loaded Synara plugin id and loads the newest installed one. Size comes from
`SYNARA_COMPUTER_NESTED_SIZE` (`WxH`, default 1920x1080).

The bus runs a generated `--config-file`, not the stock `session.conf`: session
type, `unix:dir=` in the session's runtime directory, `EXTERNAL` auth and no
service directories, so nothing is ever activated on it. A portal,
notification or `org.a11y.Bus` call from an app in the nested desktop fails
with `ServiceUnknown` instead of starting a service with the bus's environment.
The bus and the compositor get an allowlisted environment (`PATH`, `HOME`,
locale, the `XDG_*` base directories, cursor theme, graphics-driver selection)
plus the session's own runtime directory and bus: never the human's
`WAYLAND_DISPLAY`, `DISPLAY` or `XAUTHORITY`, a compositor signature, the host
session bus, or Synara's secrets. The compositor also gets
`SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1` and the user's plugin root on
`QT_PLUGIN_PATH` (no env script, no relogin).

With `SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1` the plugin adds a virtual input
device to the compositor's own pipeline instead of a second seat: focus follows
clicks, KWin owns the xkb state, Xwayland forwards to X11 clients, and the
human-activity guard is off because no human sits in that compositor. The mode
is enabled only through the compositor's environment, set by
`nestedKWinSession.ts`, never by a D-Bus method. The pointer does not glide
there: the pane shows stills, so nobody would see the motion.

Launched applications get the session's runtime directory, the nested
`WAYLAND_DISPLAY`, the private bus, and the nested Xwayland's `DISPLAY` on top
of the scrubbed application environment, plus `XAUTHORITY` when the plugin
reports a cookie in `healthJson.xAuthority`. A `kwin_wayland` started directly
(KWin 6.7) runs Xwayland without a cookie and admits its own user through
`si:localuser`, so X11 clients connect either way and other users' clients do
not.
The compositor, the bus, Xwayland and every launched application are children
of the server (`supervisedProcess.ts`). `dispose()` ends them as process trees,
and a synchronous `exit` hook SIGKILLs them when the server dies by an uncaught
exception or `process.exit`. A server that is SIGKILLed runs neither, so each
session keeps a marker (`nestedSessionRegistry.ts`) naming its processes from
the first spawn on, with the server's pid and start time; the next server
sweeps markers whose owner is gone when its nested backend is constructed and
again before each boot. The sweep only reads a 0700 directory the user owns,
only signals `kwin_wayland`, `dbus-daemon`, Xwayland, `at-spi-bus-launcher`,
`at-spi2-registryd` or recorded apps whose argv and start time still match, and only deletes the
session directory the marker is named after.

### Lifecycle

Construction and `probeAvailability()` boot nothing (construction only starts
the stale-session sweep). First real use boots the session in about a second,
installing the plugin into the home directory first when it is missing. A
failed boot is reported once per call: it ends the connect ladder instead of
being retried inside it, and arms no reconnect timer. `dispose()` aborts a
plugin build or boot in progress. `provision()` is the only step that installs
system packages (`kwin`, `wl-clipboard` and the build toolchain in one `pkexec`
authorization); it then provisions the plugin and boots the session. An
authorization dialog nobody answers is cancelled after five minutes, and
`dispose()` cancels one still waiting; both end only `pkexec` while it still
runs with the user's real uid. A package manager that is already running as
root is never interrupted.

A dead compositor is never restarted on a timer: the backend reaps the
session, reports `dormant`, and the reconnect loop stands down. The next real
use — an agent action, a pane attach, Set up — boots a fresh session exactly
as first use did. `statusAvailability()` is what keeps the settings poll from
being one of those uses: it answers from the passive probe while a boot is in
flight and reports the desktop as not running after it died, without touching
it. `capabilities()` reports the empty set until `kwin_wayland` and an
installed plugin exist, so the panel can offer Set up, and the full KWin set
afterwards (`capabilities-changed`).

A desktop nobody uses is shut down after `SYNARA_COMPUTER_NESTED_IDLE_MINUTES`
(default 10, `0` keeps it up): no call in flight, no pane attached, no lease
held, no app the agent launched still running, and no window on it. Parked
that way it is not dormant: status reads, `availability()`, `listWindows()`
(empty) and `getScreenSize()` (the last size) answer without booting it, and
the next real use boots it again in about a second.

`SYNARA_COMPUTER_NESTED=window` (or `SYNARA_COMPUTER_BACKEND=nested-window`)
drops `--virtual` and nests the desktop as an ordinary window of the host
session. It fails the seat policy on purpose — a window appears on the host —
and exists only for debugging; it refuses to start without a host
`WAYLAND_DISPLAY` rather than falling back to virtual.

AT-SPI is off by default on the nested desktop. `SYNARA_COMPUTER_NESTED_ATSPI=1`
opts in: the session then starts `at-spi-bus-launcher --launch-immediately`
itself, with the session's display, bus and runtime directory, so the
accessibility bus (and `$XDG_RUNTIME_DIR/at-spi/bus`), its registry, and every
app that finds them stay inside the nested desktop. The launcher runs with
`ATSPI_DBUS_IMPLEMENTATION=dbus-daemon`: a launcher built for dbus-broker
activates services as units of the human's systemd user manager, outside the
session, where the registry never came up. The session also starts
`at-spi2-registryd` (found next to the launcher) itself, as one of its own
children, rather than waiting for activation. Without a launcher the session
reports no accessibility bus and the reader stays off.
The nested-only variables (`SYNARA_COMPUTER_NESTED*`,
`SYNARA_COMPUTER_USE_OWNS_COMPOSITOR`, `SYNARA_NESTED_KWIN_TEST`) are listed in
`turbo.json` with the KWin ones.

### Testing

`nestedKWinSession.integration.test.ts` runs behind `SYNARA_NESTED_KWIN_TEST=1`
and boots a real private bus and `kwin_wayland --virtual`. Beyond the plugin
load, geometry, capture, clipboard and crash cases, it checks that nothing is
activatable on the private bus, that the bus, Xwayland and accessibility
launcher carry none of the host's display variables or Synara's secrets, that
an X11 client launched into the session connects, that `org.a11y.Bus` comes up
inside the session, that an idle desktop shuts down and reboots on the next
use, and that building a backend sweeps the desktop of a SIGKILLed server. Run
it outside any sandbox that kills `kwin_wayland` (for example under
`systemd-run --user`) with a scrubbed environment and a private
`XDG_RUNTIME_DIR`, since the sweep case reaps every stale marker there. The unit tests cover
mode and size parsing, environment construction, load planning, dormancy and
the status read with fake spawners and the shared plugin doubles.

## Known gaps

- Nothing here is verified against a live compositor by the test suite.
- Text and character keys need a US layout without dead keys (`us`,
  `us(altgr-intl)`, `us(euro)`) and are refused on any other; named keys
  still work.
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
  new build; a KWin upgrade leaves no plugin loaded until the next login
  provisions one.
