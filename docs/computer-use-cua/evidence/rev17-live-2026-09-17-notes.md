# rev-17 live fixture tier, 2026-09-17 — notes (partial)

Certifying section: `report.live` inside `rev17-live-2026-09-17-report.json`
plus the fixture's own `rev17-live-2026-09-17-live-report.json` and
`rev17-live-2026-09-17-live-server.txt`.

## What this run certifies

- The fixture-only socket proxy admitted nothing outside the owned window:
  all five scope preflight refusals passed before server launch — wrong
  capability (`authority`), desktop capture (`desktop-capture`), foreign
  window (`foreign-window`), foreground input (`foreground-input`) and
  `clipboard`. `nativeSubmissions` stayed 0 for the whole run.
- The real production server (`apps/server/dist/index.mjs` built from this
  worktree, served with the bundled `dist/client` web UI) booted on an
  isolated `SYNARA_HOME` + loopback port 53062 under `ELECTRON_RUN_AS_NODE`,
  reached the `Synara running` readiness marker, and served the real web UI
  (verified `GET /` → 200 with the production HTML before teardown).
- The server's computer backend was wired to the GUI-owned trusted host
  through `SYNARA_CUA_HOST_SOCKET` → fixture proxy → external
  `CuaDriverHost` (same endpoint/capability as the other tiers).
- Graceful teardown: operator SIGTERM → fixture finished, server SIGTERM'd
  (no `serverForcedExit`, no SIGKILL), proxy sockets destroyed, port
  released. `serverExit.code: 1` is the server's interrupted-process exit
  code, not a fixture failure.

## What this run does NOT certify (operator scope)

The real-provider → approval-card → native-click round trip was not
exercised: it requires an interactive operator driving the visible web UI
(create thread → enable Computer → request the owned target → approve the
card) plus real provider credentials inside the fixture's isolated home,
and a paid model turn. None of that is fabricable headlessly and the
fixture by design never synthesizes a provider callback or approval.
The historically recorded equivalent (`live-provider-run-2`, fixture
rev 9 / build 18: Codex GPT-5.6, approval card, one admitted background
click) remains in `live-provider-*.json` in this directory; this rev-17
run re-certifies everything up to the credential boundary.

One anomaly worth noting: proxy call #7 (teardown) recorded
`"Computer operation cancelled. Input already dispatched may have taken
effect; do not replay."` with `effect: not-dispatched` — a server-side
request raced the shutdown ordering; it was not an input op and no input
was dispatched.

## Fixture fix applied in this run

`live.ts` readiness wait raised 300→1200 attempts (30 s→120 s): a cold
production boot here exceeds 30 s because `fixPath` probes candidate login
shells with a 5 s `execFileSync` timeout each (the user's `/bin/zsh -ilc`
times out per candidate) before the HTTP listener and `Synara running`
marker land. Run 1 (`fixture-run-live1`) hit the 30 s cap mid-boot with the
server healthy at "orchestration engine started"; the fix let run 2 reach
ready at ~40 s. Verified against a direct `node dist/index.mjs` boot under
the same env: `Synara running` at ~40 s.

## Provenance / launch path

- Worktree `/Users/devin/repos/synara-wt-certification` @98b86be0c +
  the `live.ts` window fix; fixture bundle rebuilt and re-installed to
  `~/Applications/Synara Cua Fixture.app` between runs.
- Server build: `bun run build --filter=@synara/cli` (turbo; also built
  `@synara/web` → `dist/client`).
- Same external trusted host as the other tiers
  (`com.synara.cua-fixture-external`, accessibility+screen_recording true
  through the host, pid chain responsible_ppid 56403).
- Launch: `open -g -n -W` with `SYNARA_CUA_FIXTURE_LIVE=1`,
  `SYNARA_CUA_FIXTURE_SERVER=…/apps/server/dist/index.mjs`, endpoint +
  capability env, foreground flags empty.
- Fixture pid 35036, owned target `cua:35036:516`
  (`Synara Cua Live Fixture 35036`), clicks 0, nativeSubmissions 0.

## Focus invariant

Frontmost app `ghostty` before the run, during server soak, and after
teardown (`frontmost-before.txt` in the run dir; post-run check identical).
The live fixture window was shown inactive; no operator UI was driven.
