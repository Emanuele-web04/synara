# SynBot scenarios

End-to-end tests for SynBot (Beta) against a real, isolated Synara: real server, real WebSocket and
gateway, real web UI in a browser. The only fake is the model. A scripted ACP agent
(`fake-agent/`) poses as the Grok CLI, so every bot runs for free and the same way on every run.

```sh
npm install                  # once, inside this folder (not part of the Bun workspace)
npx e2e run                  # all scenarios, about 10 minutes
npx e2e run scenarios/delegation-direct.e2e.ts --headed
npx e2e run --config e2e.stable.config.ts   # the Stable gate, separate (about 1 minute)
npx e2e run --config e2e.cli.config.ts --output .e2e/cli   # a server with no desktop flavor (about 10 s)
npx e2e run --config e2e.stable-alto.config.ts --output .e2e/stable-alto   # about 4 minutes
npx e2e run --config e2e.beta.config.ts --output .e2e/beta
npx e2e run --config e2e.old-host.config.ts --output .e2e/old-host
```

Another run of this suite on the same machine shares the default scenario folder and wipes it:
give every concurrent run its own `SYNBOT_SCENARIO_DIR`.

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

## More flavors

Each runs its own isolated app in its own folder next to the default run's; keep them out of the
default run.

| Config                      | Starts                            | Scenarios      | Covers                                                                                                                  |
| --------------------------- | --------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `e2e.stable-alto.config.ts` | `start-app.ts --stable --alto-ui` | `stable-alto/` | Paywall signed out and on Free, View Alto plans, checkout and Refresh unlocking SynBot, cancellation, sign-out, offline |
| `e2e.beta.config.ts`        | `start-app.ts --beta`             | `beta/`        | Beta out of the box: no account, no billing                                                                             |
| `e2e.old-host.config.ts`    | `start-app.ts --old-host`         | `old-host/`    | A host built before SynBot (cross-version remote host)                                                                  |

- `--alto-ui` turns on the sandbox billing UI and puts `fake-account-switch.ts` in front of the fake
  Account API: it adds checkout links (a fixed Polar sandbox URL the page never loads; `window.open`
  is stubbed) and a network switch, `POST /__scenario/network {"up": false}`. The lapse scenarios
  wait out the server's 60 s Alto cache once each.
- `--old-host` puts `old-host-proxy.ts` (run with Bun) between the web app and the server. It
  renames every `bots.*` request to a method the server does not know, so the real server answers
  the way a host without those methods does. `POST /__scenario/mode {"renameBots": false}` makes it
  a plain pass-through (the control scenario).
- Every flavor's server finds `fake-gh/bin/gh` first on its PATH (`SYNARA_PATH_HYDRATED=1` keeps
  the login shell's PATH, and the real `gh`, behind it). Without `<state>/gh.json` it acts signed
  out; `scenarios/merge-proof.e2e.ts` scripts pull requests, checks and patches through it, and
  its `proof-app` project has a GitHub remote whose fetches go to a dead local port.

## Limits

- Desktop shell behaviour is not covered: notifications, Dock badge and menu.
- Timing is not realistic, because the fake agent answers instantly.
- A delegation that starts tasks reports once its bot's Hub wake (roll-up) turn has ended. That
  wake is dispatched on the automation scheduler's next tick, up to 60 s after the task ends, and
  the scenarios wait that long.
