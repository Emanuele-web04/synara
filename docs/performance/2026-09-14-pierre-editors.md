# Pierre editor performance — 2026-09-14

The file editor and split/unified diff editors now render rows near the viewport,
retain their Pierre React child across buffer-only changes, and publish history
availability only when it changes. The earlier Enter correctness patch remains
in place. Document contents, save notifications, selection, and undo history
continue to belong to the existing editor/session implementation.

## Method

- macOS 26.6.2, ARM64, Node 24.13.1, Bun 1.4.2; bundled Playwright Chromium.
- Real React/Pierre components under the repository's Vite/Vitest browser config,
  including React Compiler. This is a development component benchmark, not a
  packaged Electron or production-build measurement.
- Synthetic TypeScript fixtures with 200 or 1,000 lines, mounted in a 1000 × 600
  component. For diffs, every line changes from `= 0;` to `= 1;`: a deliberately
  dense diff, not an average repository patch.
- Three independent mounts per size/mode. After mount, focus, and layout settle,
  dispatch 20 `beforeinput` text insertions and five line breaks, waiting two
  animation frames after each event. Unified mode starts on the first addition.
- Measurements below are the median of three run medians. The synchronous input
  duration isolates the event handler. The two-frame interval also includes
  deferred viewport rendering and frame scheduling; it is not an OS keystroke
  latency measurement or proof of a presented frame.
- Baseline: `70f5ed0e4` with the pinned Pierre Enter patch, before the three editor
  component optimizations. Before/after used the same finalized harness,
  sequentially, without concurrent checks.

## Line insertion

| Mode    | Lines | Sync before → after (ms) | Two frames before → after (ms) | Two-frame reduction |
| ------- | ----: | -----------------------: | -----------------------------: | ------------------: |
| file    |   200 |                9.0 → 1.0 |                    16.0 → 16.3 |               -1.9% |
| split   |   200 |               23.5 → 7.6 |                    32.3 → 20.2 |               37.5% |
| unified |   200 |               23.0 → 7.5 |                    39.3 → 23.4 |               40.5% |
| file    | 1,000 |               31.6 → 0.9 |                    45.6 → 16.2 |               64.5% |
| split   | 1,000 |             157.2 → 60.6 |                   177.7 → 73.4 |               58.7% |
| unified | 1,000 |             166.2 → 60.8 |                   212.5 → 78.3 |               63.2% |

The 200-line file was already below the frame interval; its median two-frame
measurement is essentially unchanged. Large dense diffs still spend about 60 ms
in synchronous line-insertion work, so viewport rendering does not eliminate
Pierre's document/diff bookkeeping.

## Ordinary typing and repeated work

| Mode    | 1,000-line sync input before → after (ms) | React work for 20 inputs before → after (ms) |
| ------- | ----------------------------------------: | -------------------------------------------: |
| file    |                                 2.2 → 0.8 |                                    3.1 → 2.3 |
| split   |                                 2.2 → 0.7 |                                    3.7 → 3.1 |
| unified |                                 5.8 → 1.3 |                                    3.7 → 2.7 |

- History notifications: 20 → 1 per 20 typed characters; five subsequent line
  breaks produce no redundant history notification. Buffer changes still publish
  immediately on every edit.
- Ordinary typing: 19–20 → 0 calls to the Pierre `File.render` / `FileDiff.render`
  methods in the 1,000-line fixture. Structural edits still trigger rendering.
- Rows inside the editor textbox after typing: file and split addition columns
  1,001 → 100; unified content 2,001 → 200. These counts are not total app DOM size
  or a measurement of RAM savings.
- Ordinary typing's two-frame measurements remain near the frame-scheduling
  floor and are not uniformly faster; the synchronous work and redundant-call
  reductions are the supported typing improvements.

Reduction formula: `(before - after) / before * 100`.

## Reproduce

```bash
VITE_PIERRE_BENCHMARK=1 bun run --cwd apps/web test:browser src/components/codeEditor/CodeEditorPane.performance.browser.tsx
```

The opt-in harness writes all per-run measurements to
`apps/web/node_modules/.cache/pierre-performance.json`. It does not impose noisy
wall-time thresholds on normal CI runs.

## Behavior and limits

Browser regressions cover repeated Enter, continued typing, line joining,
undo/redo, history availability, theme changes, split/unified remounts, and CRLF
diff parity. The 2,000-line cases cover bounded rendered rows, scrolling to the
end, editing there, undo/redo, select-all replacement across unmounted rows, and
reloading a shorter document.

The read-only review panel already uses Pierre virtualization; this change is
scoped to the workspace file/diff editor surfaces. Packaged Electron, native
keyboard/IME behavior, initial opening time, CPU utilization, and memory usage
were not measured. Future work on dense diff bookkeeping needs separate profiling
and stronger dependency-level coverage rather than an inferred speedup.

## Validation

- `bun run --cwd apps/web test`: 4,595 passed, 3 skipped across 358 files.
- `bun run --cwd apps/web test:browser src/components/codeEditor/CodeEditorPane.browser.tsx src/components/WorkspaceFilePreview.editing.browser.tsx`:
  32 passed.
- `bun run fmt:check`, `bun run lint`, and `bun run typecheck`: passed;
  lint reports 560 existing warnings and zero errors, typecheck covers all seven workspaces.
- The opt-in benchmark passed for both the baseline and optimized versions.
