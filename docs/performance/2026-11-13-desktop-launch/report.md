# Desktop launch to typing - 2026-11-13

Two changes make the desktop app accept typing sooner after launch. No visible UI changed.

| Data home                           | 1.5.3, median (range) | With both changes, median (range) | Change          |
| ----------------------------------- | --------------------- | --------------------------------- | --------------- |
| Empty: no threads yet, unsent draft | 8356 ms (8252-8599)   | 2371 ms (1992-2890)               | -5985 ms (-72%) |
| Seeded: 12 projects, 301 threads    | 3264 ms (3174-3424)   | 2756 ms (2598-3563)               | -508 ms (-16%)  |

Relaunch after a normal quit, 10 alternating launches per side, 0 failed samples. All
samples: [measurements.json](measurements.json).

## What was slow

### 1. A fixed wait when the server has no threads

When the app remembers a last route and the store has zero threads, the route restore
starts a recovery: it asks the server for the shell snapshot 12 times, 500 ms apart, then
loads the full snapshot, then asks the server to repair its projections. Only after that
does it open the draft chat. This protects large databases whose projections are still
catching up. A home that never had a thread paid for it on every launch: about 5.5 s of
waiting and one projection repair (`repairing orchestration projection state` in the
server log of every 1.5.3 launch of the empty home).

Every home has a hidden "Home" chat project, so the existing
`requiresEmptyProjectShellRepair` flag never proves that the thread list is complete. An
experiment that relied on it changed nothing (5 + 5 launches, composer at 8.2-8.6 s on
both sides) and was dropped.

Change: the queried shell snapshot can now carry `emptyThreadShellVerified`. The server
sets it to true only when, inside the snapshot's SQL transaction, there is no live
projected thread, no event with `aggregate_kind = 'thread'` in the journal, and no pending
project repair. With no thread event in the journal there is nothing a projector could
still be catching up on. The client then skips the remaining polls, the full snapshot, the
repair and the 1.8 s fallback wait. Any other answer, including a server that does not
send the field, keeps the old recovery unchanged. Subscription snapshots do not carry the
field.

Not covered on purpose: a home whose threads were all deleted still has thread events, so
it keeps the old wait.

### 2. Reconnect backoff while the app's own backend starts

The desktop window loads while the backend process is still starting. The first
connection attempts fail, and the reconnect loop backed off 0.5 s, 1 s, 2 s. One traced
launch of the seeded home (diagnostic, not a timing): attempts at 0.66 s and 1.17 s failed,
the third at 2.17 s succeeded, and the renderer was about 95% idle in between. The app was
waiting for the next backoff step after the backend was already up.

Change: until a transport's first successful connection, a backend on a loopback address
is retried every 100 ms, for at most 10 s after the transport is created. Startup retries
do not advance the backoff counter. Remote hosts and every later reconnect keep the
existing backoff. The scope is "loopback and not yet connected", not "desktop only": a
browser tab on the local server or a workspace frame's controller connection can use the
short interval too.

## Results per change

Each row is its own alternating A/B run against 1.5.3 unless stated.

| Run            | Home   | A, median (range), n    | B, median (range), n    | Change          |
| -------------- | ------ | ----------------------- | ----------------------- | --------------- |
| Empty proof    | Empty  | 8373 ms (8235-8549), 7  | 2815 ms (2743-3043), 7  | -5558 ms (-66%) |
| Reconnect      | Seeded | 3302 ms (3206-3845), 7  | 2841 ms (2605-4032), 7  | -461 ms (-14%)  |
| Both, relaunch | Empty  | 8356 ms (8252-8599), 10 | 2371 ms (1992-2890), 10 | -5985 ms (-72%) |
| Both, relaunch | Seeded | 3264 ms (3174-3424), 10 | 2756 ms (2598-3563), 10 | -508 ms (-16%)  |
| Both, advised  | Seeded | 3314 ms (3274-3390), 5  | 3005 ms (2699-3058), 5  | -309 ms (-9%)   |
| Both, advised  | Empty  | 8316 ms (8310-8357), 3  | 2115 ms (2021-2397), 3  | -6201 ms (-75%) |

- The reconnect run has one slow sample on each side (3845 ms and 4032 ms) from machine
  load; the ranges overlap. The earlier experiment form of the same idea measured
  3174 ms (3087-3554) against 2667 ms (2401-2934), 10 + 10, without overlap.
- "Advised" launches evict the page cache of the Electron files, the bundles and the data
  home with `posix_fadvise` first. This is not a full cold boot. The last row was stopped
  after 3 pairs.
- After both changes the limiter on the seeded home is backend startup: about 1.2 s from
  backend spawn to readiness on this machine, of which 870 ms (733-906, 5 launches) is
  before migrations start. A CPU profile of that phase shows module loading and
  compilation (about 2,600 modules).

## Method

- Machine: Linux 7.2.15 (Omarchy, Wayland), 16 CPU threads, 22 GB RAM. The desktop was in
  normal use during all runs, so every comparison alternates A, B, A, B.
- Build: `bun run build:desktop` with bun 1.4.4 and node 24.13.1, launched as the source
  desktop build (`SYNARA_DESKTOP_FLAVOR=dev`) with its own data home and Electron profile.
  It is not the packaged asar app.
- Harness: [harness/bench-launch.mjs](harness/bench-launch.mjs). One launch per sample.
  The timer starts right before the Electron process is spawned. The harness attaches over
  the DevTools port, emulates window focus (the app only focuses the composer when its
  window has focus), sends real key events and stops the timer when the first two typed
  characters are in the composer's DOM text. It never focuses the composer itself. A sample
  is invalid when the composer was not empty before typing, when the typed text could not
  be removed, or when the app had to be killed. The app is quit with SIGTERM and the
  harness waits for the whole process group to exit.
- One-time dialogs (feature tour, announcements) are stored per data-home path, so every
  copied home is first settled at its final path with
  [harness/prep-home.mjs](harness/prep-home.mjs), then relaunched once unmeasured.
- Seeded home: written by Synara's own orchestration engine (commands, events and
  projections), not by SQL inserts. 12 projects, 301 threads, 14,000 messages, 13,875
  tool rows, 82,193 events, 177 MB `state.sqlite`.

Example, from the repository root after `bun run build:desktop` in both checkouts:

```bash
node docs/performance/2026-11-13-desktop-launch/harness/prep-home.mjs --app <checkout> --home <home-copy>
node docs/performance/2026-11-13-desktop-launch/harness/bench-launch.mjs \
  --app <checkout> --home <home-copy> --runs 1 --mode warm --label a-1 --out a-1.json
```

## Checks

- `bun run fmt:check`, `bun run lint`, `bun run typecheck`: pass.
- Server `ProjectionSnapshotQuery.test.ts` and `wsSnapshotLiveStream.test.ts`: 75 pass.
  The new cases failed before the server change: empty journal, hidden Home project with
  missing cursors, thread events without a projected thread, a projected thread without
  events, a missing durable project, deleted thread history, and the default call that
  must omit the field.
- Contracts `orchestration.test.ts`: 35 pass, including payloads without the field.
- Existing web unit tests for the touched modules: 304 pass.
- Real app, both homes: same final route, same element count (692 and 2,939), same
  visible text length. Seeded-home screenshots of both builds differ in 15 of 1,752,790
  pixels, the composer's text cursor. The new build does not log a projection repair on
  the empty home.
- EXISTS query plan on the 177 MB database:
  `SEARCH orchestration_events USING COVERING INDEX idx_orch_events_stream_sequence (aggregate_kind=?)`.
  No new index or migration.

## Not measured

- The packaged app, macOS and Windows.
- Pixels on screen: the endpoint is DOM text with emulated focus, not a captured frame.
- Remote projects, opening a thread in a running app, and homes with deleted thread
  history or an older remote server (covered by tests and code review only).
- A backend compile cache: an environment probe (`NODE_COMPILE_CACHE`) on top of the
  reconnect change measured 2836 ms (2650-3063) against 2640 ms (2518-3170), 10 + 10,
  rank-sum p = 0.013. It is not implemented here.
