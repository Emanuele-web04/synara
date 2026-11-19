# SynBot scenarios

End-to-end tests for SynBot (Beta) against a real, isolated Synara: real server, real WebSocket and
gateway, real web UI in a browser. The only fake is the model. A scripted ACP agent
(`fake-agent/`) poses as the Grok CLI, so every bot runs for free and the same way on every run.

```sh
npm install                  # once, inside this folder (not part of the Bun workspace)
npx e2e run                  # all scenarios, about 8 minutes
npx e2e run scenarios/delegation-direct.e2e.ts --headed
```

## How it works

- `start-app.ts` starts the server and the Vite web app in a scratch folder
  (`$TMPDIR/synbot-scenarios`, or `SYNBOT_SCENARIO_DIR`). That folder holds the HOME, SYNARA_HOME
  and a disposable git repo. Every provider except Grok is disabled, and Grok's `binaryPath`
  points at `fake-agent/bin/grok`.
- Each scenario writes a script with `synbot.script({ rules })`. For every prompt, the fake agent
  runs the first rule whose regex matches. A rule's steps are `say`, `think`, `tool` (a real
  `synara_*` gateway call, such as `synara_bot_delegate`), `sleepMs` and `error`.
- `synbot.log()` returns what the fake agent saw: prompts, tool calls, results, cancels and
  process signals.
- Prompts include each bot's own context. Match bots with `You are <name>, a SynBot bot`. Match
  hand-offs with `SynBot delegation`, and reports with `SynBot report for work you delegated`.

## Limits

- Desktop shell behaviour is not covered: notifications, Dock badge and menu.
- Timing is not realistic, because the fake agent answers instantly.
- A delegation that starts tasks reports 60 s after its last task, and the scenarios wait that
  long.
