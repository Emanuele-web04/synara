# Desktop performance harness

Measures a Synara desktop build on this machine: startup, memory, CPU at rest, GPU,
thread switching, scrolling, and load with real provider sessions. Every number comes
from launching and driving the real app; nothing is estimated or mocked.

It never touches `~/.synara` or `~/.synara-beta`. Builds, data homes and Electron
profiles live under `~/synara-perf-bench` (override with `SYNARA_PERF_BENCH_ROOT`), and
the app is started with a clean environment so no other Synara instance, provider
config directory or agent session leaks into it.

## Run it

```bash
# 1. Build a git ref outside the repository (about 3.4 GB per build).
node benchmarks/desktop-perf/prepare.mjs --ref origin/main --name main

# 2. Once: create the two data homes with that build.
node benchmarks/desktop-perf/prepare.mjs --ref origin/main --name main --templates

# 3. Measure. One command, one results file in benchmarks/desktop-perf/results/.
node benchmarks/desktop-perf/run.mjs --build main --label baseline

# Two builds, alternating samples (A, B, B, A, ...):
node benchmarks/desktop-perf/prepare.mjs --ref my-branch --name branch
node benchmarks/desktop-perf/run.mjs --build main --build branch --label after

# Tables with raw samples next to each median; the last column shows the change.
node benchmarks/desktop-perf/report.mjs benchmarks/desktop-perf/results/<file>.json [...]
```

Options for `run.mjs`: `--suites startup,idle,switch,load` (default all), `--runs 5`,
`--max-attempts 10`, `--template-set <name>`, `--allow-locked-screen`.

Before each sample the runner waits until nobody has touched the Mac for 45 seconds. A
sample taken while another app is in front, or while the screen is locked, is recorded
as invalid with its cause and an extra sample is taken instead; nothing is replaced.
`--allow-locked-screen` accepts a locked screen and stamps it on every sample: use it
only for process-level readings (startup log timings, backend CPU and memory).

A full pass of one build takes about 35 minutes and sends 15 real provider turns
(Claude Sonnet, about 900 words each). Do not use the Mac while it runs: the app window
must stay in front, and other load changes the readings.

## What is launched

- **Build type:** a source build (`bun run build:desktop`, the unpackaged Electron from
  `node_modules`, production web bundle). It is not the packaged, signed app.
- **Launch:** the same path as `apps/desktop/scripts/smoke-test.mjs`: `SYNARA_HOME` and
  `SYNARA_DESKTOP_SMOKE_USER_DATA` point at the isolated home and profile, plus
  `--remote-debugging-port` on a free port so the harness can drive the window.
- **Input:** mouse, wheel and key events go through the DevTools protocol into
  Chromium's input pipeline.

## Data homes

`prepare.mjs --templates` creates two templates and stores them under
`~/synara-perf-bench/templates/<set>/`. Each sample restores a template to one fixed
path (`~/synara-perf-bench/homes/active`), because the app keys some first-run state by
the absolute path of the data home.

| Template | Contents                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty`  | Onboarding finished, no projects, no threads; the last route is a draft chat.                                                                |
| `seeded` | 12 projects, 300 threads, 14,406 messages, 57,624 activities (179 MB); the last route is a 38-message thread. One thread has 1,400 messages. |

The seeded home is written by [`seed-home.ts`](seed-home.ts) through the server's own
orchestration engine (decider, event store, projection pipeline) using the app's
`project.create`, `thread.create`, `thread.messages.import` and `thread.activity.append`
commands. Activity rows copy what one real Claude turn writes. Output is deterministic.

A template set belongs to one database schema. To measure a build that predates a
migration, create a second set with a build of that schema
(`--templates --template-set <name>`) and pass the same `--template-set` to `run.mjs`.

## Measurements

| Key                                       | What it is                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `A1/cold`                                 | Spawn of the Electron process until two typed characters are in the composer; seeded home, Chromium disk caches deleted first.          |
| `A2/relaunch`                             | The same on the next launch (caches warm). `-first-paint` and `-sidebar` are intermediate marks; `-empty-home` uses the empty template. |
| `Q1`, `Q2`                                | Time from SIGTERM until every process of the app has exited, right after start and after the idle run.                                  |
| `A5/*`                                    | Memory at rest after a 45 s settle, by process role. Physical footprint from `/usr/bin/footprint`, the figure Activity Monitor shows.   |
| `A6/*`, `W1/*`                            | CPU (percent of one core) and idle wake-ups per second over 60 s, window in front, then covered by an opaque window of the same size.   |
| `G1`, `G2`, `G4`, `G5`                    | GPU-process CPU at rest, while scrolling and while streaming; GPU-process memory.                                                       |
| `G3`                                      | System-wide GPU utilization from `ioreg`. It includes every other app, so it is context, not a result.                                  |
| `A11/open-first-*`                        | Real click on a sidebar row until the thread's rows are on screen and the transcript is at the bottom; thread detail not loaded before. |
| `T1/switch-back-*`                        | The same for a thread already opened in this session.                                                                                   |
| `A11/scroll-gaps`, `A11/scroll-frame-p95` | 90 wheel ticks up through the 1,400-message thread; frames longer than 33 ms, and the 95th percentile frame time.                       |
| `A10/mb-per-viewed-thread`                | Memory change of renderer + backend + main after viewing 10 more threads, per thread. No sessions.                                      |
| `A7/*`, `L1/*`                            | Three new threads streaming a 900-word answer from real Claude Sonnet sessions at once: memory and CPU of the whole process tree.       |
| `A8/*`                                    | 60 keys typed 100 ms apart in the composer while those sessions stream: keydown until the frame after the input event.                  |
| `A10/mb-per-thread`                       | Memory change of the whole tree per thread once the three turns have finished and their sessions are still alive.                       |

The `A*` keys follow the numbering of the third-party benchmark this work started from;
its test definitions are not documented, so the match is by name and unit only.

## Results file

Written to `results/` (git-ignored: raw samples carry local paths). Same shape as the reference benchmark: `run`, `measured`, `machine`, `rule`, and one
entry per build under `apps` with `tests` (`median`, `min`, `max`, `runs`, `unit`, plus
`samples` and `failed`), or `result` and `cause` for a gap. `raw` holds every sample
with its timestamp and the machine state (load average, power source, free memory,
whether the installed Synara was running). A failed sample stays in the file with its
cause and is counted in `failed`; it is never dropped or replaced.

## Not measured

- The packaged, signed app, and Windows or Linux.
- A cold start after a reboot: the OS file cache cannot be purged without `sudo`.
- GPU power: `powermetrics` needs `sudo`.

## Known limits of the readings

- `A6/covered`: the cover window has the same bounds as the app window, and Chromium did
  not throttle rendering under it (GPU-process CPU stayed at the front-window level). A
  cover that filled the whole display did drop it to zero in an earlier pass.
- `A8/missed` reads 1 of 60 in every run of every build, which points at the probe (the
  first key lands before the recorder counts) rather than at the app. Not verified.
- `A10/mb-per-viewed-thread` is within noise (often negative): viewing ten small threads
  does not hold a measurable amount of memory.
- With two builds alternating, the first cold launch of a build right after the other
  build ran can be about 0.4 s slower. Measure cold starts of one build alone to confirm
  a cold-start difference.
- The app under test reads the real provider homes (`~/.claude`, `~/.codex`), as any
  install does. Backend memory after launch therefore depends on how many provider
  transcripts this Mac holds.

## Diagnostics

`diagnose.mjs` (startup timeline, quit log, backend and GPU memory, compositor layers,
compile cache) and `diagnose-backend-boot.mjs` (headless backend boot time and CPU
profile) print single-launch leads for planning. They are not benchmark results.
