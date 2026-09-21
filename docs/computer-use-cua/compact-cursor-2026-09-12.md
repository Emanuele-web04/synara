# Compact Computer cursor

The running `Codex Computer Use.app` bundle was inspected read-only at version `26.902.1000968` (build `1000968`). Its `Package_ComputerUse.bundle/Contents/Resources/Assets.car` contains `SoftwareCursor`, a 200 × 230 black arrow with a white outline and a floppy-disk badge. The executable also contains `FogCursorStyle` backed by `NSHostingView<ComputerUse.CursorView>`, with spring/stretch/rotation state. That SwiftUI view is compiled code, not an exportable cursor image.

Synara now uses a small vector adaptation of the reference arrow, without the disk badge. It is not a pixel-identical port of the compiled Fog cursor. The new path is cached once and drawn at Retina scale, at the exact input hotspot. The session label remains available as static feedback. There is no per-action shape change, rotation, bounce or focus-box flash.

## Input and rendering

The GUI host starts native revision 5 with `--compact-cursor --idle-hide-ms 900`. Cursor placement is queued without waiting for a renderer arrival signal. Native targeting, activation restoration, input cleanup and cancellation are unchanged. Compact movement and click feedback never create a travel path, spring or click pulse; a held button changes only the pointer fill.

A stationary compact cursor does not request frame-cadence repaints or hardware-pointer hover polling. The render worker waits on its command channel until the next input or the 900 ms hide deadline. Each cursor tracks its own monotonic deadline, so another session's activity cannot keep it visible indefinitely. Session removal retains the existing tombstone guard against late commands resurrecting a cursor. This is a render-loop change, not a measured system-wide CPU or RAM percentage.

The profile is native host configuration and adds no provider tools, prompt instructions or screenshots. The earlier context-size and click-dispatch improvements remain in place. Robert's capture-cache changes are still recommendations; they are not included in this cursor change.

## Verification

- Three compact cursor tests passed: exact hotspot without travel/pulse, stable rendering across action/heading/time, and hidden/disabled rendering. The generated 2× raster was visually inspected.
- Eighteen macOS overlay tests passed, including independent sessions, removal/tombstones, frame-mailbox bounds and compact idle deadlines. Thirty-one additional focused native checks passed for cancellation, exact targets, AX delivery/no replay, foreground observation and existing cursor timing.
- Twenty-five desktop host tests passed, now checking the launch profile as well as generation lifecycle and the observation budget.
- Scoped formatting and lint passed (one existing lint warning); desktop typecheck, fixture typecheck and desktop build passed. The earlier full workspace verification is recorded in the Calculator optimization report.
- Both native architectures built and the universal artifact passed identity/checksum provisioning. Dev's running command line was checked for `--compact-cursor --idle-hide-ms 900`. The app's signed launcher was not replaced.
- The checked-in patch reconstructs the native source exactly. Intel execution and full-desktop cursor compositing were not independently recorded. The raster check is a renderer artifact; Calculator's captured window image excludes the cursor overlay.

## Calculator smoke test

Same prompt, fresh Synara Dev chat, GPT-5.6 Sol / Medium / Fast, Calculator already running. The result `5.535` was verified in the returned window image.

| Metric                      | Prior revision 4 sample | Compact revision 5 sample |
| --------------------------- | ----------------------: | ------------------------: |
| Eight-click script          |                 5.937 s |                   5.159 s |
| Full provider turn          |                30.725 s |                  26.576 s |
| Model requests              |                       8 |                         8 |
| Input tokens                |                 215,750 |                   219,677 |
| Cached input                |                 195,840 |                   188,160 |
| Uncached input              |                  19,910 |                    31,517 |
| Output (includes reasoning) |                     715 |                       681 |
| Processed tokens            |                 216,465 |                   220,358 |

The click script was 13.1% shorter in this single run. Its final click included a screenshot, and the model then requested another state read, so the execution sequence is not identical. Full-turn timing includes model/network work. These observations do not establish a repeatable speedup or a token saving: this sample used more uncached tokens. Cursor rendering itself makes no model calls.

Evidence: [sample](evidence/compact-cursor-2026-09-12.json), [rendered pointer](evidence/compact-cursor-preview.png). App thread `a73afe27-c06d-4a48-b89f-dc1720ee8610`; provider session `01a092bc-9397-7252-b150-6c022c359d71`.
