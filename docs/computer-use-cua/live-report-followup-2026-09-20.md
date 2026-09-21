# Follow-up to the September 20 native Computer live report

The reported build was PR #1090 at `365fe29fe`, native revision 33. Before
these changes, `git rebase --rebase-merges origin/main` completed against
`e7cd1528`. Main was already an ancestor; both the PR head and its tree were
unchanged. No main commits or previous merge resolutions were discarded.

## Corrections

| Report finding                                      | Change                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A completed turn holds the desktop for five minutes | The existing provider runtime ingestion releases the lease on terminal turn/session events. In-flight operations drain first. Turn identity protects a newer turn from late events; ambiguous untagged completions cannot release it. The idle timeout remains a crash fallback.                 |
| Refused retries trigger the uncertain-action limit  | Only dispatched, unverified mutations contribute. A refusal also cannot erase previous uncertain delivery. A failed first step in a batch preserves its explicit uncertainty.                                                                                                                    |
| Background coordinate clicks always skip AX         | Revision 34 permits the advertised, focus-suppressed AXPress route for an unmodified single left click. Modified, multiple and right clicks retain their required input recipe. Older/unknown native revisions retain the previous routing. No submitted AX action is replayed as a pixel click. |
| Pixel activation loses the user's key window        | The native guard captures the exact prior PID/window and WindowServer state before deliberate activation, restores that exact window on success/error/unwind, and records the result. Unobservable prior state refuses activation. Observed human window/app/Space changes are preserved.        |
| Keys on multi-window apps keep failing              | The ambiguity refusal remains: process-scoped keys cannot establish an exact destination. Guidance now points to observed elements with exact-window semantic typing, or set-value when replacement is intended. These writes do not promise keydown/keyup behavior.                             |
| Menu invocation silently uses the foreground        | Standalone and batched menu invocation require the same explicit visible-use authorization as foreground actions. Explicit background menu mode refuses. Space confinement still applies.                                                                                                        |
| Cursor is rarely visible                            | The compact marker stays parked between actions for up to 60 seconds, and task completion hides it. Idle waiting does not repaint continuously. Failed visibility updates can retry; metadata remains bounded. Cursor sessions and retained AX references survive hiding.                        |
| Scroll dispatch produces no visible movement        | Existing measured scroll/screenshot evidence now immediately identifies no visible movement. It does not assert that the page is at its edge: dropped delivery is another possibility. Dispatch without evidence remains uncertain and must not be blindly replayed.                             |
| Action failures lack diagnostic detail              | Allowlisted native actuator/path/focus/restore/error metadata reaches desktop logs and failed-action audit entries. Numeric AX errors survive. Raw driver messages, field values, window titles and cursor labels are excluded from the new records.                                             |

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
