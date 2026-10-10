# Follow-up to the September 20 native Computer live report

The [revision 36 follow-up](#september-21-round-2-report-revision-36) below
supersedes the earlier launch and multi-window keyboard limitations described
in this historical record.

The reported build was PR #1090 at `365fe29fe`, native revision 33. Before
these changes, `git rebase --rebase-merges origin/main` completed against
`e7cd1528`. Main was already an ancestor; both the PR head and its tree were
unchanged. No main commits or previous merge resolutions were discarded.

## Corrections

| Report finding                                      | Change                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A completed turn holds the desktop for five minutes | The existing provider runtime ingestion releases the lease on terminal turn/session events. In-flight operations drain first. Turn identity protects a newer turn from late events; ambiguous untagged completions cannot release it. The idle timeout remains a crash fallback.                                                                  |
| Refused retries trigger the uncertain-action limit  | Only dispatched, unverified mutations contribute. A refusal also cannot erase previous uncertain delivery. A failed first step in a batch preserves its explicit uncertainty.                                                                                                                                                                     |
| Background coordinate clicks always skip AX         | Revision 34 permits the advertised, focus-suppressed AXPress route for an unmodified single left click. Modified, multiple and right clicks retain their required input recipe. Older/unknown native revisions retain the previous routing. No submitted AX action is replayed as a pixel click.                                                  |
| Pixel activation loses the user's key window        | The native guard captures the exact prior PID/window and WindowServer state before deliberate activation, restores that exact window on success/error/unwind, and records the result. Unobservable prior state refuses activation. Unexpected focus changes stop restoration; ambiguous target-owned window changes are reported as unobservable. |
| Keys on multi-window apps keep failing              | The ambiguity refusal remains: process-scoped keys cannot establish an exact destination. Guidance now points to observed elements with exact-window semantic typing, or set-value when replacement is intended. These writes do not promise keydown/keyup behavior.                                                                              |
| Menu invocation silently uses the foreground        | Standalone and batched menu invocation require the same explicit visible-use authorization as foreground actions. Explicit background menu mode refuses. Space confinement still applies.                                                                                                                                                         |
| Cursor is rarely visible                            | The compact marker stays parked between actions for up to 60 seconds, and task completion hides it. Idle waiting does not repaint continuously. Failed visibility updates can retry; metadata remains bounded. Cursor sessions and retained AX references survive hiding.                                                                         |
| Scroll dispatch produces no visible movement        | Existing measured scroll/screenshot evidence now immediately identifies no visible movement. It does not assert that the page is at its edge: dropped delivery is another possibility. Dispatch without evidence remains uncertain and must not be blindly replayed.                                                                              |
| Action failures lack diagnostic detail              | Allowlisted native actuator/path/focus/restore/error metadata reaches desktop logs and failed-action audit entries. Numeric AX errors survive. Raw driver messages, field values, window titles and cursor labels are excluded from the new records.                                                                                              |

The restore guard compares observable window, process and Space state; these
snapshots cannot prove whether the user or the target app caused a change. A
new target-owned sheet can therefore leave restoration uncertain. The existing
AX focus-suppression observer also has no complete physical-input provenance.
This is a narrower repair to restoration, not a guarantee of focus isolation.

The lease is still global for shared pointer and physical keyboard actions.
This change does not create independent desktop seats. Exact-window semantic
typing remains the separately admitted concurrent path; set-value and other
mutations remain serialized.

## Diagnostic interpretation

- `computer_action` records task identity, tool, numeric target identity,
  elapsed time, delivery effect and available native diagnostics. A missing
  diagnostic field means it was not observed; it is not a successful restore.
- Lease acquire/release/deferred-release/stale-reclaim records are lifecycle
  logs, not extra fabricated tool calls in `computer-audit.jsonl`.
- Cursor state is read after session creation/first action, without periodic
  polling. `overlay_ready` and `render_visible` describe native logical state;
  neither proves that the user saw pixels on the intended display.
- Known static cursor initialization and unwind restoration failures are
  surfaced immediately from native stderr. The new event stream does not
  copy arbitrary stderr or native content.
- The canonical pause code is `computer_input_paused`, with a source layer.
  The backend accepts the old `desktop_input_paused` spelling for compatibility.

The original report's hypothesis that the overlay lacks All Spaces collection
behavior was not confirmed: the pinned upstream overlay already sets
`CanJoinAllSpaces`, `FullScreenAuxiliary` and `Stationary`. It still uses a
single main-display overlay. Secondary-display visibility and actual painting
across Spaces require live reproduction; this change does not claim to fix them.

## Verification boundaries

Local formatting, lint, seven-package typecheck and Windows runtime-boundary
checks pass. The eight affected server suites pass all 686 tests. The broader
`bun run test --continue` run records 14,286 passing tests, 144 failures from
denied local Unix socket listeners, and one suite that cannot load the missing
Electron runtime. These environment failures are not a passing full-suite gate.
The shared package passes all 835 tests after repairing two pre-existing
`list_spaces` inventory expectations. Turborepo checks use its documented
`TURBO_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` opt-out.

Regression coverage includes terminal-event races, in-flight and queued lease
release, uncertain-action accounting, menu authorization, old-driver routing,
diagnostic privacy, cursor lifetime/retries and native restoration decisions.
The `Cua native checks` workflow compiles native macOS tests and runs focus,
compact-cursor and real host IPC regressions on macOS. It does not grant TCC
permissions or drive a user's desktop.

The editing environment is Linux and refuses local Unix socket listeners with
`EPERM`, so host IPC tests cannot execute here. Portable native tests and an
Apple-target Rust metadata check do not qualify a runnable macOS build or GUI
behavior. Final live acceptance still requires the following:

1. Background clicks while continuously typing in a different foreground app;
   verify both characters and exact key-window restoration. Pixel input can
   still cause a brief focus transition; restoration is not focus isolation.
2. Start a second task immediately after the first task ends, and repeat while
   the first task still has native input in flight.
3. Exact-element semantic typing into two distinct windows, including siblings
   of the same Chromium process; separately test field event behavior.
4. Cursor visibility on the current Space, other Spaces and secondary displays,
   and removal on completion, cancellation and failed cosmetic cleanup.
5. Native wheel scrolling where the prior report observed no movement; inspect
   delivery evidence and recovery without treating dispatch as success.

Escape takeover, approval boundaries, Space confinement and uncertain-action
refusals remain active throughout these tests.

## Linux verification on September 21

[The Linux CI run passed](https://github.com/Emanuele-web04/synara/actions/runs/35548988491)
on Ubuntu 24.04 x64, using the pinned revision 34 source and both checked
native/Linux patches. It compiled the Linux driver and cursor helper with
Rust 1.97.1 and passed 741 regression tests: 175 desktop admission/host/Escape,
40 shared protocol/diagnostic, 301 server lifecycle/browser/backend, 202 native
browser and 23 compact-cursor tests.

The new `Cua Linux checks` workflow also runs the actual Electron host and
compiled driver on a disposable Xvfb X11 desktop with a root-managed Chrome
installation. Its isolated headless browser launched, bound and navigated to
a local fixture. Fresh semantic references drove a click and text insertion;
independent HTTP events from the page confirmed both effects. Native pointer
input and visible browser launch were refused. An X11-injected Escape reached
the Electron global shortcut and paused the following mutation. Task completion
unregistered Escape, and host disposal terminated the observed browser process.
Both `LINUX_SMOKE_OK` and `LINUX_SMOKE_CLEANUP_OK` were emitted.

The initial probe runs exposed test-fixture issues: hosted runner Chrome files
and their `/opt` ancestors were writable by other users, which the driver
correctly rejected, and the probe initially requested compatibility DOM refs
while expecting semantic names. The workflow now installs the official Chrome
package with root-managed permissions and explicitly requests `semantic_v2`.
No production admission rule was relaxed to make the probe pass.

This is component-level evidence with a debug driver build, not a packaged
AppImage or live-provider qualification. Escape was injected through X11, not
pressed on physical hardware. Wayland/XWayland refusal is covered by admission
tests, not a live compositor run. Linux mutations remain limited to the
attested isolated headless browser route on direct X11; this does not enable
native desktop pointer/keyboard control or personal browser profiles.

## September 21 report: revision 35 follow-up

Baseline: `3e2dd523`, native revision 34. Original Helium logs/captures were not
present on this machine; Helium is not installed here. Report success-rate
thresholds are acceptance targets, not measurements from this follow-up.

| Report item       | Implemented behavior and qualification                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1: focus theft   | Remove deliberate activation and take/restore from background pixel clicks. Only explicit foreground delivery can take focus. Older-driver `focus_restore_failed` still fences subsequent input and queued observations without permitting replay. Apps can still self-activate; coexistence needs live qualification.                                                                     |
| F2: dead launch   | Preserve launched PID; bind only an unambiguous usable window after native readiness. Report `no_usable_window` with reason. Bound the read-only readiness phase to two seconds, including hung reads. Stop batches even with `continue_on_error`; never relaunch automatically or replace the requested browser/profile. This is not a five-second total OS launch/IPC bound.             |
| F3: pause latch   | Fresh model observation of an on-screen/current-Space, non-degraded same-PID sibling with usable AX content clears the task's gate. Other apps/tasks/previews cannot clear it. Return bounded `wait_seconds` and requery guidance. Waiting alone never resumes input.                                                                                                                      |
| F4: scroll        | Keep pixel wheel delivery and calibrated post-scroll capture. Add `scroll_noop` with measured delta, movement/unknown observations, and persisted numeric evidence. Repeated unchanged scrolls stay bounded. Unchanged pixels do not prove dropped delivery or an edge; Chromium wheel acceptance remains to be measured.                                                                  |
| F5: popup         | Remove the off-target Chromium primer click and its 100 ms gap, which could dismiss suggestions. Observation no longer arms wildcard focus restoration. These remove concrete interference sources, not independent popup disappearance; use fresh semantic refs.                                                                                                                          |
| F6: keys          | Exact-window Enter first tries advertised AXConfirm on the exact focused element under ancestry/cancellation guards. No shortcut translation, guessed default button, or key fallback after submitted AX input. Retain native `same_pid_keyboard_ambiguity` when no safe route exists: a window ID does not make PID-posted keys window-scoped. Some omniboxes do not advertise AXConfirm. |
| F7: selects       | Known AXPopUpButton background presses refuse before dispatch with `background_popup_unavailable`, including hit-testing. Use exact-control set_value or explicitly authorized visible use. Unidentified pixel-only controls remain uncertain.                                                                                                                                             |
| F8: user input    | Preserve Escape/Stop epochs and listen-only monitors. Reactive restoration yields to recent HID input and closed admission. No event-consuming tap added.                                                                                                                                                                                                                                  |
| F9: menus         | Preserve explicit visible-use authorization.                                                                                                                                                                                                                                                                                                                                               |
| F10: verification | Fix audit/repeat-prevention losing verified delivery and window identity when a result contains an image. Decode existing JSON and persist allowlisted observation evidence/scroll delta. Fresh or unchanged frames never prove an arbitrary click's intended outcome.                                                                                                                     |
| P2-8: staleness   | Existing semantic targeting reads fresh state. Reject duplicate fresh field matches instead of selecting the first. Add re-observation guidance for stale token/geometry failures. Automatic label-based substitution/replay is intentionally excluded because it can select a replacement or underlying control.                                                                          |
| P3-10: timings    | With `SYNARA_CUA_TIMING_LOG=1`, record per-turn first observation/write and observe-to-write call start/end. Label provider-start versus first-computer-call origin. Bounded state, terminal cleanup, no screen data, additional captures or model tokens. Opaque batches retain existing per-call timings, without invented first-write timestamps.                                       |

### Mechanism and release boundaries

Synthetic activation notifications are not enabled: the prior belief canary's
baseline semantic write already passed without priming. Removing deliberate
activation is the immediate repair; applications that reject background events
must report uncertain delivery rather than silently take the user's focus.
This does not establish that every Chromium click/scroll/omnibox flow works.

Both patches and native metadata identify revision 35. Linux keeps its
browser-only scope. An existing revision-34 app needs a native artifact and app
rebuild through the existing provisioning workflow; pulling TypeScript alone
does not update its native binary.

No TCC reset, production state change, signed-app replacement, or user-profile
browser automation was performed. Live Helium focus, 50-action coexistence,
20-scroll/20-popup success rates and token/RAM improvements remain unmeasured.
Do not describe this as live acceptance of every report criterion.

### Revision 35 validation

- Pinned-source patch application and both SHA-256 checksums verified; compiled
  macOS sources match the regenerated patch exactly. Linux follow-on patch
  still applies in order.
- Native `cargo check -p platform-macos --tests`, driver binary build and all
  10 `focus_restore_policy` tests passed with pinned Rust 1.97.1.
- The built revision-35 driver passed all 12 control-plane smoke cases:
  identity, caller/generation authentication, interruption, stale buffered
  input refusal, repeated cancellation and retirement. No real app received
  input; the single input envelope used an impossible target and stale epoch.
- Workspace typecheck passed for all seven packages. Formatting, Windows runtime
  boundary check and lint passed (724 existing warnings, zero errors).
- Final full `bun run test --continue` under Node 24.19: seven workspace tasks
  succeeded, 14,478 tests passed, 30 skipped, no failures (5m20s). Breakdown:
  contracts 256; shared 836; scripts 231; web 5,179; desktop 1,163;
  server/CLI 6,813. This replaces the earlier intermediate Node-26 run; it
  does not substitute for the live Helium acceptance tests above.

## September 21 round-2 report: revision 36

Baseline: `cf4e5f81`, native revision 35. The second report confirms that the
permanent key-window lock is fixed, but documents remaining focus excursions,
hidden launches, stale permission status, dropped scrolling and blocked Return.

### Launch, focus and cancellation

- A normal macOS launch now requests no activation and leaves the app unhidden.
  `hidden:true` is an explicit visibility choice, not a synonym for background
  delivery. It no longer takes a foreground permission check just to create a
  usable window.
- A plain launch reuses a running PID and its windows without sending another
  reopen event. A hidden instance uses the existing verified `AXHidden` helper,
  shared with explicit visibility controls. Failed visibility writes preserve
  the known running process and report actual readiness; they never kill or
  relaunch it.
- Launch no longer arms a restore lease, demotes a window repeatedly, opens
  Finder through an activating selection API, or starts an eight-second
  restore watchdog. Reactive AX guards retire their saved destination after
  human input, cancellation or a newer foreground change. The cursor panel
  explicitly rejects becoming the key or main window.
- Both LaunchServices entry points and the shared `AXHidden` write recheck
  native admission at dispatch. A submitted visibility write retains uncertain
  delivery if Stop interrupts its readback; it is never replayed.
- Refused foreground calls are checked inside the action queue before claiming
  the desktop lease, warming a driver or preparing the cursor. A direct
  affirmative answer to a visibility question is accepted; quoted content and
  general task confirmations cannot authorize foreground use.
- Native launch and window readiness share a five-second polling budget.
  Missing, hidden or off-Space windows preserve `no_usable_window` and the
  concrete reason through the server, without another futile readiness loop.
  Synchronous macOS calls are not preemptible; this is not a hard wall-clock
  guarantee for every OS failure.

### Permissions, scrolling and tool discovery

Computer continues to use AppSnap's permission helper and setup guide. An
AppSnap grant event invalidates an already-requested Computer status while
System Settings owns focus. Explicit refresh and confirmation checks bypass
stale snapshots; concurrent/subset checks share work. Only complete successful
reports update grants, failures clear stale green status to unknown, and setup
generations prevent dismissed guides from reopening. Driver warm-up waits for
known grants instead of caching the pre-grant state. An unused Computer feature
remains inactive.

Chromium wheel input now uses one public PID submission. Signed, unmodified
single-axis requests can also use the existing exact AX scroll route; an
attempted semantic mutation never falls through to a second actuator. Page
scrolls do not silently degrade into line increments. The gateway accepts a
vertical-only or horizontal-only delta and rejects a zero gesture before
dispatch. Existing post-scroll evidence and no-replay behavior remain intact.

`computer_help` reads the actual registered browser catalog, including
`computer_browser_prepare`. `list_spaces` has an explicit read-only risk
classification. Browser actions explain and require a bound CDP `target_id`
before dispatch, rather than accepting incompatible native PID/window fields.
They do not silently replace the user's browser or profile.

### Background Return

Exact keyboard admission now accepts a multi-window app when its
`AXFocusedWindow` positively matches the requested window. An explicitly
addressed field must also retain matching ancestry and focus. Inactive Chromium
may omit the application-level focused element; the exact window/field proof
handles that absence without accepting a contradictory sibling. Fresh browsers
with no known keyboard window still refuse instead of guessing a recipient.

Unmodified Return uses `AXUIElementPostKeyboardEvent` on the target application's
AX object. The native guard checks the recipient immediately before dispatch.
Matching key-up runs on success, cancellation, failure and unwind; failed release
blocks a false cleanup acknowledgement. This route is selected before dispatch,
not replayed after another attempted actuator. Other keys retain their existing
transport. The unsuccessful private/public CGEvent and NSEvent Return experiments
are excluded from the implementation.

### Measured native evidence

- The production driver delivered exactly **one Return key-down/up, one DOM
  Enter and one form submission** to window A in **1.165 s**; window B remained
  unchanged. None of the **224** focus samples showed target or driver
  activation. The first 185 retained the sentinel exactly; a subsequent human
  focus change stopped further input. The unchanged sibling-refusal guard
  passed in the preceding controlled run. Setup explicitly activated owned
  fixtures before background measurement; cold, never-activated windows and
  real browser omniboxes are outside this acceptance result.
- Owned two-window Electron fixture: nested scroll and document scroll both
  moved **360 px**, the sibling remained unchanged, and all **258** controlled
  focus samples retained the sentinel's exact PID/key-window identity.
- Owned AppKit launch fixture: cold launch **1.089 s**, same-instance reuse
  **0.790 s**, unhide **0.821 s**, and URL handoff **0.689 s**. All five checks
  passed, including PID/window reuse and no reopen event. **684** passive focus
  samples included 8.5 seconds after the final call: no target or driver
  activation. The test never activated a sentinel or a user's application.
- The nonactivating cursor panel's native properties pass. A separate baseline
  versus revised-panel startup observation saw no theft in either variant;
  that experiment does not establish the cause of the report's startup event.

These are owned fixtures and a locally built arm64 driver. They do not qualify
Helium's omnibox/popups, every third-party app's self-activation behavior,
physical typing across 50 actions, packaged signing/TCC transitions, Linux GUI
behavior, all provider accounts or battery/token improvements. No new TCC grant,
reset or permission-database mutation was performed. Native revision 36 must
be provisioned and the app restarted; updating TypeScript alone cannot replace
an already running revision-35 driver.

### Revision 36 checks

- Workspace formatting, lint (zero errors), all seven package typechecks and
  the Windows runtime-boundary check pass.
- The broad Node 24 test run completed with 14,520 passing tests and 30 skipped.
  Its one failure was the Electron help text exceeding the existing 700-character
  budget by three characters. The text was shortened without raising the budget;
  all nine guidance tests then passed. The other suites were not rerun.
- The native arm64 driver compiles against the pinned Rust 1.97.1 toolchain.
  145 focused native tests cover authorization, exact keyboard admission,
  launch/reuse/cancellation, scroll, cursor and focus retirement. All 12 existing
  authenticated control-plane cancellation/retirement smoke cases pass.
- The native patch applies to the pinned source and reproduces the compiled
  source files exactly. The Linux follow-on patch applies after it, and both
  manifest SHA-256 values match. This verifies patch integrity, not Linux GUI
  qualification.
- Reusable owned-fixture runners are
  `scripts/computer-use-fixtures/verify-background-launch.mjs` and
  `scripts/computer-use-fixtures/background-input-regression.mjs`. The latter
  supports `--enter-only` and an explicit `--owned-sentinel` setup for a controlled
  focus measurement. Default observation does not activate a sentinel; a fresh
  browser with no proven keyboard window refuses input. These checks are manual
  native fixtures, not part of the normal unit test suite.
