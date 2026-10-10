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
Linux has no macOS native tap. Its packaged host uses the existing still transport when its backend can
capture the selected target. Headless-browser mutations have separate verified
runtime and direct-X11 Escape requirements; still preview alone proves neither.
Packaged GUI behavior remains a qualification gate, and macOS native guarantees
do not apply to it.

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

## Failure visibility and known limits

- An explicit stream error or unsupported-source status opens the card before
  its first decoded frame. Connecting alone stays quiet. A user-dismissed card
  stays hidden for that task instead of reopening because an error arrives.
  This is not a promise that every native helper failure reaches the UI: native
  frame loss can still fall back to stills, and reconnecting can clear the
  current error status.
- Closing the card only hides it. Use chat Stop to end the task. Preview frames
  cannot authorize input or satisfy the fresh model-observation gate after
  Escape, human takeover or desktop interruption.
- Current packaged end-to-end behavior, other-Space targets, multi-display
  behavior, permission loss and sustained CPU/RSS still require qualification.
- Historical capture reports elsewhere in this directory apply to their named
  revision. They do not certify the current native driver or every provider.
