# In-app Computer Use preview

When an agent starts driving the desktop, Synara shows a small live preview inside the owning thread's chat surface instead of opening the dock pane. The earlier floating AppSnap panel (`--computer-preview`) was removed; the preview is now in-app, with a native frame tap as the real-time tier.

## Surfaces

- **Preview popover** (`apps/web/src/components/chat/ComputerPreviewPopover.tsx`): a ~300px floating card anchored bottom-right over the owning thread's chat surface. It shows the live frame stream, the agent's latest action label, its cursor as a halo dot, a Stop control (same interrupt as the pane), an expand control, and a close control. It is view-only.
- **Dock Computer pane**: unchanged. It remains the detailed interactive surface — it opens when the user expands the popover or picks Computer from the dock menu, and it is the intended home for remote/SSH/VM previews later.

The popover and the pane are one surface at two sizes: the popover yields while the thread's dock Computer pane is open, and expanding demotes the popover for the rest of the task.

## Preview session machine

`apps/web/src/computerPreviewStore.ts` keeps a per-thread `ComputerPreviewSession` with phases `armed | live | hidden-for-task | ended`:

- `armed`: `computer.open-pane-requested` arrived (emitted once per desktop lease) or a drive turn began. Sessions arm on the owning thread whether or not it is visible, so background agent work never steals the user's current chat.
- `live`: the armed session is actually being rendered by the viewed thread's surface. Only live sessions attach a frame stream.
- `hidden-for-task`: the user closed the card or expanded to the pane. It re-arms on the next lease or drive turn.
- `ended`: the lease released or the drive turn ended. Sessions also die when their thread state vanishes or the state store resets.

Drive-turn edges come from `controlOwnerThreadId` on `computer.thread-state` snapshots — it stays set across thinking gaps, unlike `agentActive`, which only covers an in-flight call.

## Frame sources

- **Stills (baseline, all clients)**: `StillFramePublisher` captures whole-desktop PNG stills every 2s over `/ws/computer-frames`; `useComputerImageStream` draws them to the popover canvas. This is the only source for browser-hosted clients.
- **Native frame tap (desktop app)**: the AppSnap helper's `--computer-frames` mode streams JPEG frames of the task's target window over a dedicated unix socket. The host (`apps/desktop/src/computerFrameTap.ts`) spawns one helper per task target after the first task-attributed window call, forwards frames to the renderer on `computerPreview.frame`, and the popover prefers them while they are fresh. Still captures continue underneath as the fallback tier.

The tap captures at ≤960px, 15fps cap, one encode in flight (frames drop, never queue). Frames travel helper → socket → `webContents.send` → canvas. They never enter the driver operation queue, the server, or provider context — screenshots remain explicit tool requests.

## Ownership and cleanup

One helper per task target (`threadId`, `turnId`, `pid`, `windowId`). The tap stops on `end_task`, host `stop()`/`suspend()`/`dispose()`, helper exit, or parent death (`ParentProcessMonitor`). A helper that dies without being retired poisons only its target — the same task+window never respawns, while a legitimate retarget can. `end_task` clears the task's dead-target memory, so a new task gets a fresh tap. A delayed or failed tap shutdown never delays release of desktop control.

Helper protocol isolation: frame bytes ride the unix socket; stdout stays NDJSON lifecycle lines (`ready`/`error`). Socket directory is `0700`, socket `0600`, frame length capped at 4 MiB.

## Verification, 15 September 2026

- Universal native helper builds for arm64 and x86_64; `--computer-frames` argument validation rejects missing or mismatched flags.
- Independent socket read against a live playing-video window: 12.5fps, 75/75 valid JPEG frames, ~91KB average, no helper leaks after kill.
- Host lifecycle covered by tests plus bun-harness runs: task-attributed call starts the tap, `end_task` stops it, SIGKILL leaves no respawn, retarget swaps helpers, `dispose` leaves no `synara-frames-*` directories.
- Web-side coverage: popover phase machine, session store, bridge edge detection, tap source selection and hook decode/drop/cleanup tests, SSR markup, and Playwright interaction tests.

## Not yet qualified

- Packaged-app end-to-end proof of the full chain (turn → popover → tap video → expand/stop/cleanup) pending on this branch.
- Multi-display and other-Space windows, permission-revocation mid-task, and sustained helper CPU/RSS under load still need dedicated qualification.
- The `autoOpenComputerPane` setting now gates the ambient preview; its Settings copy still says "Computer pane".
