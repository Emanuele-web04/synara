# SynBot scenarios

End-to-end tests for SynBot (Beta) against a real, isolated Synara: real server, real WebSocket and
gateway, real web UI in a browser. The only fake is the model. A scripted ACP agent
(`fake-agent/`) poses as the Grok CLI, so every bot runs for free and the same way on every run.

```sh
npm install                  # once, inside this folder (not part of the Bun workspace)
npx e2e run                  # all scenarios, about 10 minutes
npx e2e run scenarios/delegation-direct.e2e.ts --headed
npx e2e run --config e2e.stable.config.ts   # the Stable gate, separate (about 10 s)
```

## How it works

- `start-app.ts` starts the server and the Vite web app in a scratch folder
  (`$TMPDIR/synbot-scenarios`, or `SYNBOT_SCENARIO_DIR`). That folder holds the HOME, SYNARA_HOME
  and a disposable git repo. Every provider except Grok is disabled, and Grok's `binaryPath`
  points at `fake-agent/bin/grok`.
- Each scenario writes a script with `synbot.script({ rules })`. For every prompt, the fake agent
  runs the first rule whose regex matches. A rule's steps are `say`, `think`, `tool` (a real
  `synara_*` gateway call, such as `synara_bot_delegate`; `force: true` calls it even when the
  gateway does not offer it), `sleepMs` and `error`.
- `synbot.log()` returns what the fake agent saw: prompts, tool calls, results, cancels and
  process signals.
- Prompts include each bot's own context. Match bots with `You are <name>, a SynBot bot`. Match
  hand-offs with `SynBot delegation`, and reports with `SynBot report for work you delegated`.

## Stable gate

`e2e.stable.config.ts` runs `stable-gate/` against the Stable flavor
(`SYNARA_DESKTOP_BUNDLE_ID=com.emanueledipietro.synara`) in its own folder
(`<scenario folder>-stable`), with `SYNARA_ACCOUNT_URL` pointing at `fake-account.ts`, a local stand-in
for the Account API. The scenario switches billing between Free, Alto and an outage through
`POST /__scenario/billing`.

## Limits

- Desktop shell behaviour is not covered: notifications, Dock badge and menu.
- Timing is not realistic, because the fake agent answers instantly.
- A delegation that starts tasks reports once its bot's Hub wake (roll-up) turn has ended. That
  wake is dispatched on the automation scheduler's next tick, up to 60 s after the task ends, and
  the scenarios wait that long.
