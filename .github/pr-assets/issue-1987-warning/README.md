# Codex thread warning visibility

Both images render the production `MessagesTimeline` component in Chromium with the
same completed assistant message and controlled thread-level warning data.

- `before.png`: the prior unmapped event is filtered from the turn-scoped transcript.
- `after.png`: the mapped, redacted warning remains visible after the reply, outside
  the collapsed turn details, using the existing runtime notice renderer.

The capture runs the real work-log filter and row renderer. It does not exercise an
authenticated Codex process. Adapter tests cover protocol mapping, approval-noise
filtering, canonical payloads, redaction and native log retention. Separate work-log
and timeline tests cover visible-turn filtering and completed-turn folding.

The temporary capture fixture was removed after the two passing Chromium cases.
