# Provider handoff refusal evidence

The screenshots use the real ChatView browser-test fixture. A settled Codex plan
is followed up with Claude selected while background tasks remain active.

- `before.png`: the original PR head also creates a red terminal thread error.
- `after.png`: the repaired branch keeps the existing stop-or-wait notice, preserves
  the pending plan, and does not save the target interaction mode before handoff.
- `after.webm`: actual Chromium footage of the passing refusal test. Recorder startup
  was trimmed, letterboxing cropped, and playback slowed to half speed for review.

The before capture restored the original five runtime files; the test failed for the
extra terminal error as expected. The verified candidate was restored afterward.
The server/provider are controlled fixtures; this is not live authenticated handoff.
