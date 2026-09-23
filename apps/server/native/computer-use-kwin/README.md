# Synara KWin computer-use plugin

A binary KWin plugin that gives Synara native compositor integration for computer
use on Linux/KDE. It paints the agent's own visible cursor (`synara-agent`),
routes synthetic pointer and keyboard events through KWin's compositor seat so
real Wayland clients receive them, and exposes a small D-Bus control API.

This is the Tier 1 backend described in `docs/computer-use-linux.md`. It is
intentionally KWin-specific: a generic unprivileged Wayland client cannot inject
input into another client with an independent cursor. That requires running
inside the compositor, which is exactly the privilege level macOS computer use
uses on its side (WindowServer). See the design doc for the full rationale and
the macOS comparison.

## How it works

- Runs inside KWin as a `KWin::Plugin`, so it has the compositor's authority over
  input routing.
- The agent cursor is a KWin scene overlay `Item` (z=1000, parented to
  `effects->scene()->overlayItem()`), not a separate client window. This mirrors
  KWin's own `CursorItem`, except that the arrow is drawn by the plugin with
  `QPainter` rather than taken from the human's cursor theme: a second arrow in
  their own theme is indistinguishable from theirs, and telling the two apart is
  the whole point. It is a violet silhouette with a light rim and a dark outer
  stroke, so it reads against any wallpaper, sized from the human's own
  `themeSize` so both cursors are the same physical size. On a compositor the
  agent owns (a nested session) the same drawn item stands in for KWin's native
  cursor, which is hidden while a session runs: the native arrow depends on a
  cursor theme the host distro may not ship and on clients not hiding or
  replacing it, and the drawn item makes the agent's pointer look identical on
  every machine. It follows the seat's `Cursor::posChanged` there, since clients
  can warp the pointer and the human can drive it through the host window's
  pointer grab.
- A name badge — a pill naming the driving thread — is a second `ImageItem`
  child of the cursor item, offset below-right of the hotspot so it never covers
  the click point. It is fully opaque while the agent acts and fades out two
  seconds after the last action.
- Both images are rasterized at the scale of the output the hotspot is on and
  redrawn when the cursor crosses onto an output with a different scale, when
  the human's cursor theme changes, or when the outputs change.
- The plugin creates a dedicated `SeatInterface` named `synara-agent` and
  delivers all agent input on it: pointer focus/motion/buttons via
  `notifyPointerEnter` / `notifyPointerMotion` / `notifyPointerButton`, keys via
  `notifyKeyboardKey`. The agent seat mirrors the real keyboard's xkb keymap and
  tracks its own `xkb_state` for modifier events. The user's real seat is never
  touched in either direction, so agent and user can point and type at the same
  time without crossover, and the real system cursor never moves. Clients that
  never created a pointer on the agent seat are driven by direct injection into
  their own seat0 resources, under the rules in "Direct injection and the
  human's seat".
- Pressed buttons and keys are tracked and released on stop/destroy, so a crash
  or stop mid-action cannot latch a stuck modifier.

## Threat model

The trust boundary is the session bus and this uid. `authenticate(s token)`
is the one method any session-bus peer may call; to succeed the caller must
be the current owner of the well-known name `org.synara.ComputerUse.Server`
(one connection at a time) **and** present the 64-byte token stored in
`/tmp/synara-computer-use-<uid>-<bus id>.token`, a regular file owned by this
uid with mode 0600, which only this user can read. Every other method except
`healthJson` — public diagnostics with no pixels, titles or input — answers
`org.synara.ComputerUse.Error.Unauthorized` until then. The capability is
bound to the connection that earned it: when the name changes hands the
session is stopped and the next server authenticates afresh.

This is not a privilege boundary against the user's own processes — a
same-uid process already has the seat and could do everything the agent can.
It keeps a mismatched or stale server, or another user's process on a shared
bus, from driving the desktop, and it keeps the compositor thread cheap: the
name's owner is tracked from `NameOwnerChanged` rather than looked up per
call, the bus id is fetched once, and a peer whose attempt failed is refused
outright for one second without any bus round-trip or file access, in a table
bounded at 64 peers. A throttled attempt is answered with the D-Bus error
`org.synara.ComputerUse.Error.Throttled` rather than the empty string a wrong
token gets, so a server probing the plugin cannot mistake the cooldown for a
stale instance.

## D-Bus API

Service `org.synara.ComputerUse`, path `/org/synara/ComputerUse`, interface
`org.synara.ComputerUse1`. Methods: `healthJson`, `stateJson`, `windowsJson`,
`start`, `stop`, `setIdleTimeout(u milliseconds) -> b`,
`setHumanActiveGuardMs(u milliseconds) -> b`,
`setAgentName(s name) -> b`, `focusWindow`,
`raiseWindow(s windowId) -> b`, `clearFocusWindow`, `movePointer`, `button`,
`axis`, `key`, `resetInputDelivery() -> b`,
`captureWindow(s windowId, u maxDimension) -> ay`, and
`captureRegion(i x, i y, u width, u height, u maxDimension) -> ay`. One signal:
`sessionStopped(s reason)`, emitted whenever a running session ends, with the
reason `request`, `idle-timeout`, `user-release`, or `session-locked`. The
interface is described in `org.synara.ComputerUse.xml`.

### Interface version 2

`healthJson` reports `interfaceVersion` (2; absent on older builds, which are
version 1) and `features`, the optional methods on top of the version 1 set
that this build implements. The server calls one only when its feature is
listed and otherwise keeps using the version 1 methods, so an installed older
plugin keeps working with a newer server. Every version 1 method is unchanged.

- `windowsStateJson() -> s` (feature `windowsStateJson`) replaces a
  `stateJson` and `windowsJson` pair with one call. It answers an object with
  `windows` (the `windowsJson` array), `targetWindowId` (an id or null),
  `workspace` (`x`, `y`, `width`, `height`), `outputs` (one such rect per
  monitor, in the same global space) and `locked`. While the session is
  locked it answers with no windows and a null target instead of refusing.
- `captureWindowEx(s windowId, u maxDimension, u flags)` and
  `captureRegionEx(i x, i y, u width, u height, u maxDimension, u flags)`
  (feature `captureEx`) answer `(ay image, s mime)`: the version 1 captures
  with flags. `1` is passive, an observer's frame such as the preview: it is not
  agent activity, so it neither resets the idle deadline nor brings the badge
  back, and an open preview can no longer keep an abandoned session alive.
  `2` encodes JPEG at quality 85 (`image/jpeg`), `4` raw 8-bit luma
  (`image/x-luma8; width=<w>; height=<h>`, row-major, no padding) for
  measuring rather than showing; `4` outranks `2`. Without either it is the
  same PNG as the version 1 methods (`image/png`). JPEG and luma are flattened
  onto black, since neither has alpha. Unknown bits are ignored, and every
  refusal and error is exactly the version 1 methods', as on Hyprland.
- `keys(a(ub) strokes)` (feature `keys`) answers `u`: up to 256
  `(keyCode, pressed)` strokes in order, each checked exactly as `key` checks
  one (target, path, reachability, the human-active guard with its release
  exemption). It stops
  at the first stroke that is not delivered and returns how many were; a
  refusal of the first stroke is the same D-Bus error `key` sends. One call is
  one burst: the human's own events cannot land between two strokes, so a
  borrowed seat0 object is handed back once, at the end.
- `waitForSettle(s windowId, u quietMs, u timeoutMs)` (feature
  `waitForSettle`) answers `(b settled, u elapsedMs)`. It replaces a fixed
  sleep between an action and the observation of it. It replies once the
  window (any window, for an empty id) has committed new content after the agent's last input and
  then stayed quiet for `quietMs`, and with `settled` false at `timeoutMs`
  (clamped to 30 seconds) or when the window closes, and at once when no
  session is running or the id names no usable window. "New content" is
  `Window::damaged`: a commit that changes pixels anywhere in the window's
  surface tree, so a client that commits every frame only to request the next
  frame callback still reads as quiet. A wait answers for the agent's last
  input until one settles on it; after that, or before any input, a wait asks
  for content committed after the call itself. The reply is delayed and driven
  by the damage signal and one timer per wait; the compositor thread never
  blocks. `focusWindow` and `raiseWindow` count as input. A session stop (or
  the plugin unloading) answers every pending wait unsettled, and a lock
  answers them `SessionLocked`; more than 16 waits in flight answer
  `LimitsExceeded`. The Hyprland plugin answers identically.

`healthJson` also carries `xAuthority`: the cookie file of the Xwayland this
compositor started, read from KWin's own environment the same way `xDisplay`
is. It is absent when there is none. A nested session needs it to launch X11
clients, since the `XAUTHORITY` in the server's environment is the human's.

`resetInputDelivery()` is what the server calls whenever the desktop lease
changes owner: it clears the explicit target, releases every held button and
key, withdraws every direct-injection enter and hands the shared seat0 objects
back to the human (see "Direct injection and the human's seat" below). It works
whether or not a session is running and does not count as agent activity.

`axis(d horizontal, d vertical) -> b` takes desktop pixels, not wheel notches,
which is the unit the whole computer-use stack speaks; positive is right and
down. The plugin converts to the wheel's own units on the way out, at 80 content
pixels per notch — the same constant the Hyprland plugin uses — so a client that reads only the discrete half of a wheel event still
moves, and the continuous half goes out at libinput's 15 units per notch.

`setAgentName(name)` sets the text on the cursor's name badge and always returns
`true`; an empty string clears it back to `Agent`. The plugin has no way to know
which thread is driving it, so the server names the lease holder — it caches the
name and resends it after every session start, because the plugin forgets it
along with the rest of the session. Setting it mid-session brings the badge back
at full opacity, so a handover announces itself instead of happening silently.
`stateJson` reports the current name as `agentName`.

`windowsJson` reports windows topmost-first. Each entry carries `stackingIndex`
(`0` is the topmost reported window, increasing downward) and `occludedBy`, the
ids of usable windows above it whose frame rects overlap it. The overlap is a
rect intersection rather than true pixel occlusion, so a translucent or shaped
window above still counts; overstating it is the safe direction, because the
remedy — scoping the click to a window — is the same either way.

`raiseWindow(windowId)` restacks a window above the ones covering it and
returns `true` when it did. It deliberately does not call `activateWindow`: the
human's keyboard focus is never moved, because the agent drives its own seat and
only needs the window it is clicking to be the one on top at that coordinate. It
returns `false` when the session is stopped or the id names no usable window.
A restack can still bury the window the human is typing in, so while they are
active (the human-active guard's recency) a raise that would put the window
above theirs where the two overlap is refused with `HumanActive`. It goes ahead
when the window is already above theirs, sits in a lower layer, does not
overlap, or owns theirs as a transient.

`focusWindow(windowId)` also scopes the pointer: while a target is named, every
`button` and `axis` event goes to that window, not to whatever the stacking
order puts under the cursor. Without this, a click aimed at a partly covered
window is delivered to the window covering it, and the caller sees a button that
does nothing rather than an error. If the target has gone away, or does not
accept input at the current pointer position, `button` and `axis` return `false`
instead of retargeting — the same rule the keyboard already follows.

The target's own menus are the one exception, and they have to be: a popup is a
window of its own, so scoping to a window would otherwise make that window's
context menu unclickable. A click is accepted when it lands on the target **or**
on a popup in the target's transient tree, deepest first (a submenu is transient
for the menu that opened it and drawn above it). Popups are pointer targets
generally, not only under an explicit target: KWin's `XdgPopupWindow` answers
`wantsInput()` false by construction, so the plugin gates the pointer on
"focusable **or** popup" and the keyboard on `wantsInput()` alone. Nothing ever
focuses or activates a popup; the agent's keys stay on the window that opened
the menu, and the toolkit routes them to its open menu from there. KWin's popup
filter is not involved, and must not be: see "Popups the agent opens" below.

Each `windowsJson` entry also carries `active`: whether the compositor reports
the window as activated to its client. This matters because toolkits gate
keyboard-shortcut dispatch on activation, not on keyboard focus. Qt's shortcut
matcher requires an active window; a Ctrl-chord delivered to a window the
toolkit considers inactive is silently dropped, while plain typing and pointer
clicks still work. (Apps vary: KWrite drops shortcuts when inactive, KCalc and
Konsole fire them anyway.)

## Direct injection and the human's seat

The agent seat cannot reach a client that never created a pointer on it:
Chromium and Electron bind exactly one `wl_seat`, Xwayland does the same for
every X11 client behind it, and Gecko binds every seat but creates its pointer
only on the first. Those clients are driven by **direct injection**: the plugin
writes `wl_pointer` and `wl_keyboard` events straight into the client's own
seat0 resources, stamped with window-local coordinates (the window's input
transformation, the input-accepting subsurface, then the surface's own scale,
the same arithmetic KWin uses), without going through `SeatInterface`.

Those seat0 objects are the very ones KWin delivers the human's input on, and a
client keeps exactly one "entered" surface per object: whichever surface the
last enter named. Motion, button, key and modifiers events name no surface, so
an enter the agent sends for its target silently re-routes the human's next
motion or keystroke — which KWin delivers without a new enter, because it still
believes the object is in the human's window — into the agent's window. Every
X11 window on the desktop is one Xwayland client, and every window of a browser
is one client, so "another window" is not "another client".

The invariant the plugin keeps: **at every moment KWin could deliver a human
event, each client's seat0 objects name the surface KWin's seat0 has
focused.** Concretely:

- The agent borrows an object for a burst of its own events. Whenever seat0's
  pointer (for the pointer object) or keyboard (for the keyboard object) is on
  _any_ surface of the same client, the object is handed back as soon as the
  agent holds nothing on it: the agent's leave, then seat0's own enter re-sent
  — for the pointer with the serial KWin recorded for it, because KWin drops
  `wl_pointer.set_cursor` requests carrying any other serial, and at the
  human's pointer position; for the keyboard with the keys KWin knows the human
  holds — and then seat0's real modifiers through KWin's own per-client path.
  If seat0 is in the agent's target surface itself, the enter is never ours to
  revoke and nothing goes out: the client's pointer stays where the agent last
  moved it, and the human's next motion is absolute and puts it right.
- A press and its release are separate D-Bus calls (the server holds a click
  for 20 ms; a Shift+key chord is four calls), and a gesture has to land on one
  entered surface, so a shared object with a button or key held on it is
  **not** handed back between calls. It is handed back by whichever comes
  first: the release that empties the held set, the human's own next event of
  that class — the plugin's input spy runs before KWin's forwarding filter, so
  the agent's held buttons or keys are released on its surface and the object
  handed back before the human's event reaches the client — or seat0 moving
  through the client (below).
- When seat0 is on another client entirely, the object carries no human events
  and the agent's enter persists across calls, so hover state and
  press-move-release drags survive ordinary agent motion. If seat0 then moves
  into that client, KWin's own enter supersedes the agent's on the same object;
  the plugin observes `PointerInterface::focusedSurfaceChanged` and
  `SeatInterface::focusedKeyboardSurfaceAboutToChange`, releases any button or
  key the agent holds on the surface that saw the press, and forgets its enter.
  The next event re-enters.
- Plain `movePointer` never borrows a shared object at all; the enter is
  deferred to the action (`button`, `axis`, `key`).
- While the human is actively using the device the action competes with in
  that client (within the guard window) even a correctly restored burst
  disturbs them — their window sees a focus-out/in or a pointer leave/enter —
  so `button` and `axis` aimed at _any_ window of a client their pointer is
  busy in, and `key` aimed at any window of a client their keyboard is busy in,
  are refused with `org.synara.ComputerUse.Error.HumanActive` (see the
  human-active guard). The release half of a press the agent already delivered
  is never refused.
- On the direct path the agent's modifiers event carries its own depressed and
  latched state, its own layout group, and the human's _locked_ modifiers
  merged in (CapsLock, NumLock are properties of the keyboard the client
  believes it hears). `stateJson.capsLockOn` reports CapsLock as the next key
  will experience it — the agent's own state on the agent seat, the merged
  state on the direct path — and `humanCapsLockOn` the human's alone.

Cost of the shared case: while the human's pointer or keyboard rests in a
window of the same client, every agent action on that client is a leave/enter
pair on both windows, hover on the target does not persist between calls, and a
press-move-release drag across calls may be cancelled by a client that treats
a pointer leave with a button held as a lost capture. `stateJson` reports
`pointerClientShared` and `keyboardClientShared` so the condition can be seen.

Limitation: the plugin writes to the first `wl_keyboard` resource the client
holds. A client that created a keyboard but no pointer on the agent seat would
be routed to direct injection and could be written to on its agent-seat
keyboard; no known toolkit does this (they create both or neither per seat).

## Keyboard targeting and borrowed activation

`focusWindow(windowId)` names the window that receives all subsequent key
events, independent of where the pointer is. Three rules keep chords from going
astray:

- **Borrowed activation.** While the agent's keyboard focus rests on a window
  the human has not activated, the plugin marks it active via
  `Window::setActive(true)` — a visual/state change only, the human's real
  focus never moves: in KWin 6.7.4 `Window::setActive` never calls
  `Workspace::setActiveWindow`, and seat0's keyboard focus is recomputed only
  by `KeyboardInputRedirection::update()` from `Workspace::activeWindow()`,
  which only `setActiveWindow` assigns (the evidence is spelled out above
  `updateWindowActivation` in the source) — so toolkits dispatch shortcuts
  sent to it. The borrow is
  undone when focus moves on, the target is cleared, or the session stops, and
  it refuses to undo activation KWin has since granted for real (if the human
  activates the window themselves, the plugin leaves it alone). Cosmetic side
  effect: while borrowed, two windows may draw active-style decorations.
  **Never beside the human.** A toolkit keeps one active window per
  application, so borrowing activation for one window tells the client the
  human's other window of the same application lost it: a focus-out where they
  are typing, and a lost input-method pre-edit. While seat0's keyboard is in
  another window of the target's client, no activation is borrowed (and a
  standing borrow is given back when the human moves into that client). The
  agent's keys still arrive; only shortcuts that need an active window wait
  until the human is elsewhere.
- **Refusals before wire events.** `key`, `keys`, `button` and `axis` decide
  where the event would go and run every refusal (reachability, the
  human-active guard) before they send anything to get it there, so a refused
  action leaves no enter, focus change or borrowed activation behind.
- **The agent's serials are not the human's interaction.** KWin grants an
  `xdg_activation` token for any serial at or after the last interaction it saw
  on a real device (and for any serial at all to the active window), and every
  agent event carries a fresh, newer serial. So a client could turn an agent
  click into real activation, and one did: Chromium requests a token with the
  click's serial when one of its other windows has focus, and KWin moved the
  human's keyboard to the agent's window (measured on KWin 6.7.4). The plugin
  records the serials every agent call minted and installs its own token
  creator in place of KWin's: a token quoting one of them, or the agent seat,
  is refused (`stateJson` counts them in `activationTokensRefused`); any other
  request gets KWin's own decision and is issued by KWin's integration with
  the serial KWin would have stored. KWin's last interaction is never touched,
  so a launch the human set off (Kickoff, KRunner, a link) still activates
  when its window maps while the agent is busy. Unloading the plugin puts
  KWin's creator back.
- **A dead target is an error, not a fallback.** Once `focusWindow` has named a
  target, that target closing does not silently retarget key events to whatever
  window happens to be under the pointer. Key methods return `false` until the
  server names a new target or calls `clearFocusWindow`. `stateJson` reports
  this as `targetLost: true`.
- **Held keys never migrate.** When keyboard focus moves between surfaces, keys
  still held are released to the old surface first; when the old surface is
  already gone, they are dropped and the xkb modifier state is rewound. Without
  this, a dying target could hand the next window a phantom held Ctrl via the
  Wayland enter-with-pressed-keys array, turning the next chord into a
  misdirected shortcut in an unrelated app.

`stateJson` reports `keyboardWindowActive` (whether the current keyboard target
is activated) and `borrowedActivation` (whether that activation is the
plugin's borrow) alongside `targetLost`.

Every input method (`movePointer`, `button`, `axis`, `key`, `focusWindow`,
`raiseWindow`, `clearFocusWindow`) returns `false` while the session is stopped,
so a stop can never be followed by invisible input. Captures work in both
states.

Capture requests are rendered at the next safe compositor render opportunity.
`maxDimension = 0` keeps native pixels (the largest scale among the outputs
the capture touches); otherwise the image is downscaled so its largest
dimension is at most `maxDimension`. A downscale of a quarter or more is done by
the GPU: each output's part is rendered straight at the delivered scale, so the
readback, the compose and the encode only see the pixels that are sent (a 4K
output at scale 2 reads back 9 MB for a 2048 capture instead of 33). The GPU
samples surfaces bilinearly, which filters cleanly between three quarters and
half size, so a smaller target is rendered at half the native scale and the
encoder takes the rest with an area-averaging downscale, and a milder one
(1920 to 1536) is left to the encoder. Parts of a capture that spans outputs of
different scales, rotations or a negative origin are each rendered to their
exact rectangle of the canvas. Render targets are kept per size between
captures and freed ten seconds after the last one. PNG encoding uses
zlib level 1 (Qt quality 80): about half the encode time of the default level
for files a few percent larger. An opaque capture (a region; a window capture
keeps its alpha) is written as three-channel RGB. The agent's
own cursor is painted into the pixels, so the agent sees its pointer the way a
person sees theirs; the human's cursor never is — on the shared desktop it is
claimed by an exclusive `ItemTreeView` that is deliberately never painted.

Only one capture may be in flight. A second concurrent call fails with
`org.synara.ComputerUse.Error.CaptureFailed` and the reason `capture already in
flight`. The render deadline is 2 seconds. The PNG encode deadline is 5 seconds.
If encoding times out, the reply fails and a late worker result is discarded.
The encoder runs on one thread the compositor never waits for: unloading the
plugin mid-encode fails the request at once and lets the worker finish and
drop its result, rather than stalling the compositor until the PNG is done.

Captures work whether the input seat is running or stopped. `stop()` cancels an
in-flight capture. A region request is first clamped to the workspace geometry.
The rendered image (native, or smaller when downscaled as above) must be no
larger than 16,384 pixels on either side and 64 megapixels total. Requests above either limit fail
with `CaptureFailed` before the render target is allocated.

Capture failures are returned as the D-Bus error
`org.synara.ComputerUse.Error.CaptureFailed` with a one-line reason. The methods
never use an empty `ay` as a failure response.

## Idle timeout

A running session stops itself after 5 minutes without agent activity. The
timeout lives in the plugin on purpose: if the Synara server crashes or is
killed, its finalizers never run, and nothing else would take the agent seat
and the ghost cursor down.

- Any method that expresses agent intent resets the deadline: `movePointer`,
  `button`, `axis`, `key`, `focusWindow`, `raiseWindow`, `clearFocusWindow`,
  `captureWindow`, `captureRegion`.
- `healthJson`, `stateJson`, and `windowsJson` deliberately do not. The server
  polls health, so counting introspection would keep every session alive
  forever.
- `SYNARA_COMPUTER_IDLE_TIMEOUT_MS` overrides the value the server sends: `0`
  disables the deadline, anything else is clamped to 1 s – 1 h, and a
  non-numeric or out-of-range value falls back to the 5 minute default.
- `setIdleTimeout(u milliseconds)` reconfigures it; `0` disables it entirely.
  Anything else outside 1 s – 1 h is rejected with `false`. The server sends its
  configured value right after `start()`. The deadline is re-armed from the last
  activity, so lowering it can fire immediately.
- An idle stop takes the same path as `stop()`: pressed buttons and keys are
  released, pointer and keyboard focus are dropped, the ghost cursor is hidden,
  and an in-flight capture is canceled. It does not block the next `start()`.
- `stateJson` reports `idleTimeoutMs`, `idleMs`, `idleRemainingMs` (only while
  running with a timeout set), and `stopReason` for the last lifetime change
  (`request`, `idle-timeout`, `user-release`, `user-resume`).

A long model turn can outlive the deadline — a model that thinks for six minutes
between clicks will find the session stopped. That is expected: the server
restarts it on the next action (see below), and the ghost cursor disappears
while nothing is happening, which is exactly the point.

## Release-control hotkey

**Meta+Shift+Esc** stops the session immediately, from any window, and latches
the plugin so `start()` fails with
`org.synara.ComputerUse.Error.ControlReleased` until control is handed back.
The shortcut is registered through KGlobalAccel (`SynaraReleaseComputerControl`,
listed under KWin in System Settings, remappable there) and is free on stock
Plasma — kill-window is Ctrl+Alt+Esc. Meta+Shift+Esc is only the default asked
for: `healthJson.releaseShortcut` is the sequence KGlobalAccel actually bound
(the human's remap if they made one), read back after registration and again
whenever it changes, or `null` when nothing could be registered. The server
treats `null` as a setup blocker, because a session with no panic switch is not
one to start. `releaseShortcutRegistered` is the raw result of the registration
request.

The user's real seat drives KWin's shortcut handling, and agent input is
delivered straight to client surfaces on the `synara-agent` seat without
entering that pipeline, so the agent can neither trigger the shortcut nor
swallow it.

Pressing Meta+Shift+Esc again hands control back, and nothing else does: the
latch is one-way for everything but that shortcut. A D-Bus `stop()`, an idle
timeout, the screen locking, or a server re-authenticating after a restart all
tear down the session's input state and leave the latch as the human left it,
so a server that comes back after a panic stop cannot resume driving until the
human presses the shortcut again. `healthJson.releasedByUser` reports the
latch.

Unlike the idle timeout, this is a human takeover, so the server does not
restart the session behind the user's back.

## Human-active guard

The agent has its own cursor and its own seat, which is what lets it work while
you work. One window is still off the table: the one you are typing in. A
`button`, `axis`, or `key` whose resolved target is the window seat0 has keyboard
focus on, while seat0 has seen input inside the guard window, is refused with
`org.synara.ComputerUse.Error.HumanActive`. Nothing is injected, the error names
the window and the age of your last input, and the server turns it into a
retryable refusal carrying `computer_human_active` — the same token the
server's own guard uses, so a caller never has to know which side refused.

- Recency comes from a `KWin::InputEventSpy`, not from
  `SeatInterface::timestamp()`. A spy is called from `InputRedirection` before
  any filter, so it sees exactly the events real devices produced — and neither
  agent path can produce one, because the dedicated seat is a second
  `SeatInterface` outside that pipeline and direct injection writes to client
  resources without a seat at all. There is therefore **no attribution epsilon**
  here: nothing the agent does has to be subtracted from what the spy observes.
- Exempt: `movePointer` (a ghost cursor gliding over your window disturbs
  nothing — the refusal belongs on the action, same reasoning as
  `SeatUnsupported`), all perception, the clipboard, `focusWindow` and
  `raiseWindow` (focusing your window is harmless precisely because the `key`
  that follows is refused).
- A popup in the transient tree of the focused window counts as that window: an
  open menu is part of what you are doing.
- A window driven by direct injection is refused while the device the action
  competes with is busy in _any_ window of the same client — every X11 window
  shares one Xwayland connection, every browser window one browser — because
  the action would borrow the very input object your window is using. Per
  device: a `button` or `axis` is refused while your pointer rests in the
  client and was active within the guard window, a `key` while your keyboard
  focus is in the client and your keyboard was. Typing in a terminal with your
  mouse resting on an X11 window blocks agent keys into that terminal's client
  only, not clicks into X11 windows. Windows of other applications stay
  available, and the agent-seat path shares nothing and is unaffected.
  `stateJson` reports `msSinceHumanPointerInput` and
  `msSinceHumanKeyboardInput` beside `msSinceHumanInput`.
- The release half of a press the agent already delivered is never refused — a
  latched button or a stuck Ctrl in your window is worse than the press was.
- `SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1` disables the guard entirely. There the
  agent's input rides seat0, so recency would count its own events, and there is
  no human in that compositor to protect.
- `setHumanActiveGuardMs(u milliseconds)` reconfigures it; `0` disables it,
  anything else outside 100 ms – 60 s is rejected with `false`. The server sends
  its configured value right after `start()`, and
  `SYNARA_COMPUTER_HUMAN_ACTIVE_MS` overrides that value with the same parsing
  rules the idle timeout uses (default 2000 ms).
- `stateJson` reports `humanFocusWindowId` (empty when nothing has focus),
  `msSinceHumanInput` (`-1` when no real device event has been observed at all,
  which is not the same as a long quiet period) and `humanActiveGuardMs`.

## Popups the agent opens

KWin ignores the seat in `xdg_popup.grab`, and its `PopupInputFilter` treats
every grabbing popup as seat0's (KWin 6.7.4 `popup_input_filter.cpp`,
`xdgshellwindow.cpp`): when the popup maps it moves seat0's keyboard focus onto
it, every key the human presses goes to it, and their next press outside the
popup's application is swallowed to dismiss it. Left alone, a context menu the
agent opened in Chromium took the keys of a human typing in Kate (Enter
activated a menu item) and ate their next click. That happens on both of the
agent's paths: an agent-seat client grabs with the agent seat, which KWin
ignores, and a directly driven client grabs with seat0.

So an agent-opened popup never grabs:

- Each new `xdg_popup` is attributed when it is created, before its client can
  ask for a grab: a submenu follows its parent menu, and otherwise the popup
  belongs to whoever pressed into its client last, the agent (within 5 seconds)
  or the human. An agent popup has the connection that would record its grab
  cut, so KWin's filter never takes it: seat0's focus stays where the human put
  it, their keys go where they were going, and every click reaches what it
  lands on.
- The grab request is then checked against the exact answer: the agent seat,
  or a serial the agent's own press issued. When the creation-time guess was
  wrong either way, the popup is closed before it maps and whoever opened it
  opens it again. An agent grab never reaches the filter, and a human popup is
  never left without its grab.
- What the grab did for the popup is done by the plugin instead. A human
  press anywhere outside the agent's popups closes them, and the press is
  delivered, not eaten. An agent press on another application closes them too,
  as the grab would have. Stopping the session or `resetInputDelivery` closes
  them. Toolkits route key navigation to an open menu themselves, so the
  agent's keys still reach it through the window that opened it.
- `stateJson` reports `agentPopupCount` (open agent popups) and
  `agentPopupsDismissed` (how many the plugin has closed).

A compositor the agent owns (`SYNARA_COMPUTER_USE_OWNS_COMPOSITOR=1`) has no
human seat to protect, so there popups grab as usual.

## Lock screen and session activity

While the screen is locked (or a lock is being acquired) or the logind session
is inactive — the human switched to another VT or a greeter — the desktop is
off limits. Both facts are read from the compositor itself
(`WaylandServer::isScreenLocked()`, `Session::isActive()`), so the plugin cannot
disagree with what is on screen.

- Locking ends a running session outright, with `sessionStopped("session-locked")`:
  held keys and buttons are released before the lock screen takes the desktop,
  the ghost cursor is not drawn over it, and a capture already waiting for a
  frame fails with `org.synara.ComputerUse.Error.SessionLocked` rather than
  reading pixels from under the greeter.
- Every input entry point, `start()`, both capture methods, `stateJson` and
  `windowsJson` refuse with `org.synara.ComputerUse.Error.SessionLocked` at
  admission (the two reads name the human's focused window, where their
  pointer rests and every window title, which is the locked desktop in
  words), and a capture re-checks immediately before rendering. `healthJson`
  stays available and reports `locked`. The server maps the error to a
  retryable `computer_session_locked` refusal, not a connection failure.
- Unlocking restarts nothing; the server starts the next session when it next
  acts, exactly as after an idle timeout. The release latch is untouched.
- `healthJson` and `stateJson` report `locked`.

## Known limitations

**Drag-and-drop and titlebar moves are refused by design.** A client starts a
drag with `wl_data_device.start_drag` and asks to be moved with
`xdg_toplevel.move`; both carry the serial of the button press that began the
gesture, and KWin validates it against a real implicit pointer grab
(`SeatInterface::hasImplicitPointerGrab`, which requires that button to still be
down on that seat). Direct injection mints its serials from the display counter
and writes to the client's own resources, so seat0 never saw the press: the drag
is silently cancelled (`DragAndDropInputFilter` falls through to
`source->dndCancelled()`) and the move request is dropped
(`implicitGrabPositionBySerial` returns nothing). The agent seat holds a real
grab but KWin's single drag filter listens only to `waylandServer()->seat()`, so
a drag started there reaches nobody, and a titlebar move would anchor at
`input()->globalPointer()` — the human's cursor.

Every mechanism that would fix this drives the human's seat or their cursor,
which is precisely what the dedicated seat exists to avoid, so all of them are
refused. Press-move-release pointer drags are unaffected on both paths and are
what `computer_drag` does (text selection, sliders, canvas strokes, in-client
resize handles); only the protocol-level DnD handshake is out. Between windows,
use the application's keyboard-driven equivalent — cut/copy and paste, a
"Move to…" action, a file dialog. Windows are moved by asking the compositor,
not by dragging their titlebar.

**Xwayland's own menus are not pointer targets.** An X11 client's menus are
override-redirect windows, which KWin models as unmanaged `X11Window`s that
answer `isClient()` false, and every targeting predicate here starts there. A
click aimed at one lands on whatever it is drawn over. Wayland-native menus,
including Chromium's and Electron's, are `xdg_popup`s and are targetable.

## Build (Fedora KDE)

Dependencies:

```sh
sudo dnf -y --setopt=install_weak_deps=False install \
  cmake ninja-build extra-cmake-modules kwin-devel kf6-kcoreaddons-devel \
  kf6-kglobalaccel-devel qt6-qtbase-devel libepoxy-devel libdrm-devel
```

Build, install, unload older Synara plugin ids, load the new versioned id, and
print `healthJson`:

```sh
apps/server/native/computer-use-kwin/scripts/install-and-load.sh
```

The installer needs no root and touches nothing outside your home directory:
the plugin goes under `~/.local/lib{,64}/qt6/plugins/kwin/plugins`, which the
Plasma session env script Synara writes puts on `QT_PLUGIN_PATH`, and the
build cache and install state live under `~/.cache/synara/` and
`~/.local/state/synara/`. There is no system-wide install mode; a
`SYNARA_KWIN_PLUGIN_DIR` you cannot write is an error rather than a sudo
prompt. Use `--force` when you deliberately want another versioned load of the
same source and KWin build. `--noninteractive` is accepted and ignored, for
units generated by an older `enable.sh`.

After a KWin package upgrade that the running session has not picked up yet,
the installer builds for the KWin on disk, installs and stamps it, and stops
there with a log line saying the install takes effect at the next login. It
compares the version compiled into the build header with the one the
compositor reports over D-Bus (`org.kde.KWin supportInformation`); unloading
the running plugin for a build the old compositor would refuse would only
take the feature away for the rest of the session.

For a compile-only build that does not install or load anything:

```sh
cmake -S apps/server/native/computer-use-kwin \
  -B /tmp/synara-kwin-infra-build \
  -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build /tmp/synara-kwin-infra-build
```

Verify (read-only, does not act on the desktop):

```sh
busctl --user call org.synara.ComputerUse /org/synara/ComputerUse \
  org.synara.ComputerUse1 healthJson
```

Unload:

```sh
busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s SynaraComputerUsePluginV1
```

The loaded id is normally `SynaraComputerUsePluginV1`, `V2`, and so on. The
installer (and the server backend) query the `LoadedPlugins` property on
`org.kde.KWin.Plugins` — on KWin 6.7 the loaded-plugin list is a property, not
a method, and `UnloadPlugin` returns void rather than a boolean. Both fall back
to a `loadedPlugins` method for KWin variants that expose one; if neither
exists, the installer tries the base id and every matching installed versioned
filename. To unload and remove every installed Synara plugin file, use:

```sh
apps/server/native/computer-use-kwin/scripts/uninstall.sh
```

## Version stamping

CMake generates a private build header containing the Git short hash, the UTC
configure timestamp, and the KWin package version found by `find_package(KWin)`.
`healthJson` keeps all of its original fields and adds:

- `build`: `<git-short-hash>-<UTC-build-timestamp>`
- `gitHash`: the short Git hash used by the configure step
- `buildTimestamp`: the UTC timestamp from that configure step
- `kwinVersion`: the KWin version compiled against

The `healthJson` `capture` field is true only when KWin has an effects handler,
OpenGL compositing is active, and an OpenGL context is available. It does not
depend on whether `start()` has been called.

When KWin's workspace is available, `healthJson` also includes
`workspaceGeometry` with `x`, `y`, `width`, and `height` fields. Consumers can
use that geometry when no client windows are currently enumerable.

`healthJson` also carries the session-lifetime fields the server needs on its
existing poll: `idleTimeoutMs`, `releasedByUser`, `releaseShortcut`, `locked`,
`serviceRegistered` — whether this instance holds the `org.synara.ComputerUse`
bus name — and `objectRegistered` — whether it exports
`/org/synara/ComputerUse`. Both can be held by an older build that is still
loaded, and they fail differently: every instance shares KWin's one bus
connection, so the name request succeeds for a second instance in the same
process while the object path stays taken until the older instance's
destructor releases it, just before it drops the name. The plugin takes both
again the moment the name goes unowned, so a freshly loaded build becomes
reachable without a further reload; until then `healthJson`, answered by
whichever instance exports the path, says which half is missing.

The build identifier is diagnostic data. The plugin filename carries the reload
identity because KWin can keep a shared library mapped after `UnloadPlugin`.

For a reproducible build, set `SOURCE_DATE_EPOCH` to a Unix timestamp when
configuring: the build id and `buildTimestamp` are stamped from it instead of
the wall clock, so the same source at the same KWin produces byte-identical
build info. A malformed value fails the configure.

## Versioned plugin filenames

The installer writes the first changed build as
`SynaraComputerUsePluginV1.so`, then scans the KWin plugin directory and uses
the next higher `Vn` filename for a later changed build. It never overwrites an
older version. This is required on Wayland: unloading a plugin destroys its
instance, but KWin can still return the old mapped library when the same plugin
id is loaded again.

The installer records the source and KWin signature. Repeating it with the same
signature reuses the installed id, so the periodic systemd check does not create
an unbounded stream of identical plugin files. A source change, KWin upgrade,
or `--force` creates a new versioned id.

The plugin metadata sets `EnabledByDefault: false`, so KWin does not load any
installed version at compositor startup; only an explicit `LoadPlugin` (from
the installer or the server backend) loads one. With auto-load, every installed
version came up at startup and the oldest registrant won the
`org.synara.ComputerUse` bus name, shadowing the newest build — builds stamped
before this change still auto-load until they are uninstalled.

## KWin ABI

A binary KWin plugin must be built against the exact running KWin version. KWin
refuses to load a plugin whose embedded `PluginFactoryInterface<version>` does
not match. The factory IID comes from the installed `kwin-devel` headers, and
the generated health fields record the KWin package version used at configure
time. Rebuild after every KWin upgrade. The installer reports a clear error for
KWin's `has mismatching plugin version` refusal.

## Reload caveat (dev loop)

KWin never unloads a plugin's shared library. `UnloadPlugin` destroys the
plugin instance, but reloading the same plugin id serves the still-mapped old
binary, so a rebuilt `.so` under the same name silently does nothing. On
Wayland, KWin is the session, so restarting the compositor is not an option.
During development, install each rebuild under a versioned filename
(`SynaraComputerUsePluginV2.so`, `V3`, ...) and load that id instead.

## Automatic rebuild after KWin upgrades

`systemd/` contains a periodic timer and an `enable.sh` helper that generates
a user service and a path unit for this machine. The path unit watches one
file, `KWinConfigVersion.cmake` in whichever ABI directory holds KWin's CMake
package (it is written last by a package upgrade), and the service sleeps 20
seconds before running so the rest of the upgrade transaction has landed
instead of firing once per rewritten file. The timer checks every six hours.
The installer also includes the KWin RPM query and library metadata in its
signature, so on an unchanged system whose compositor is already running the
installed build a run is a no-op: nothing is rebuilt, unloaded or reloaded,
and the agent's session on the plugin survives the timer.

The service only runs inside a Wayland session: it carries
`ConditionEnvironment=WAYLAND_DISPLAY` and `Requisite=graphical-session.target`,
because the installer loads the plugin through the compositor's session bus and
there is nothing to load into otherwise.

`ExecStart` points at a stable wrapper, `~/.local/bin/synara-kwin-computer-use-rebuild`,
which runs `install-and-load.sh` from the directory recorded in
`~/.local/state/synara/kwin-computer-use-plugin/source-dir`. `enable.sh` writes
that file, so re-running it after moving or updating the app is all it takes;
if the recorded checkout is gone the wrapper fails with a message in the
journal rather than the units silently never rebuilding again.

The units are install-ready but are not enabled or started by this source tree.
To opt in later, run the helper from the repository root:

```sh
apps/server/native/computer-use-kwin/systemd/enable.sh
```

The helper enables the path and timer without starting either one. Nothing
needs root: the plugin installs into your home directory. `scripts/uninstall.sh`
disables and removes the units and the wrapper along with the plugin files, the
session env script, the install stamp and the build cache; it keeps the plugin
id counter, because KWin pins a plugin id to the library it first loaded for
the life of the compositor and a reinstall must never reuse one.

## Provenance

Seeded from a proven prior implementation in the sibling `Androdex-Desktop`
project by the same author, then renamed to Synara and updated for KWin 6.7.3
(the `ItemRenderer::createImageItem()` factory was removed upstream; `ImageItem`
now has a public constructor).
