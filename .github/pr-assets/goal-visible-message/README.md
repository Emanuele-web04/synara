# New `/goal` shown as the sent message

Both images use the real ChatView browser-test fixture. The same idle Codex thread
submits `/goal Ship the 1.0.9 release: changelog, version bump and signed build`.

- `before.png`: `main` only saves the goal. The server then starts a hidden goal
  continuation turn, so the agent works with no message from the user in the transcript.
- `after.png`: the goal is saved with `goalStartBehavior: "defer"` and `/goal …` is sent
  as the user message, rendered with the existing `/goal` chip, before the agent works.

The server and provider are controlled fixtures: after the send, the capture marks the
session running and, after the fix, projects the dispatched user message, standing in for
the real server. The before capture reverted only `useComposerSlashCommands.ts`. The
temporary capture fixture was removed after both runs.
