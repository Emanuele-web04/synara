# Calculator optimization and PR #1010 comparison

The follow-up [compact cursor change](compact-cursor-2026-09-12.md) replaces the revision 4 cursor configuration described below. Its separate benchmark and verification are recorded there.

## Implemented locally

- A single unmodified semantic click uses native AXPress only when the freshly observed control advertises that action and has a native element token. Unsupported controls, modifier clicks and multi-clicks retain synthetic input. There is no second actuator after an uncertain press.
- State inspection and target selection reuse their already enumerated windows. Actual input still performs a fresh exact-window lookup and native admission. Scoped state returns the requested window, not hundreds of unrelated windows.
- The GUI host sets cursor travel to 100 ms with zero post-click dwell once per driver generation. This reduces travel latency; it does not remove Cua's cursor artwork or repeated action animations.
- Native revision 4 bounds foreground post-action window observation to 100 ms. Background observation retains its original 1,000 ms budget. Host configuration uses an environment variable because the SDK strips private tool arguments. Tests exercise that sanitizer boundary. Activation restoration, cancellation, held-input release and target checks remain in place.
- Active guidance requests only the small tool set needed next, reuses window IDs, batches stable sequences, and avoids duplicate images. The full 21-tool serialized surface is 39,075 characters versus 46,883 before (16.7% smaller). This is a schema-size measurement, not a tokenizer or billing measurement.
- `computer_list_windows({app: "Calculator"})` limits model-visible window discovery to one app without silently picking between its windows. This fixes a measured path where Calculator's auxiliary windows made launch ambiguous and an unfiltered fallback emitted more than 11,000 tokens. No arguments preserves the existing full-window listing.

These changes do not add Computer tools or guidance to inactive sessions. Permission probing remains fresh; there is no persistent permission cache introduced to accelerate clicks.

## Live measurements

All three samples used a fresh Synara Dev chat, Codex GPT-5.6 Sol, medium reasoning and Fast/priority. The task was to open Calculator and compute `123 × 45`. Calculator was already running, so these are not cold-launch measurements. The correct displayed result, `5.535`, was verified from the returned images in both optimized samples.

| Metric                      | Before changes | Native fix, before app filter | Final code |
| --------------------------- | -------------: | ----------------------------: | ---------: |
| Provider turn               |       47.202 s |                      30.785 s |   30.725 s |
| Eight-click script          |       21.583 s |                       5.640 s |    5.937 s |
| Model requests              |              6 |                            10 |          8 |
| Processed tokens            |        255,587 |                       334,661 |    216,465 |
| Input tokens                |        254,933 |                       333,919 |    215,750 |
| Cached input                |        194,560 |                       314,496 |    195,840 |
| Uncached input              |         60,373 |                        19,423 |     19,910 |
| Output, including reasoning |            654 |                           742 |        715 |

The final sample's click batch is 72.5% shorter and the full provider turn 34.9% shorter than the new baseline. Processed tokens are 15.3% lower in these samples. Cache warmth and model choices vary: this does not establish a provider quota or monetary saving. In particular, the middle sample improved clicks while increasing aggregate tokens because it made more model requests and emitted the desktop window list. Both speed and context need measurement.

The final run's batch started 17.734 seconds into the provider turn; the baseline batch started after 22.096 seconds. These are tool-call admission timestamps, not physical mouse-down timestamps. Summed actual Computer call-script durations in the final run are 8.259 seconds; most remaining turn time lies outside those calls. A new native backend alone cannot remove model discovery and inference time.

The final sample uses eight foreground AX presses with intermediate screenshots disabled, followed by one final observation. The first optimized sample includes a screenshot on its final click. Consequently the two optimized batches are useful observed samples, not an identical controlled repeated-trial distribution. No p95 is inferred from them.

Earlier iterations also exposed two problems: background delivery still paid the full observer budget (about 12.1 seconds per batch), and a private foreground budget argument was removed by the SDK (about 12.6 seconds). The final host environment configuration fixes the latter. One malformed test prompt was cancelled before Calculator actions and is excluded. The [machine-readable record](evidence/calculator-optimization-2026-09-12.json) identifies each retained session/turn and its timing boundaries.

## Robert's PR #1010, exact head 5d0fdf14a3159be350fc7c3457e640a6bb3ee6f3

The [PR](https://github.com/Emanuele-web04/synara/pull/1010) uses its own Swift/AppKit helper, not the Cua native driver. It is stacked on the shared computer-control core in #822. Review was performed against the fetched exact head, not the PR description alone.

- **Click path:** its [Input.swift](https://github.com/Robertg761/synara/blob/5d0fdf14a3159be350fc7c3457e640a6bb3ee6f3/apps/server/native/computer-use-macos/Sources/Input.swift#L195) posts a targeted gesture, sleeps 1 ms between down/up, and can observe focus for up to 120 ms. It has conditional focus setup/restoration sleeps; it does not have Cua's universal one-second post-action detector. This supports a faster-path hypothesis relative to the old Cua integration, not a measured win against this updated branch.
- **Animation remains on the critical path:** [Cursor.swift](https://github.com/Robertg761/synara/blob/5d0fdf14a3159be350fc7c3457e640a6bb3ee6f3/apps/server/native/computer-use-macos/Sources/Cursor.swift#L382) waits for a spring cursor to arrive, capped at 450 ms. Covered/off-screen targets skip that wait. The source reports 83–100 ms for 30-point movements and 317–333 ms for 600-point movements, but those comments are not an independently reproduced benchmark here. It uses an arrow and badge rather than Cua's themed animation; it is still deliberately animated.
- **Capture work worth reusing:** [Capture.swift](https://github.com/Robertg761/synara/blob/5d0fdf14a3159be350fc7c3457e640a6bb3ee6f3/apps/server/native/computer-use-macos/Sources/Capture.swift#L583) hashes raw pixels before PNG/base64 for still previews, uses source-resolution limits, caches shareable content with generation invalidation, and overlaps bounded per-display captures. This can avoid encoding/transport work that downstream PNG deduplication has already paid for. Still capture/hash work continues; it is not zero idle CPU.
- **Separate work queues:** [Dispatch.swift](https://github.com/Robertg761/synara/blob/5d0fdf14a3159be350fc7c3457e640a6bb3ee6f3/apps/server/native/computer-use-macos/Sources/Dispatch.swift#L34) separates input, perception, accessibility and cursor presentation, avoiding a single serial queue behind screenshots.
- **Not better in every dimension:** the ordinary button-click route still resolves semantic controls and injects coordinates, whereas the local optimization now uses advertised AXPress. The PR's input route also deliberately refuses activating another application as a fallback. Its animation, native authority, permissions and capabilities cannot be assumed interchangeable with our current host integration. It does not by itself fix provider catalog/context overhead.

Recommendation: retain the measured native-click and context improvements, reuse the capture optimizations where they fit the shared AppSnap/Computer capture boundary, and make the default cursor presentation short and unobtrusive. Cursor decoration should not impose a visible pause per action. Do not replace the current backend wholesale or claim Robert's is faster overall without running the same Calculator, browser-form and sparse-accessibility workloads in its signed app.

No Robert-helper live benchmark or new TCC grant was performed in this comparison. The PR's own native-test notes distinguish no-input regressions from installed-build delivery and permission testing.

## Verification

- Full workspace formatting, lint and seven-package typecheck passed during implementation; lint reported 596 existing warnings and zero errors.
- Computer/gateway regression suite: 437 tests passed before the final app-filter addition. The final gateway suite then passed 93 tests, including the filter regression, and the provider-context suite passed 10. These overlap and are not added together.
- Desktop host suite: 25 tests passed after the environment-configuration fix. The sandbox initially denied Unix sockets; the authorized run outside that restriction passed.
- Native targeted tests: 31 passed, covering the observer sanitizer boundary, exact targets, cancellation, AX dispatch/no replay, focus restoration and cursor duration.
- Both arm64 and x64 native release binaries built, combined into a universal artifact, and passed provenance provisioning. Applying the checked-in patch reconstructed all 817 source files exactly. Intel compilation was verified; Intel execution was not.
- Final server typecheck and server/desktop builds passed; Dev was updated to native revision 4 for these measurements; the linked follow-up advances it to revision 5.

This is a Calculator-path optimization and code comparison. It is not a sustained RAM/CPU benchmark, a complete signed-app permission matrix, or a claim that every provider/app has been qualified.
