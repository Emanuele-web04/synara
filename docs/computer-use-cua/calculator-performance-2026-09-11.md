# Calculator: Synara and Codex Computer Use

Analysis of the two recorded `123 × 45` runs on 11 September 2026. This is an inspection of existing runtime records and source, not an optimization benchmark. No production implementation changed in this investigation.

## Comparable measurements

Both recorded turns used `gpt-5.6-sol`, medium reasoning, priority service. Synara used the patched Cua 0.24.0 native revision 3. Codex used its own Computer Use integration; these are different native implementations.

| Metric | Synara | Codex Computer Use |
| --- | ---: | ---: |
| Provider turn, start to complete | 50.402 s | 17.177 s |
| Computer tool duration, summed | 23.227 s | 5.797 s |
| Eight clicks | 20.849 s | Included in 2.922 s with the final AX read |
| Model requests | 6 | 3 |
| Total processed tokens | 454,292 | 522,512 |
| Input | 453,030 | 522,205 |
| Cached input | 438,656 | 520,448 |
| Uncached input | 14,374 | 1,757 |
| Output | 1,262 | 307 |
| Reasoning, included in output | 594 | 108 |
| Uncached input plus output | 15,636 | 2,064 |

The earlier 5.80-second Codex figure was tool time, not the complete turn. Its Calculator window was already open when selected, so the launch numbers are not a cold-start comparison. The click batch is about 7.1 times slower in Synara in these two samples; that does not establish an average across repeated trials or other applications.

The aggregate token figure is also not a fair standalone efficiency measure: the Codex chat started this turn with approximately 173,000 input tokens, whereas Synara started with approximately 66,700. Each subsequent request processes the retained context again. Cached input is still reported usage; uncached input plus output is not a monetary-cost or quota-equivalence formula.

### Corrections to the pasted timings

- The local Synara projection records the user message at `21:11:01.402Z` and the assistant's final message creation at `21:11:52.517Z`. Their difference is the reported **51.115 s**, but that is until the final answer starts, not until its last update.
- The final message was updated at `21:11:52.654Z`: **51.252 s** after the user message. The projected turn completed at `21:11:52.672Z`: **51.270 s**.
- The first click tool began at `21:11:23.747Z`: approximately **22.345 s** after the user message. This is tool admission, not a timestamp of the physical mouse-down.
- Summing the native MCP duration fields gives **20.848678 s** for the eight clicks and **23.227162 s** for all Computer operations. The pasted 20.845/23.221-second figures differ by only 4–6 ms; they are essentially the same result with a different timing/rounding boundary. Codex's native MCP durations sum to 5.796764 s; the tool wrapper's 2.8758/2.9227-second labels sum to 5.7985 s.

## What caused the wasted tokens and model latency

The first action in the Synara turn was a tool-discovery script:

```js
text(ALL_TOOLS.filter(x => x.name.includes("mcp__synara__computer_"))
  .map(x => x.name + " — " + x.description).join("\n"));
```

It printed the entire Computer catalog, rather than discovering the specific launch/state/click tools. The output reports an original 11,260 tokens and is truncated; the serialized retained output is roughly 40 KB. The next model request grows from **66,723 to 75,516 input tokens**, an **8,793-token increase**. That delta includes the surrounding request material, so it is not an exact tokenizer measurement of the catalog alone.

Per-request usage from distinct `token_usage_record` records:

| Request | Purpose | Input | Cached | Uncached | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Discover tools | 66,723 | 66,304 | 419 | 140 |
| 2 | Launch Calculator | 75,516 | 66,560 | 8,956 | 81 |
| 3 | Read initial state | 75,707 | 75,392 | 315 | 170 |
| 4 | Execute eight-click script | 77,195 | 75,520 | 1,675 | 478 |
| 5 | Read final state | 78,045 | 76,928 | 1,117 | 295 |
| 6 | Final answer | 79,844 | 77,952 | 1,892 | 98 |

The clicks were **already grouped in one script**. There were no model round trips between the eight clicks. Therefore batching the eight MCP calls at the JavaScript level would not fix the measured 20.85 seconds: the turn already did this.

Roughly **27.17 seconds** of the provider turn lie outside the measured Computer operations. This includes model inference/generation and orchestration/transport boundaries; the records do not provide a complete server-side phase trace that attributes every millisecond exclusively to inference.

The model requested three images: initial state, the last click's observation, and final state. It also requested both structured elements and textual AX state. The last image could potentially be avoided by making the final observation carry sufficient result text. This is a smaller issue than the catalog dump.

The backend returned 193 and 198 windows in its scoped state responses (about 37–38 KB of window metadata). The script filtered that list before emitting its model-visible output. This is unnecessary backend/IPC work, but those full window lists must **not** be counted as if they were all injected into this turn's model context.

## What caused slow clicks and cursor movement

Each click returned `cua-global_input-foreground`, with an unverifiable effect. Durations are from the individual MCP completion records, not estimates from the UI:

| Button | Duration | Screenshot |
| --- | ---: | --- |
| All Clear | 2.856105 s | No |
| 1 | 2.600073 s | No |
| 2 | 2.368491 s | No |
| 3 | 2.393208 s | No |
| Multiply | 2.510952 s | No |
| 4 | 2.656881 s | No |
| 5 | 2.393022 s | No |
| Equals | 3.069947 s | Yes |

### Synara integration

1. `ComputerManager.resolveSemanticTarget()` reads a fresh native AX tree for each label-based click. The initial model observation is not reused as an action handle.
2. `prepareResolvedTarget()` calls `focusWindow()`, which performs another window enumeration in CuaComputerBackend. The subsequent `input()` performs another exact-window lookup. `getState()` also refreshes permission/window/screen metadata and resolves the target.
3. Normal AX buttons go through `pointerClick()`'s coordinate injector. `CuaComputerBackend.click()` passes `force_synthetic: true`. Thus the Calculator buttons are found semantically and then converted to synthetic coordinate clicks instead of using their native AX action tokens. Merely removing `force_synthetic` would not fix the foreground case: upstream's coordinate-to-AX shortcut also excludes foreground delivery.
4. After mutation, `snapshotAt` is cleared. The next semantic lookup again refreshes the backend; that refresh invokes the shared AppSnap permission helper. This is a fresh process, not just an in-memory permission boolean. Keep fresh setup/revocation handling, but remove redundant work within an already admitted operation.
5. The automatic screenshot adds a 300 ms settle delay when no explicit readiness condition is supplied. In this run it applies to the final click only, so it cannot explain the other seven slow clicks.

Relevant source: `apps/server/src/computer/ComputerManager.ts` (`pointerClick`, `resolveSemanticTarget`, `prepareResolvedTarget`), `apps/server/src/computer/CuaComputerBackend.ts` (`refresh`, `getState`, `target`, `click`), `apps/server/src/agentGateway/computerTools.ts` (`observeAfterAction`), and `apps/desktop/src/desktopPermissions.ts`.

### Cua defaults on the selected path

The exact upstream commit is `4b3396d9fe4bd3cf723b0eb8db83c18a8764b520`, verified against the local release manifest and bundled provenance. The local native patch does not remove these waits:

- [Coordinate click](https://github.com/trycua/cua/blob/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520/libs/cua-driver/rust/crates/platform-macos/src/tools/click.rs#L960) awaits the cursor animation **before dispatching the click**. Slow animation therefore directly delays input; it is not just cosmetic.
- [Cursor animation](https://github.com/trycua/cua/blob/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520/libs/cua-driver/rust/crates/platform-macos/src/cursor/overlay.rs#L390) waits for the render thread's arrival signal. Synara does not set a short glide duration in its host/backend.
- [Post-action observation](https://github.com/trycua/cua/blob/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520/libs/cua-driver/rust/crates/platform-macos/src/tools/mod.rs#L284) invokes a [window-change detector](https://github.com/trycua/cua/blob/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520/libs/cua-driver/rust/crates/platform-macos/src/window_change_detector.rs#L149) with a **1,000 ms timeout and 50 ms polling**. It watches new windows/foreground changes, not the Calculator display value, so a digit change does not satisfy its early-exit condition.
- Foreground assistance also activates/restores the target and polls for exact-window focus for up to 400 ms. That is another possible cost, not evidence that every click exhausted that timeout.

These are confirmed code paths consistent with the observed timings. The saved records do **not** separately time cursor animation, focus admission, AX reads, permission helpers, and window polling. It would be incorrect to claim an exact partition of the 2.4–2.9 seconds or a measured post-fix improvement.

The generic `unverifiable` verdict is expected for a button without a dedicated native postcondition; it is not proof that a click failed or permission was denied. Do not add retries to overcome it.

`computer_move_cursor` was not called in this run. Separately, the current Cua backend's move operation is overlay-only; it should not be treated as evidence of real pointer hover.

## Changes to prioritize

1. **Stop printing the full catalog.** Provide minimal activation/bootstrap guidance and specific tool discovery. Keep Computer schemas, instructions and images absent on turns that have not activated Computer. Use a concise model-facing surface consistently across providers.
2. **Remove avoidable native waiting.** Bound cursor animation tightly, and replace per-click generic window polling with appropriate target observation and task-boundary verification. Upstream's `_skip_window_change_detection` is intended for clients that already observe continuously; do not enable it globally without replacing the behavior it provides.
3. **Preserve semantic targets.** Use validated native AX press for controls that advertise it. Choose synthetic input before dispatch when required by the surface. Retain exact-window, generation, permission and Stop checks; never replay an action whose effect is uncertain.
4. **Reuse observation data safely.** Avoid repeated whole-desktop enumeration and permission-helper launches inside one admitted operation. Invalidate on relevant window/control/lifecycle changes. Observe once at the end of a stable short sequence, with the result text or image needed for verification.
5. **Measure before claiming completion.** Add phase timing around gateway admission, AX resolution, GUI-host RPC, native animation/dispatch/observation and final rendering. Repeat the same eight-click test in a fresh chat with the same model/settings, then test a browser form and an app with sparse AX support. Compare p50/p95, model requests, uncached/cached/output tokens and actual result correctness. Preserve cancellation and uncertain-delivery tests.

This supports improving the existing Synara/Cua integration first. It does not establish that Cua must be replaced, or that switching provider would remove the slow individual actions.

## Evidence identifiers and scope

- Synara provider session: `01a091de-f57e-7323-9014-7658166214d0`; Calculator turn: `01a0924f-3f76-7911-a49e-31e78e362068`. Raw session records 602–658 include the six distinct usage records and eight click durations. Synara's local projection supplies the UI timestamps above.
- Codex session: `01a07d4e-33d0-72d1-a005-a4212eaffd9f`; Calculator turn: `01a09252-ad89-72d0-9f21-a3bbac24b21c`. Raw records 13501–13525 supply tool durations, complete-turn duration and three usage records.
- Duplicate `event_msg`/`response_item` views and cumulative `token_count` entries were not summed as new provider usage.
- No new desktop actions, permission changes, native rebuilds, provider turns, or full workspace checks were performed for this analysis. The two runs are historical single samples, not a controlled performance experiment.
