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
| `LC1/*`, `LC2/*`                          | Opt-in `longchat` suite: first open and switch back of each realistic long thread (pointerdown until the transcript is at the end).     |
| `LC3/*`, `LC4/*`                          | Same suite: 90 wheel ticks and a 40×1200 px fling per long thread; frames over 33 ms and the 95th percentile frame time on the GPU.     |

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

## Long chats

The generic seeded threads have no turn ids and tiny payloads, so they do not look like
real long agent threads. [`seed-realistic-threads.ts`](seed-realistic-threads.ts) adds
three threads whose shape follows aggregate statistics of real data homes (all content
is synthetic): `real-thread-agent-heavy` (275 messages, 5,751 activities, 9.7 MB of
payloads; 1,976 activities fit the detail window), `real-thread-agent-mid` (70 messages,
1,241 activities) and `real-thread-prose` (300 long markdown messages with code and
tables, no tools). Assistant messages carry turn ids, tool payloads range 0.2–16 KB and
about one `context-window.updated` follows each tool call.

**Headless suite** ([`longchat.mjs`](longchat.mjs)): real backend in web mode plus the
build's production web bundle in headless Chromium. It runs with the screen locked.

```bash
# Once per build schema: seeded template + realistic threads, migrated.
node benchmarks/desktop-perf/longchat.mjs --prepare-base --build main
# Two builds alternate A B B A; --profile adds CPU profiles (build with
# SYNARA_WEB_SOURCEMAP=hidden to resolve them), --capture writes snapshot frames.
node benchmarks/desktop-perf/longchat.mjs --build main --build branch --label x
node benchmarks/desktop-perf/longchat-report.mjs benchmarks/desktop-perf/results/longchat-*-x.json
```

It opens `small-38`, `prose-300`, `agent-mid`, `agent-heavy` and `synthetic-1400` cold
(detail never loaded in the page) and warm (after a switch away), then scrolls each long
one: 90 wheel ticks of 240 px, a 40×1200 px fling, the same fling again over measured
rows, and a fling that samples how much of the viewport no row covers.

| Reading                    | Meaning                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `cold/warm: first row ms`  | pointerdown on the sidebar row until the first new message row is on screen                  |
| `cold/warm: at bottom ms`  | pointerdown on the sidebar row until new rows are on screen and the transcript is at the end |
| `script`, `style+layout`   | main-thread time from `Performance.getMetrics` over the measurement                          |
| `long tasks`               | tasks over 50 ms (PerformanceObserver)                                                       |
| `snapshot KB / arrival ms` | largest WebSocket frame after the press, and when it arrived                                 |
| `retained heap MB`         | JS heap after GC, after the cold open, minus before it                                       |
| `blank >25% frames`        | fling frames where mounted rows cover less than 75% of the viewport                          |

Each build gets 6 samples by default (`--runs`), alternating A B B A. Open timings are
bimodal on the same build (a switch back to agent-heavy read 90, 109 and 109 ms), so 3
samples only separate large differences: an apparent +23% on 3 samples was noise.
`longchat-report.mjs` prints `median (min–max) [samples]` and marks a change
`≈ spread` when the new median falls inside the first build's range. Treat such a
change as no difference.

The desktop app connects to the backend it spawned without permessage-deflate (the
renderer declares it on the feature socket). The suite runs the client in a browser,
where that condition cannot hold, so by default it sets the declared local-backend
switch in `localStorage` before the page loads (`--no-desktop-local` turns it off). The
switch only removes compression, only for a page on a loopback backend, and builds
without it ignore it.

Open timings start at **pointerdown**, so they include the press itself: by default
the button is released after 80 ms (`--press-ms`, a typical mouse click), and work the
app starts on pointerdown (subscribing a thread) overlaps it. `--press-ms 0` releases at
once, which hides that overlap and reads the same as an instant synthetic click.

Valid: main-thread times, long tasks, open latency, payload sizes, heap. **Not valid:
frame times** — headless Chromium rasterizes in software. For frames on the real GPU,
create a template set with the realistic threads and run the opt-in Electron suite (the
window must stay in front):

```bash
node benchmarks/desktop-perf/prepare.mjs --ref main --name main --templates --template-set longchat --realistic
node benchmarks/desktop-perf/run.mjs --build main --suites longchat --template-set longchat
```

Its keys use the `LC` prefix (`LC1/open-first-*` … `LC4/fling-gaps-*`); `L1/*` belongs to
the load suite.

`apps/web/perf/longChatDerivations.perf.test.ts` times the per-event derivation chain on
the captured snapshot frames (`SYNARA_PERF=1`) and fails on a tenfold regression.

## Diagnostics

`diagnose.mjs` (startup timeline, quit log, backend and GPU memory, compositor layers,
compile cache) and `diagnose-backend-boot.mjs` (headless backend boot time and CPU
profile) print single-launch leads for planning. They are not benchmark results.
