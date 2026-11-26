# New `/goal` shown as the sent message

Both images use the real ChatView browser-test fixture. The same idle Codex thread
submits `/goal Ship the 1.0.9 release: changelog, version bump and signed build`.

- `before.png`: `main` only saves the goal. The server then starts a hidden goal
  continuation turn, so the agent works with no message from the user in the transcript.
- `after.png`: `/goal …` appears as the user message, rendered with the existing
  `/goal` chip, before the agent works.

The server and provider are controlled fixtures. These captures were made for the
original client-side defer-and-send implementation: the fixture marked the session
running and projected its dispatched user message. The before capture reverted only
`useComposerSlashCommands.ts`; the temporary fixture was then removed.

The repaired implementation preserves that visible result with one server-owned
`start-with-message` goal command. Goal persistence, the bounded message, and its durable
turn intent commit together. Server integration tests verify materialization, message
binding, replay, and startup failure handling; the screenshots illustrate the visual
result and do not claim a live provider run.
