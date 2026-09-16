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

Current integration verification and limits are recorded in
[`integration-refresh.md`](../../../../docs/computer-use-cua/integration-refresh.md).
[`qualification.md`](../../../../docs/computer-use-cua/qualification.md) records
the historical revision 1 GUI qualification. Revision 2 compilation, pure tests
and control-plane checks do not establish a fresh GUI or RAM qualification.
