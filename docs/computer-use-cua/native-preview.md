# Computer preview

The current preview is a view-only card in the owning chat with a floating
presentation. It shows the exact native window or browser tab addressed by the
task, not the whole desktop. The former interactive dock Computer pane and its
expand/Stop workflow are retired.

## Sources

- On macOS, the AppSnap helper's computer-frames mode supplies a native
  window stream through computerFrameTap.ts. Capture is bounded to 960 pixels,
  15 frames per second and one encode in flight; frames drop instead of queuing.
- StillFramePublisher provides a platform-neutral window/tab PNG fallback.
  CuaComputerBackend.captureStill captures only the selected target. Its default
  cadence is one second, with an environment override. Browser preview keeps
  the bound target/tab identity.
- The renderer prefers fresh native frames and uses stills when native frames
  are unavailable. It retains the last decoded frame through temporary gaps.
  An absent target must not silently become a whole-desktop capture.

Preview frames are local UI feedback. They are not automatically included in
provider context; model screenshots are separate explicit tool requests.
Linux has no macOS native tap, but can use the existing still transport when a
working backend is supplied. That path still needs real Linux GUI validation.

## Ownership

computerPreviewStore.ts records per-thread phases:
armed, live, hidden-for-task and ended. Only live surfaces attach streams.
Hiding a preview does not stop the task. Task completion, target replacement,
host shutdown and helper death have separate cleanup paths. A failed native
target is not repeatedly respawned within the same task; a new target/task can
start a new stream.

The native helper is owned by thread, turn, PID and window identity. Socket
permissions and bounded frames isolate its transport. Helper lifecycle output
and image bytes use separate channels. These implementation boundaries are
covered by host, store and renderer tests; they do not replace packaged testing.

## Known limits

- Errors before the first decoded frame can remain hidden behind the current
  card visibility latch. The UI needs an observable persistent failure state.
- Current packaged end-to-end behavior, other-Space targets, multi-display
  behavior, permission loss and sustained CPU/RSS still require qualification.
- Historical capture reports elsewhere in this directory apply to their named
  revision. They do not certify the current native driver or every provider.
