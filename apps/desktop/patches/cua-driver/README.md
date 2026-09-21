# Synara native Cua revision

`0001-synara-native.patch` applies to the exact upstream commit in
`packages/shared/src/cuaDriverRelease.json`. That manifest pins the patch checksum,
Rust version and native protocol revision. Preserve the upstream license in
`docs/computer-use-cua/CUA-LICENSE.txt`; the original Cua implementation and its
contributor attribution remain intact. This is a local macOS patch, not an
upstream release or a claim of support on other platforms.

The patch closes native input admission irreversibly for one driver process.
Keyboard and mouse guards prepare their matching releases before sending a down
event and release on normal return, failure, cancellation and Rust unwind. A
separate action lease covers native context restoration and verification.
The private `cancel_input` daemon method accepts only the authenticated embedded
parent and the exact child PID. A cleanup acknowledgement requires all registered
inputs and action contexts to finish. Host EOF drains the same gate before
aborting connection tasks. Synara refuses to kill or replace an active generation
when that acknowledgement is absent or invalid.

Pixel clicks and text can select synthetic delivery before dispatch. Clicks use
the native app or Chromium recipe according to process metadata, with one event
transport instead of duplicate SkyLight/CoreGraphics submissions. No uncertain
action is replayed or silently promoted to foreground. The cursor overlay keeps
one replaceable pending bitmap and one queued presentation callback; CoreGraphics
takes ownership of that bitmap without making another full-screen copy.

Revision 2 adds read-only `check_input_ready` for the exact PID/window, with
reviewed authorization and restricted-window grants. Input admission rechecks
window ownership, active Space, visibility and optional observed bounds at native
dispatch boundaries. A Space change invalidates the current action while held
releases and focus restoration drain; it does not retire the driver generation.
Semantic AX actions distinguish pre-dispatch refusal from attempted or uncertain
mutation. A submitted selection/value write never falls through to another
actuator, and exact foreground activation no longer requests all sibling windows.

Revision 6 bounds post-action window observation for background delivery through
`SYNARA_CUA_BACKGROUND_OBSERVATION_MS` — the same env-var mechanism foreground
delivery already uses — and fetches each accessibility-tree element's attribute
set in one `AXUIElementCopyMultipleAttributeValues` IPC call instead of the
previous per-attribute round-trips. Per-attribute failures decode through the
same error markers the API returns; elements that do not serve `AXActionNames`
through the attribute API still take the dedicated call. Observation and
dispatch semantics are unchanged: the detector's wildcard suppression and
result hints still cover the window in which action side-effects typically
appear.

Revision 7 overlaps the per-element accessibility IPC of a sibling array:
a bounded worker pool fetches each child's attribute batch while tree
assembly, ordering, budget accounting, and truncation flags stay on the
walk thread in the exact serial sequence, so rendered output is unchanged.
Workers never share an element, a panic cannot strand queued results, and
`CUA_AX_SERIAL_FETCH` restores the inline serial fetch for comparison or
diagnosis.

Revision 8 adds a second embedded liveness channel. Stdin EOF is the fast
path, but a leaked duplicate of the lifetime fd can hold the channel open
past host death; the daemon now also polls `CUA_DRIVER_EMBEDDED_HOST_PID`
with `kill(pid, 0)` and shuts down when the host is gone, so an orphaned
serve process cannot outlive its host under the AppKit run loop.

Revision 9 guarantees the serve thread's exit(0) actually runs: a panic
unwinding the cua-serve thread previously left the main thread parked in
the AppKit run loop forever — an immortal orphan with a dead serve loop,
a live socket, and a ghost overlay. `catch_unwind` around `run_serve_cmd`
keeps the panic text on stderr while exit(0) still terminates the process.

Revision 10 adds exact semantic-only text delivery. A retained accessibility
element token can receive text without activating its application or posting
process-scoped keyboard events; unavailable or unverifiable semantic insertion
is refused instead of falling back. Process-scoped native mutations remain
exclusive, while semantic mutations to different exact windows may overlap and
same-window mutations remain ordered.

Revision 11 makes exact semantic text visibly progressive and concurrently
admissible. Each exact target retains its own native input lease while the
generation gate validates every active target before character-paced AX
requests. Different exact windows can visibly receive text together; an
exclusive or process-scoped action cannot overlap them. Cancellation after a
submitted character reports observed partial delivery or an uncertain effect
instead of claiming that nothing happened.

Revision 12 rejects a second concurrent native semantic lease for the same
exact PID and window. Synara already orders same-window requests in the server;
the native check preserves that isolation for direct or separate clients while
continuing to admit independent exact windows concurrently.

Revision 13 keeps exact semantic text admitted when its retained accessibility
element moves to another macOS Space. The native gate requires unchanged
WindowServer ownership, nonempty stable Space membership, exact AX ancestry and
positive geometry before every character. Active-Space changes still cancel
pointer, synthetic keyboard and foreground actions, but do not cancel a stable
semantic lease. Off-Space pixels are labelled freshness-unverified and cannot
be used as live grounding without switching Spaces.

Revision 14 reports the exact layer-0 window's Space metadata from
`get_window_state`. The state tool now uses the same Space-aware WindowServer
lookup as input admission, while retaining the any-layer fallback needed to
identify unsupported accessory surfaces.

Revision 15 rebases the patch from cua-driver 0.24.0 (`4b3396d9`) onto 0.28.2
(`fc188250`) and bumps the native revision literal to 15. The upstream changes
inherited in the same files are the macOS click-delivery split (#2907
background is one SkyLight post with a public fallback, foreground is one
public pid post), the cursor overlay exclusion from foreground verification
(#3704), the embedded-host build fix (#3687), the desktop snapshot identity and
payload ownership rework (#3616) and the macOS browser checkbox read (#3404).
Synara's admission-gate wrapping, single-transport event posting, exact-target
delivery modes and retained semantic-text delivery are preserved on top; the
only judgment call is that `MousePostMode::Both` now means one SkyLight-first
submission instead of the upstream duplicate SkyLight plus public post, and
`click_at_xy_native_with_window_local` preserves the non-Chromium synthetic
recipe on the background path.

Revision 18 adds read-only `wait_for_settle`. An `AXObserver` bound to the
requested pid's application element — or to the exact AX window when
`window_id` scopes it — subscribes to the six change notifications that are
available and resolves once the surface has been silent for `quiet_ms`
(default 1000, capped at 5000) or reports `settled:false` with the observed
event count at `timeout_ms` (default 5000, capped at 30000). The tool takes
no input admission and no mutation lease: teardown removes the run-loop
source and the registered notifications on every path, a retired input
generation ends the wait early, and `cancel_input` never waits on the
observer because it registers no input operation for the gate to drain.
Synara prefers this observed settle after a mutation whose window is known
and exposes it through `computer_wait` with `settle:true`; a driver or host
that cannot answer it is remembered as unsupported and the fixed post-action
wait remains the fallback.

Revision 19 extends `key_name_to_code` with the xdotool-style keypad and
extended-function vocabulary: `kp_0`–`kp_9`, `kp_enter`, `kp_add`,
`kp_subtract`, `kp_multiply`, `kp_divide`, `kp_decimal`, `kp_equals`,
`kp_clear`, `f13`–`f20`, `menu`, and `help`, all verified against Apple's
`HIToolbox/Events.h` codes. Synara still refuses `insert`/`ins` (macOS has
no Insert key) before dispatch; unmapped spellings keep the honest
`unknown_key_name` refusal.

The gate applies to the SDK tool path admitted by Synara's GUI host. It does not
instrument the separate interactive-worker API. An acknowledgement means native
release events were submitted and action contexts drained; fixture-owned event
counts are the independent evidence that a tested target consumed those releases.
An external SIGKILL, process crash or OS failure cannot be given a cooperative
cleanup guarantee.

Build using `apps/desktop/scripts/provision-cua-driver.mjs --source-checkout
/path/to/cua --arch arm64` (or `x64` / `universal`). The script archives the pinned
commit, so checkout edits do not enter the build, applies the verified patch and
uses Cargo's lockfile. `--offline` uses already-cached dependencies. Without a
source checkout it fetches that commit from the official upstream repository.
Rust and the Apple build tools are build-time dependencies only.

For reuse, `--artifact-dir /path/to/built-directory` verifies the manifest,
pre-signing executable checksum and Mach-O architectures. Desktop packaging can
use the same directory through `SYNARA_CUA_ARTIFACT_DIR`. Signing changes the
executable bytes; the recorded checksum describes the artifact before app signing.
The stock upstream `--archive` path is intentionally rejected because that binary
does not implement the native cancellation revision required by the host.

When bumping the revision: the daemon stamps `synara_native_revision` from a
literal in `crates/cua-driver/src/serve.rs`, not from the manifest — a patch
that carries `nativeRevision: N` while the literal stays at `N-1` produces a
binary whose metadata handshake fails and whose daemons the host retires
seconds after spawn. Bump the literal in the same edit that bumps the manifest,
then confirm the staged binary reports it (`metadata` over a live socket, or
`strings` on the binary) before packaging.

`0001-synara-native.patch` is self-contained: it carries the `select_text`
tool file itself, not just the registry wiring. Earlier revisions kept the
tool's new-file hunk in a separate `0002-select-text.patch` record, but a
`git diff` of tracked files cannot capture an untracked source file, so the
file's creation lived only in 0002 while its registry wiring was duplicated
inside 0001. During the `7fe7c33f` rebase the file hunk was folded into
0001 and 0002 retired — applying 0001 to either base now reproduces the
complete patched tree (verified byte-identical against the patch-work
checkout on the `fc188250` base). The folded patch regenerates at sha
`7a2698bbd3b2cf49dd07e1fe0f06db84c4d7a5009d82469f9f24b10887f88919` and
`cuaDriverRelease.json` pins `nativeRevision: 20`. The tool writes an
exact-range `AXSelectedTextRange` on a resolved element token with attribute
read-back as the only confirmation path. Registration spans the platform-macos
tool registry, `ACTION_RESULT_TOOLS`, the legacy action-record normalization
lists, authorization/capture-scope/session-manifest tool inventories, the SDK
adapter's stable-Space-membership and input-lease lists, and the cursor
classifier. `docs/computer-use-cua/native-select-text.md` records the design.

Revision 20 rebases the patch onto upstream `7fe7c33f` (nightly
`v0.28.3-20260918`) without a protocol bump — the upstream delta inherits the
agent cursor-shape observation and system-cursor-shape reporting (#3883), the
foreground-escalation hint for unavailable UIA clicks (#3888), Hyprland
agent-input stabilization, X11 click-identity preservation (#3864) and the
local-install uninstall reporting (#3021). The patch applied with zero
conflicts; the only structural repair was folding `select_text.rs` into 0001
as described above. On current macOS the staged binary must additionally be
re-signed with `codesign --force --sign -` — the linker's embedded
`linker-signed` adhoc signature is killed at exec (SIGKILL), which the
provisioning script now performs after staging.

Revision 21 restores bounded visual motion to the compact cursor without
touching input latency. `MoveTo`/`ClickPulse`/`SnapTo` still collapse to an
immediate logical position — registry, visibility and dispatch all see the
hotspot at once — but the render state records a paint-only glide
(48px minimum travel, ~70–190ms ease-out, chained retargets continue from the
currently painted spot) and a 260ms expanding violet click ring drawn under
the arrow. Held-button drags, sub-threshold hops, first on-screen placement
and `reduced_motion: on` all snap silently with no ring. Idle-hide becomes a
180ms fade instead of a pop, and `needs_frame_tick` reports compact animation
activity so the render loop wakes only while a glide, ring or fade is in
flight — a settled compact cursor still costs zero repaints.

Revision 22 fixes isolated-browser detection on modern macOS.
`has_trusted_codesign_identity` ran `codesign --verify --strict`, which rejects
any executable carrying an extended attribute as detritus. Gatekeeper stamps
`com.apple.provenance` onto every app launched through LaunchServices and
restores it when removed, so a stock signed Chrome or Edge install could never
pass — `browser_prepare` always refused `browser_route_unavailable`. The strict
flag is dropped; the verify + test-requirement pair still pins Apple anchoring,
the vendor team identity and the bundle identifier, which is the security
boundary the check exists to enforce.

Revision 23 keeps driver-owned isolated browsers out of the foreground.
Chromium activates its first window even for an isolated launch, so the
isolated spawn landed visibly in the user's space. A new
`conceal_spawned_browser` platform hook is invoked at spawn time; the macOS
adapter re-hides the spawned pid over the startup window so the browser
process binds headlessly without touching its windows, profile, or input
contract.

Revision 24 makes that concealment last the whole session and closes the
remaining trusted-input paths that could raise a standalone browser window.

- Concealment persistence: `conceal_spawned_browser` no longer runs a
  five-second re-hide loop. The macOS adapter registers the spawned pid in a
  process-lifetime watcher that hides it as soon as the registration lands,
  keeps a fast 50 ms cadence across the spawn/first-window race window, then
  sweeps every 250 ms for the rest of the process's life. An
  `NSWorkspace.didActivateApplicationNotification` observer hides the pid
  again the moment it becomes frontmost, and `visualize_browser_action`
  re-hides it around every browser action. The watcher only ever calls
  `hide()`; it never unhides, never activates, and never touches the
  process, its profile, or any input contract. Session end is the browser
  process's own death — the watcher prunes the entry and parks.
- Spawn activation suppression: the spawn path issues no activation call.
  Chromium's first-window activation is withdrawn by the watcher (the
  observer catches the activation itself, the sweep catches window creation
  without an activation notification), and nothing in the driver re-shows a
  concealed pid.
- Trusted input never raises: `browser_click`, `browser_pointer`, and now
  `browser_type` all consult one shared standalone check before any event is
  sent. The check keeps the pre-existing CDP-window-id proof and
  additionally treats a non-embedded endpoint access class (`DriverOwned`,
  `ExistingProfileApproved`, `ExternalConsumerBrowser`) as standalone, so a
  browser bound without a `Browser.getWindowForTarget` window id — a tiling
  compositor, or an endpoint that omits the Browser domain — can no longer
  receive a trusted dispatch that raises its window. `browser_type` had no
  such guard at all: trusted `Input.insertText`/`Input.dispatchKeyEvent`
  now return `browser_input_trust_unavailable` with
  `trusted_delivery_attempted: false` and
  `alternative_route: native_element_text` instead of raising the window.
  Nothing is silently downgraded to a synthetic route, and no success is
  claimed for an event that was not delivered.
- The revision also adds `accessibility.text.selection` to the canonical
  capability vocabulary, a token the rev-20 `select_text` tool already
  claimed; the capability-vocabulary test was red on a clean patched tree
  without it.

`apps/desktop/scripts/provision-cua-driver.mjs` now records
`binarySha256` after the staged binary is adhoc-signed, so a reused
artifact directory verifies against the bytes it actually holds instead of
the pre-sign digest.

Revision 25 rebuilds the compact agent cursor and gives `browser_type` a
background route.

- Cursor motion: the compact cursor no longer eases along a straight line for
  a fixed duration. Each channel is a spring (`spring.rs`): travel progress
  from a distance-scaled response (scaler 0.9, clamped 0.12–2.2 s, damping
  0.9), lean toward the path tangent (response 0.09, damping 0.86, capped at
  76°, blended back to level over the last 1% of the path), a press/scale
  channel, and speed-driven stretch/squash past the 196 pt scoot threshold
  (response 0.095, damping 0.72). Travels follow a scored candidate bezier
  (`arc.rs`): 20 candidates alternate sides and size around the configured
  arc size/flow, the preferred one keeping every control point and sample
  inside the screen frame minus a 20 pt margin; chords under 10 pt stay
  straight; every path falls back to the direct chord when the frame cannot
  fit a bow. The integrator substeps by response so a long frame gap (an
  idle wake) can never teleport or explode a channel. Early-ack: the
  non-compact arrival signal now fires at 99.5% of the path or within 3.157 pt
  of the target instead of only at the physical end, and the compact motion
  exposes the same committed state.
- Cursor artwork: the fixed compact arrow is repainted with three layers —
  an offset soft shadow, a light rim, and a near-black fill — and the paint
  call consumes the channels (lean about a 0.5 pivot, stretch/squash, press
  shrink, loading breath). Hidden cursors freeze their motion instead of
  animating off-screen, and a settled cursor still costs zero repaints.
  Original vector artwork, no reference assets.
- Background typing: `browser_type` accepts
  `input_route: "trusted" | "dom_event"`, matching `browser_click` and
  `browser_pointer`. The trusted route is unchanged and still refuses for a
  standalone browser on macOS. The explicit `dom_event` route (ref required,
  `mode=insert_text` only) focuses the element in the page, inserts through
  the element's native value setter (input/textarea) or
  `document.execCommand('insertText')` (contenteditable), dispatches
  `input`/`change`, and confirms the result with a live read-back of the
  node. It sends no Input-domain event, so it cannot raise the browser
  window. The verdict stays honest: `effect: unverifiable` with a page-state
  escalation, a `browser_input_incomplete` refusal when the read-back does
  not match, and `browser_action_unavailable` for a ref that is not an
  editable element. No text ever leaves the page; results carry lengths and
  booleans only.

Revision 26 removes the session badge, makes the stock pointer monochrome, and
keeps spawned browsers invisible.

- Badge removal: every `paint_session_badge` call site is gone from both the
  compact and the classic cursor paths (`render_state.rs`), so no label chip,
  action glyph, or badge alpha can reach the pixmap in any mode. The label
  state machine stays dormant and harmless; a regression test renders a
  labelled cursor and asserts pixel-for-pixel equality with an unlabelled one.
- Stock colors: the paint no longer tints from the session hash. The default
  pointer is monochrome — near-black fill, light rim, soft black shadow — in
  both paths; the classic `cua.default` theme maps its blue body palette key
  to the stock fill and its white ink to the style rim, and custom themes keep
  their authored colors. A new session-scoped `set_agent_cursor_style` tool
  accepts optional `fill`/`rim`/`shadow` `#rrggbb` channels (omitted = stock,
  junk is rejected with an honest error). It is registered as an internal
  control tool: callable by the embedding host over the daemon socket,
  deliberately absent from the model-facing `tools/list`.
- Offscreen spawn: the isolated Chromium launch now passes
  `--window-position=-32000,-32000` on every platform, so the first window is
  created off every display even before the process-lifetime conceal watcher
  lands its first sweep. The watcher still never unhides or activates, and
  `visualize_browser_action` re-hides around every browser action.
- Focus/z-order audit: `invoke_menu` no longer falls back to a raising
  `NSRunningApplication.activateWithOptions` when the exact-window key recipe
  is unavailable — it uses the yabai-style focus-without-raise recipe (or
  proceeds when the target app is already frontmost) and refuses rather than
  raising. The background click recipe still uses `activate_without_raise`,
  `set_app_visibility` uses `AXHidden` with no activation, and the cursor
  overlay keeps its non-activating accessory-policy borderless window
  (`orderFrontRegardless`, no make-key, click-through). Restore funnels
  (`focus_steal` demotion, click/drag/menu "previous frontmost" restores) keep
  Cocoa activation on purpose: they run only to undo an observed steal, and a
  non-raising focus would leave the intruder's window on top.

Revision 27 softens the cursor shadow, makes `invoke_menu` work on a
windowless app, places spawned browsers truly offscreen through CDP, and
makes launch arguments reach an already-running Chromium app.

- Soft cursor shadow: the compact stock arrow's drop shadow is now a
  blurred silhouette (three separable box passes, radius 2 pt, 42% peak
  opacity, offset 1.2/1.8 pt down-right) rendered into a scratch pixmap and
  composited beneath the rim and fill, so the blur can never smear the
  crisp ink or the click-pulse ring. Stock inks and the
  `set_agent_cursor_style` `shadow` channel are unchanged; render tests pin
  the soft ramp, the peak opacity, the down-right offset, and the bounded
  footprint at 1×/2×/3×.
- Windowless menus: `invoke_menu` now takes an optional `window_id`
  (contract `InvokeMenuInput`). With a window id the exact-window semantics
  are unchanged (validate the window, make it key without raising,
  restore). With `window_id` omitted the path resolves from the
  application-level `AXMenuBar` of the application element every hop and
  invokes it with no window focus, raise, or activation — the only route
  for an app that has no windows at all, and the previous refusal
  ("window_id does not belong to pid") is unreachable on that path. The
  Windows/Linux implementations refuse the omitted form honestly (their
  menu routes need an exact window).
- Real offscreen spawn: `--window-position` is a Windows/Linux-only
  Chromium switch — macOS Chrome creates its first window on screen while
  the switch is present (live-verified in revision 26). After the spawned
  endpoint is attested, the driver now writes the window origin through
  `Browser.setWindowBounds` (-32000, -32000), reads `Browser.getWindowBounds`
  back, and reports the observed bounds in the `browser_prepare` message.
  The proof is honest: an unchanged or unreadable window is reported as
  such and never claimed offscreen. The process-lifetime conceal watcher
  stays armed as the backstop and nothing here unhides or activates.
- Launch arguments: LaunchServices delivers
  `NSWorkspaceOpenConfiguration.arguments` to a NEW application instance
  only; a launch handed to an already-running app silently drops them. The
  launch path now forces `createsNewApplicationInstance` exactly when
  arguments are present and the app is already running, so
  `additional_arguments: ["--incognito"]` reaches a running Chromium
  browser, whose process singleton opens the requested incognito window.
  Hidden/activation rules are unchanged.

Revision 28 recognizes Helium as a macOS Chromium-family browser.

- Product token: `is_chromium` (`platform-macos/src/browser/platform.rs`)
  adds the `helium` token, so both the display name "Helium" and the bundle
  id `net.imput.helium` classify. `get_window_state`'s Chromium window list
  takes the same token so a Helium window carries the browser-chrome
  capture-coverage caveat. No `BrowserProduct` variant is added: Helium
  reports `Other`, and the CDP route gates on the engine family, not the
  product kind. A renderer/GPU helper shares the product token, but
  `classify_browser` still derives the `Helper` role from the name and
  arguments and endpoint admission refuses that role, exactly as it does
  for Chrome's helpers. Linux and Windows are untouched.
- Effect: `browser_prepare` with the pid of a running Helium, `allow_launch:
true` and `profile.mode=isolated_new` passes the classification gate and
  launches a driver-owned hidden isolated instance of the same Helium
  executable with `--remote-debugging-port=0`; bind, navigate, snapshot and
  the explicit `dom_event` text route then work over that endpoint. The
  user's browser process and profile are never touched.
- Live-verified (`.unlazy/synara-cu-codex-parity/L13-notebook.md`,
  `evidence/l13-helium/`): with the user's Helium running,
  `browser_prepare` on its pid returned `launched_isolated_browser` with the
  spawned Helium hidden and its window proven offscreen at (-32000,-32000)
  through CDP; bind minted an exact `driver_owned` target, navigate reached a
  local page, the snapshot exposed the input ref, and `browser_type`
  (`input_route:"dom_event"`) dispatched 13/13 characters with a matched
  read-back (`effect:"unverifiable"`, the honest synthetic-route verdict).
  The frontmost app never became the spawned instance, every Helium process
  present before the run stayed alive, and `end_session` reaped the spawned
  process group and its isolated profile.

Revision 30 makes every driver-owned launch windowless by default and deletes
the hide/offscreen machinery it needed.

- Headless default: `browser_prepare` with `allow_launch=true` and an
  isolated profile now launches the Chromium-family browser with
  `--headless=new` (plus `--hide-scrollbars` and `--mute-audio`). The
  spawn creates no native window and no Dock entry, so there is nothing to
  conceal, re-hide, or move offscreen. A single explicit opt-in,
  `windowed: true`, keeps the pre-existing visible-browser launch; that
  route creates a normal window at Chromium's default position and says so
  in its result — it is not hidden, moved, or dressed.
- Deleted for every launch we perform: the macOS process-lifetime
  concealment watcher (`platform-macos/src/browser/conceal.rs`, the
  `conceal_spawned_browser` platform hook, and the re-hide pass inside
  `visualize_browser_action`), the `--window-position=-32000,-32000`
  switch, and the `Browser.setWindowBounds`/`getWindowBounds` offscreen
  write-back. Nothing we start hides, moves, or dresses a window any
  more.
- Bind without a window: `get_browser_state` accepts `pid` alone for a
  driver-owned headless browser and mints `target_id`/`tab_id` from the
  CDP endpoint directly (fingerprint + attested endpoint ownership + live
  page targets). `window_id` stays required for every native-window bind,
  and the existing-profile attach path keeps its exact window anchor and
  approval contract unchanged. Windowless capabilities revalidate
  process identity, endpoint ownership, and CDP target liveness; the
  trusted CDP input route is allowed because a headless browser has no
  window a dispatch could raise, and the on-screen agent-cursor overlay
  is skipped because there is no surface to draw on. Screenshots stay on
  `Page.captureScreenshot` for both routes.
- General-app launches (`launch_app`) never activate and never hide, move,
  or conceal windows of their own; a visible launch states in its result
  that it creates the app's window and Dock entry and is an explicitly
  requested visible action.
- Live-verified (`.unlazy/synara-cu-codex-parity/L21-notebook.md`,
  `evidence/l21-headless/`): a driver-owned isolated headless launch (pid-free
  system Chrome and a Helium-backed launch) registers only a
  `BackgroundOnly` LaunchServices entry — no Dock tile, no menu bar — keeps
  the prior frontmost app unchanged, and exposes no on-screen window:
  `list_windows` reports every spawned-pid window with `is_on_screen=false`,
  no Space membership, and `CGWindowListCopyWindowInfo` agrees. macOS
  Chrome's new-headless still creates off-Space WindowServer helper windows
  for a live page (five under Chrome 153, one under Helium); they are never
  on screen, on a Space, or activated. Bind → navigate → snapshot → trusted
  type → trusted click → screenshot all succeed over CDP; `end_session`
  reaps the process group and isolated profile with no leak across repeated
  prepare/close cycles, and the user's running Helium is untouched.

Revision 31 makes one browser snapshot readable, and keeps a live binding
alive across transient session death.

- Refs inline: the `semantic_v2` outline renders each listed ref with its
  role and name (`- link p14:12 "GIGABYTE ... QUICK VIEW"`), so the outline
  alone is enough to pick a ref. Text-bearing roles move to a new bounded
  `text_digest` section (`- text p14:31 "$1,099.99"`), anonymous empty
  `generic` chains are dropped, and the outline is cut at ~10k characters
  with an honest marker. The `refs`/`content_refs` arrays stay as a compact
  index (ref, role, name, frame, actions; `value`/`visibility` only when
  they carry information) instead of restating per-node state.
- Text that the AX tree prunes: on name-from-content pages (product grids
  where the whole card becomes the link's accessible name) Chrome's
  accessibility tree drops the child static text. The snapshot now reads
  text runs from the `DOMSnapshot` capture it already takes, keeps the
  visible ones (own or nearest ancestor bounds), deduplicates against
  accessible names, and lists the top runs in the digest with content refs —
  so prices surface consistently instead of collapsing to zero content
  refs across snapshots of the same page.
- Transparent rebinding: a target that is missing from its session namespace
  is re-resolved inside the same call. The driver records the bind's
  re-proof inputs (pid, window, windowless route, tab ids with their CDP
  page targets); reinstatement re-runs the full proof chain — lifecycle
  ownership, process fingerprint, endpoint ownership, and live CDP page
  targets — and keeps the caller's `target_id` and `tab_id`s. Only
  driver-owned browsers are reinstated implicitly; a user-profile window
  still needs an explicit consent-bound bind, and a genuinely gone process
  or closed tab keeps the original structured refusal.
- AX retry: `Accessibility.getFullAXTree` failures from the transient
  `-32602` frame-id churn ("Frame with the given frameId is not found") are
  retried internally twice with a short backoff instead of surfacing as a
  `browser_route_unavailable` refusal.
- Live-verified (`.unlazy/synara-cu-codex-parity/L22-notebook.md`,
  `evidence/l22-snapshot/`): a deterministic local product-list fixture in a
  driver-owned headless browser yields names and prices in one snapshot, an
  inline outline ref clicks successfully, and a binding whose session
  namespace was dropped reinstates without a `get_browser_state` round-trip.

Revision 34 addresses the September 20 live-test report's native focus and
observability failures.

- A plain coordinate click can use an exact-window AX hit-test before selecting
  the pixel transport. Only an advertised `AXPress` is attempted; ancestry must
  match the requested window, reflex activation is suppressed, and an attempted
  AX failure never falls through to another actuator. Chromium detection selects
  the pixel recipe independently of whether the caller forced synthetic input.
- A raw background left click still briefly borrows keyboard focus when its
  target is not already the user's exact key window. It now captures and proves
  the prior PID, key-window ID, WindowServer focus and Space before activation.
  An unobservable restoration target refuses the click before activation. The
  activation, click and RAII restoration run on the same blocking worker, so
  cancellation of an async waiter cannot restore ahead of a detached click.
  Cleanup restores the exact native key window without re-entering a cancelled
  input gate, leaves observed unexpected focus/Space changes untouched, and
  reports failed or unobservable restoration instead of swallowing it. Snapshot
  comparisons cannot identify whether the user or the action caused a change;
  an unexpected target-owned window or sheet reports uncertain restoration. This reduces
  focus disruption; it does not make synthetic clicks safe for uninterrupted
  simultaneous physical typing. Capture and cleanup each have a 200 ms budget;
  app and window AX reads use at most 25 ms messaging timeouts and reject late
  results. Direct WindowServer/Space samples bracket each AX read, and a final
  direct sample immediately precedes restoration so stale AX responses cannot
  authorize a write after an observed focus switch.
- Click and wheel results carry static actuator, delivery, focus and restoration
  metadata. AX failures preserve their numeric AXError in the structured result,
  alongside a fixed error code. Diagnostics never include titles, text or AX
  content; the host separately allowlists fields before writing them to logs.
- `get_agent_cursor_state` adds `overlay_ready`, `render_visible` and
  `overlay_scope: "main_display"`. Readiness means an AppKit overlay exists;
  render visibility describes logical render state, not proof of pixels on the
  target's display. Overlay initialization failures emit static diagnostic codes.
  The overlay already had `CanJoinAllSpaces`, `FullScreenAuxiliary` and
  `Stationary` collection behavior upstream. Secondary-display rendering remains
  unqualified: the single overlay covers `NSScreen.mainScreen.frame`.
  Synara now keeps the cursor parked through model turns, hides it at turn end,
  and uses a 60-second idle expiry as a backstop. A parked compact cursor does
  not request frame ticks; only a pending glide, pulse or fade does.

Revision 34 verification on Linux with Rust 1.97.1 includes the pure exact-focus
restoration policy, compact cursor tests (including parked visibility and the
60-second expiry), and the unchanged background-input admission tests. Apple
architecture Rust metadata checking, including macOS test sources, also passes
with the ScreenCaptureKit documentation build mode and host C compilation; this
is source typechecking only and cannot produce or qualify a macOS executable.
The normal Apple build requires the Apple SDK, and exact focus restoration,
continuous typing, Spaces and display painting still require native qualification.
Both patches are regenerated against the pinned source; the Linux follow-on
patch changes only revision context, preserving its existing browser-only scope.

The report follow-up and remaining native qualification work are recorded in
[`live-report-followup-2026-09-20.md`](../../../../docs/computer-use-cua/live-report-followup-2026-09-20.md).

Current integration verification and limits are recorded in
[`integration-refresh.md`](../../../../docs/computer-use-cua/integration-refresh.md).
[`qualification.md`](../../../../docs/computer-use-cua/qualification.md) records
the historical revision 1 GUI qualification. Revision 2 compilation, pure tests
and control-plane checks do not establish a fresh GUI or RAM qualification.

### Revision 35: background delivery and report recovery

Background clicks no longer use real activation and take/restore. Chromium
clicks omit the off-target primer that could dismiss popups. Observation stops
arming wildcard focus restoration; the reactive guard yields to recent HID
input or closed admission. Exact-window Enter prefers advertised AXConfirm;
otherwise native keyboard ambiguity remains guarded. Known background popup
presses refuse before dispatch. No synthetic activation-belief protocol ships.

See [the report follow-up](../../../../docs/computer-use-cua/live-report-followup-2026-09-20.md)
for coverage and outstanding live Chromium acceptance criteria.

### Revision 36: usable background windows and input

Normal macOS launches now request `activates=false` without hiding the app.
Plain launches reuse existing processes without a reopen event; restoring a
hidden app reuses the existing verified `AXHidden` implementation. Launch no
longer activates a saved foreground application or starts a delayed restore
watchdog. Window readiness shares the bounded launch budget, and unavailable
windows keep their concrete reason through the server response.

An exact background key can target an app's positively identified keyboard
window even when sibling windows exist. The native path verifies
`AXFocusedWindow` and the addressed field's ancestry/focus immediately before
each key-down. An inactive app may omit its app-level focused element; that
absence does not override a positive exact-window proof. A contradictory
window or field still refuses. This does not make arbitrary sibling windows
valid recipients of process-scoped keys or change generic typing admission.
Unmodified Return uses the application-scoped Accessibility keyboard API,
selected before dispatch. Key-up is paired on success, failure and cancellation;
an unconfirmed release fences native cleanup. There is no fallback or replay
through another event queue after an AX attempt.

Wheel input uses one public PID event submission, without activating the app.
Signed single-axis scrolls can also use the existing exact AX scroll route.
Neither an uncertain AX action nor a posted event is replayed through another
transport. The cursor panel cannot become the key or main window, and reactive
focus guards retire their saved destination after human input instead of
restoring it later.

The matching host changes reuse AppSnap's permission checks and grant events.
Fresh confirmation bypasses cached results, partial/failed checks cannot keep
stale granted badges, and dismissed setup sessions cannot reopen a guide.
Foreground authorization is checked before claiming desktop control or
starting a driver. See the report follow-up for live evidence and limits.

### Revision 37: exact modal controls and observed keyboard focus

Ordinary sheets and dialogs no longer become `auth_sheet_focused` merely because
of their accessibility role. Admission retains the current modal's identity for
that action. A semantic actuator must freshly prove that its exact element is
inside that modal; controls behind it refuse with `modal_target_mismatch` before
dispatch. Raw events still require the modal's own distinct window, so a sheet
sharing its parent's window id cannot admit clicks behind the sheet. The same
checks cover semantic value/selection writes and element-addressed AX Return;
owned key releases still run unconditionally. Authentication processes and
secure focused fields retain the separate protected-input refusal, and the
host's protected-app and secure-input policies remain in force.

`list_windows` can return optional `keyboard_focused` metadata from the app's
observed `AXFocusedWindow`, independently of Synara's selected target. This is
opt-in through `include_keyboard_focus`; ordinary geometry revalidation performs
no Accessibility focus reads or blocking-worker dispatch. Explicit observations
coalesce reads per PID and bound them across each request. A missing or unmapped
identity stays absent, not false; metadata does not bypass the fresh window/field
proof at key dispatch. This revision does not broaden generic hotkey delivery or
prove that a never-activated application supplies a usable keyboard destination.

`set_value` also accepts `append:true` with an exact retained `element_token`.
It reads that element's current text, composes the appended value, and submits
one AX write under the existing semantic lease and cancellation gate. It never
refreshes the snapshot or rematches a control. Nontext, secure, unreadable, and
unwritable targets refuse, as does combined text exceeding 16,384 UTF-16 code
units. Existing replacement behavior and web-content readback distrust remain.

The adapter fixes accompanying this revision preserve exact refs for key tools,
correct the macOS signed-wheel direction, and retain launch focus observations.
Pure native policy and cancellation checks do not qualify Resolve dialogs,
Helium browser chrome, or another machine's permission state; those still need
an application-specific trace and observed outcome.

### Revision 38: atomic text into the target window's own focused element

`type_text` without an element refused with `same_pid_keyboard_ambiguity`
whenever the application owned a sibling top-level window, before its AX rung
could run. Notes always owns one, so every sentence degraded to one
`press_key` call per character. That refusal protects against process-scoped
key events reaching a sibling; the AX rung posts none. It writes
`AXSelectedText` into `focused_element_in_window(pid, window_id)`, an element
proven to belong to the exact target window.

When `InsertText` is refused for that reason, semantic AX admission still
executes, and the target window has its own focused element, the policy is now
`SemanticFocused`: one atomic `AXSelectedText` write with AX read-back, under
the existing process mutation lease and cancellation gate. The CGEvent rung
stays refused with the original refusal, so a write that does not land returns
`same_pid_keyboard_ambiguity` exactly as before and nothing is retried. Explicit
`semantic_only` requests keep their character-paced exact-element contract, and
hotkeys (including paste) are unchanged. Not qualified: web-content fields,
where `AXValue` read-back is not renderer evidence.
