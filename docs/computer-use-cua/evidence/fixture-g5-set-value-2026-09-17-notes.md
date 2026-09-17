# G5 closure — three-window focus-neutral text via `set_value` (2026-09-17)

Machine: disposable VM (M4 Pro, macOS 26.5.2), fixture direct-exec'd under a
TCC-responsible shell holding Accessibility + Screen Recording. Fixture bundle
rebuilt from `apps/desktop/src/cuaFixtures/electron.ts` at this branch;
`SYNARA_CUA_FIXTURE_FOREGROUND=approved-once` set (no operator on this VM).
Report: `fixture-g5-set-value-2026-09-17.report.json`.

## Result — full fixture green

| Case                                     | Baseline rev15                  | This run                                                                                                              |
| ---------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| one-click-one-effect                     | passed                          | passed                                                                                                                |
| identical-text-replacement               | refused (ambiguity)             | refused (ambiguity, by design)                                                                                        |
| three-window-focus-neutral-semantic-text | **failed**                      | **passed** — 3× `verified`/`confirmed`, `cua-accessibility-background`, ~100 focus samples all sentinel, overlap true |
| single-window-identical-text             | passed                          | passed                                                                                                                |
| explicit-foreground-text                 | not-run                         | **passed** (`foreground-ok`)                                                                                          |
| ax-set-value                             | passed                          | passed                                                                                                                |
| moved-target                             | passed (stale-geometry refusal) | passed                                                                                                                |
| closed-target                            | passed (off-Space refusal)      | passed                                                                                                                |
| native tier (5 cases)                    | passed                          | passed                                                                                                                |
| cancellation (2 run)                     | passed                          | passed                                                                                                                |
| gateway                                  | 2 failures                      | same 2 failures — pre-existing approval-harness issue, identical pre-change                                           |

## What changed

`CuaComputerBackend` now tags elements the driver reports as
`in_web_content` and routes `typeText` on those nodes through
`webContentTypeText`: re-resolve the element (role+label+frame match), compose
`existingValue + text`, `set_value`, then independently re-read the element and
report `verified` only when the DOM value equals the composed string. `setValue`
on web elements gets the same verified write. Chromium-family
`AXSelectedText` inserts (the old `semantic_only` path) are empirically dead —
dispatches report success while the DOM never changes — see
`input-matrix-2026-09-17.md`.

## Consequence for the plan

- The belief-canary question is answered differently than the spec predicted:
  no synthetic stage is needed; `AXValue` writes are already focus-neutral and
  effect-atomic on Electron.
- The Option-C sidecar's reason to exist (belief + masked activation) is gone:
  `delivery_mode=foreground` performs short-lived activation+restore natively
  and invisibly (verified: `lastkey` reached renderer while TextEdit stayed
  front). Sidecar reduces to optional theft-sampling; recommend not shipping it.
- Remaining known-baseline items: `identical-text-replacement` refuses
  window-scoped synthetic keys under same-pid ambiguity (correct — agents must
  use element-targeted type); gateway approval-harness cases fail identically
  pre/post change and need a separate fix.
