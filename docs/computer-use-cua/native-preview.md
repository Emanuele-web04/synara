# Native Computer Use preview

The macOS desktop host now starts an AppSnap helper in `--computer-preview` mode after the first successful, task-attributed observation or action on a specific window. It maintains a ScreenCaptureKit stream for that window and shows a floating, nonactivating preview. The existing Computer pane remains available for manual use; macOS does not automatically open that second preview.

## Capture and token budget

- `WindowFrameStream.swift` owns the shared ScreenCaptureKit implementation. AppSnap consumes one frame; Computer Use consumes a live stream.
- Video stays inside the native helper and renders through `AVSampleBufferDisplayLayer`. No video frames cross Electron/server IPC or enter provider context.
- The preview caps its longest edge at 960 pixels and its rate at 15 fps. It keeps one pending native frame, with bounded capture and presentation queues.
- Closing the panel hides it for the rest of the task and reduces capture to 1 fps. Stop ends Computer Use for that turn. A new task gets a visible preview.
- Model screenshots remain fresh, explicit tool requests through Cua. Preview frames are never substituted as evidence that an action succeeded.
- Ordinary turns start no preview helper, send no preview IPC, and gain no Computer instructions or schemas from this feature.
- Explicit invocation supports `/computer-use`, natural requests such as “Use Computer Use”, and the opening command prefix “Computer Use: …”. Quoted excerpts and ordinary discussion do not activate it.

## Ownership and cleanup

The gateway supplies thread and turn identity through an asynchronous scope. It is carried only over authenticated local IPC. Detached callbacks lose that scope when the tool returns.

The host validates the window ID and PID. Window changes discard old pending frames; closing the target stops capture rather than switching to an unrelated window. Resize updates capture dimensions without creating screenshot files. Lock, sleep, host retirement and Stop close the preview along with the native lifecycle.

Terminal turn/session events end capture even when the task only read the screen and never held an input lease. End events and Stop messages from an older task cannot retire a newer preview. A delayed or failed preview shutdown cannot delay release of desktop control. Helper replacement waits for the previous process to exit; a crash does not start a capture retry loop.

The floating Stop button revokes further Computer calls for its turn and stops native input. It does not change macOS permissions or cancel unrelated model work. Permission setup continues to use the existing shared AppSnap flow.

## Verification, 12 September 2026

- Universal native helper compiled for arm64 and x86_64.
- Full workspace formatting, lint and seven-package typecheck passed. Lint reported warnings but no errors. Later fixes received scoped formatting, lint and typechecks.
- Focused regression coverage includes lazy startup, coalescing, helper retirement, stale Stop/error messages, terminal events during observations, read-only task cleanup, failed preview teardown, gateway permissions and invocation detection.
- The isolated Synara Dev instance ran a real Codex task that opened Calculator and produced `123 × 45 = 5535`. The preview helper started automatically during the task and was absent after completion.
- A subsequent read-only turn verified the rendered preview in a desktop screenshot: the panel showed Calculator, its expression and result, the task title and the Stop button. The helper also exited after that read-only turn. The explicit `Computer Use: …` prefix was exercised successfully after the invocation fix.
- One process sample during that task measured about 63 MiB RSS and 3.3% CPU for the preview helper. This is not a sustained benchmark or a comparison with Codex. The task deliberately waited 20 seconds, so its total duration is not an action-latency benchmark.

The implementation does not claim full parity with Codex. Physical Stop-button behavior, every macOS sharing-indicator transition, permission revocation and multi-display behavior still require dedicated native qualification. Provider-independent gateway wiring is covered, but the live provider test used Codex only.
