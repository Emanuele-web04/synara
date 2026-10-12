# Production-app parallel-run acceptance

The app was built from tree `fcd0dd1ad77971e0a928766cb3624c71af5af25d`. The report pins the production component and records the generated SQLite rows and Git base. Chromium drives the real application over its normal connection; there is no replacement NativeApi, provider transport, or Git implementation. All providers are disabled so this check exercises the genuine failure path without sending a prompt outside the fixture.

Verified: draft promotion before launch; two independent worktrees at one base; explicit failed-start state; fresh comparison; keeping one attempt archives only its sibling; source, files and branches remain; real SIGTERM exits within fifteen seconds; final persisted SQLite state.

Reproduce from the repository root after building web and server:

```sh
SYNARA_CHROMIUM_PATH=/path/to/chromium node docs/verification/parallel-run-real-app-check.mjs
```

The four PNGs show launch, provider failure, comparison, and the selected attempt. `parallel-run-real-app-report.json` and `parallel-run-real-app-check.txt` retain the outcome. These captures do not establish successful live provider completion, multi-provider concurrency, or packaged desktop quit/restart.
