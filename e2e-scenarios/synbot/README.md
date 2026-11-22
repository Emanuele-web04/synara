# SynBot scenarios

End-to-end tests for SynBot (Beta) against a real, isolated Synara: real server, real WebSocket and
gateway, real web UI in a browser. The only fake is the model. A scripted ACP agent
(`fake-agent/`) poses as the Grok CLI, so every bot runs for free and the same way on every run.

```sh
npm install                  # once, inside this folder (not part of the Bun workspace)
npx e2e run                  # all scenarios, about 10 minutes
npx e2e run scenarios/delegation-direct.e2e.ts --headed
npx e2e run --config e2e.stable.config.ts   # the Stable gate, separate (about 1 minute)
npx e2e run --config e2e.cli.config.ts      # a server with no desktop flavor, separate (about 10 s)
```

Set `SYNBOT_SCENARIO_DIR` to a folder of your own when another run may be going on: each run wipes
its folder.

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
`POST /__scenario/billing`, and counts the billing reads that reach it (`GET /__scenario/state`). A
second test checks that chats that are not bots and an idle server cost no billing read, that Stop
all still works after Alto lapses, that bot tools say `SUBSCRIPTION_REQUIRED`, and that an open
`bots.subscribe` stream ends on sign-out.

The default run names the Dev desktop flavor, where SynBot is free. `e2e.cli.config.ts` runs
`cli-gate/` against a server with no desktop flavor (as `npx synara` runs) in
`<scenario folder>-cli`: it requires Synara Alto like Stable.

## Limits

- Desktop shell behaviour is not covered: notifications, Dock badge and menu.
- Timing is not realistic, because the fake agent answers instantly.
- A delegation that starts tasks reports once its bot's Hub wake (roll-up) turn has ended. That
  wake is dispatched on the automation scheduler's next tick, up to 60 s after the task ends, and
  the scenarios wait that long.
