# Follow-up to the September 20 native Computer live report

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
