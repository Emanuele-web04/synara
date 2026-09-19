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

Current integration verification and limits are recorded in
[`integration-refresh.md`](../../../../docs/computer-use-cua/integration-refresh.md).
[`qualification.md`](../../../../docs/computer-use-cua/qualification.md) records
the historical revision 1 GUI qualification. Revision 2 compilation, pure tests
and control-plane checks do not establish a fresh GUI or RAM qualification.
