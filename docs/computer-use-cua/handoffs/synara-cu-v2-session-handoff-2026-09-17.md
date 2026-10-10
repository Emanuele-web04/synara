# Synara CU v2 — session handoff, 2026-09-17 afternoon

> Created 2026-09-17 by the session that followed
> `/tmp/synara-cu-v2-mega-handoff-2026-09-16.md` (master research doc, still
> current — this file only covers what happened AFTER it) and
> `/tmp/synara-cu-v2-exploration-2026-09-17.md`.
> Audience: the next agent Kartik hands this to.
> Standing orders from Kartik (still active): **no commits, no pushes.
> No approval-gated app launches without asking.** Everything below is
> uncommitted working-tree state.
> Kartik stopped the fixture/canary work on 2026-09-17 ~11:50; he will
> continue it himself later. Paths and exact commands below are ready to pick
> back up.

## State in one screen

- Clone `/Users/user/synara-computer-use`, branch
  `agent/computer-use-preview`, HEAD `e2a1deb06`, ahead of origin by the 3
  local rebase commits (PR #1227 still shows `bb7eb421c` on GitHub).
- Pipeline `cu-specs` (spec program): CLOSED, root ledger ALL MET.
- Pipeline `cu-belief` (belief canary): nodes 1.1 and branch 1.1 VERIFIED;
  live run and decision doc OPEN. Ledgers in `.unlazy/cu-belief/`.
- Pipeline `cu-fix3w` (three-window lane fix): G0–G4 green, **G5 still
  pending** (see below). Ledgers in `.unlazy/cu-fix3w/`.
- Unlazy ledgers live in `.unlazy/` (gitignored). Do not delete them; the
  next session can re-verify from them.

## What happened on 2026-09-17 (this session)

1. Verified the session handoff from the earlier agent against the repo:
   accurate. Lane fix, spec docs, evidence files all real.
2. Rebuilt `~/Applications/Synara Cua Fixture.app` from the current tree so
   the fixture bundle contains the uncommitted lane fix (the old bundle did
   not). The rebuild changed the cdhash; the old TCC grant no longer matches.
3. Ran the G5 fixture proof twice with the new bundle. Result: the three
   window case FAILS with the same shape as before — three empty fields,
   `route: accessibility`, `effect: unverifiable`, `escalation delivery_failed`.
   The lane fix serialized the writes (spans no longer overlap: 1.1s / 1.0s /
   1.1s) but the text still does not land. **The lane fix is necessary but not
   sufficient; a focus/active-state gate is the suspect.**
4. Built the belief canary (pipeline `cu-belief`):
   - `scripts/computer-use-fixtures/belief_probe.m` — posts one candidate
     belief stage per run (AppKit-defined events, CPS process notifications,
     SkyLight focus record). Dry-run verified; all six stages post cleanly.
   - `scripts/computer-use-fixtures/canary-main.ts` + `belief-canary.mjs` +
     `build-canary.mjs` — the canary app bundle (`com.synara.cua-canary`,
     staged at `~/Applications/Synara Cua Canary.app`).
   - First canary run was INVALID: every phase refused with
     `same_pid_keyboard_ambiguity` (no resolved AX element, so the semantic
     route never ran). The app was fixed to resolve the exact element, click
     the field, wait 1.5s after each belief post, and read back both ways.
     The fixed bundle is staged; **it needs a fresh TCC grant before the
     next run** (new cdhash `8be3e15e…`).
5. Space isolation groundwork (for "apps must not take me to Space 1"):
   - Verified on this Mac: Space listing works; your desktop Space is
     `ManagedSpaceID=5`, plus a fullscreen Space `875`.
   - `scripts/computer-use-fixtures/space_ctl.m` compiles and supports
     `list`, `windows --pid`, `window-spaces`. Verified read-back on a test
     window.
   - `move` SEGFAULTS and `add` returns garbage (ABI/signature wrong at the
     `SLSMoveWindowsToManagedSpace` / `SLSAddWindowsToSpaces` call sites).
     Fix before using. All operations are reversible.
   - Confirmed fix: launch agent apps with `open -g -n` (suppresses
     activation and Space switch). Verified — frontmost stays unchanged, and
     this is now the standard fixture/agent launch form.
6. TCC landmine (learned the hard way): every rebuild changes the cdhash, so
   Accessibility + Screen Recording grants must be removed and re-added in
   System Settings. The stale entry does not match the new build; toggling is
   not enough, remove then add.

## Your job (pick-up list)

1. **Grant the canary app** (once): System Settings → Privacy & Security →
   Accessibility → + → `~/Applications/Synara Cua Canary.app`; same for
   Screen Recording. Then run:
   ```sh
   cd /Users/user/synara-computer-use
   node scripts/computer-use-fixtures/build-canary.mjs      # canary build ok
   node scripts/computer-use-fixtures/belief-canary.mjs --check
   rm -rf /private/tmp/synara-cua-implementation/canary-run-1
   open -g -n -W -a "$HOME/Applications/Synara Cua Canary.app" \
     --env SYNARA_CUA_CANARY_DIR=/private/tmp/synara-cua-implementation/canary-run-1
   ```
   Read the report: `report.json` → `summary` is the first phase whose exact
   text landed, or `none-passed`. The six stages are catalogued in
   `docs/computer-use-cua/belief-canary-runbook.md`.
2. **If the canary passes on some stage**: that signal is the sidecar's
   synthetic-focus mechanism; wire it per `option-c-sidecar-spec.md` and
   re-run the three-window fixture case (G5 in `.unlazy/cu-fix3w/GATES.md`).
3. **If `none-passed`**: belief alone is insufficient for Electron; the next
   rungs are (a) masked activation (raise user windows to level 25, activate
   target behind them, deliver, restore — spec section 3), and (b) synthetic
   event delivery with verified readback. Also revisit whether the server
   should use the driver's synthetic route with a settled readback instead of
   AX insertion for Electron.
4. **Fix `space_ctl` move/add ABI** (the `open -g -n` launch form already
   stops the Space switch and is now standard) so agent apps stop switching
   Kartik's Space. Acceptance: launch an app while he is fullscreen in
   another Space; his Space must not move.
5. **G5 cert run** for the lane fix, once the typing mechanism works:
   `.unlazy/cu-fix3w/GATES.md` G5 + `three-window-semantic-fix-spec.md`
   acceptance (10x repeat, zero fixture-window focus samples — the fixture
   app must never hold OS focus).

## Landmines (learned, do not relearn)

1. NEVER direct-exec the fixture binary on Kartik's Space (it steals focus
   and switches Spaces). LaunchServices only, and ask before launching.
2. `open -a` launches vs direct exec produce different screenshot/capture
   behavior; record the launch path in every notes file.
3. Every fixture/app rebuild invalidates TCC grants (cdhash changes). Remove
   the stale entry and re-add in System Settings.
4. Repo formatter is `oxfmt` (`bun run fmt`), NOT prettier.
5. `*.log` is gitignored: evidence console output must be `.txt`.
6. The queue's nested-scope key check forbids same-pid lane keys at Manager
   level; the lane lives in the backend for that reason. Do not "simplify".
7. Gate approvals live in `~/.unlazy/approved`; every `gate-check` needs
   `--cwd /Users/user/synara-computer-use`.
8. `scripts/computer-use-fixtures` is excluded from the turbo typecheck
   projects (TS6307 otherwise); typecheck it with an isolated tsc config.
9. The canary must pass a resolved `{ target, node, point }` to typeText, or
   the driver refuses with `same_pid_keyboard_ambiguity`.
10. Subagent threads on Synara work run on `opencode-go/deepseek-v4.1-flash#max`.

## Open decisions for Kartik

- Run the canary himself (grant + launch) or hand to the next agent.
- Same-pid serialize vs true-overlap (lane fix is in the tree, uncommitted).
- Certification route; when to commit/push; open-source boundary; cursor
  identity; Chrome revisit trigger. (Recommendations live in the specs.)

## Artifact index (paths, not copies)

- Research master: `/tmp/synara-cu-v2-mega-handoff-2026-09-16.md`
- Exploration record: `/tmp/synara-cu-v2-exploration-2026-09-17.md`
- Specs (8, all in `docs/computer-use-cua/`): `v2-parity-matrix.md`,
  `option-c-sidecar-spec.md`, `three-window-semantic-fix-spec.md`,
  `workstream-b-scroll-spec.md`, `workstream-c-speed-spec.md`,
  `workstream-d-parity-spec.md`, `workstream-e-reliability-spec.md`,
  `workstream-f-opensource-spec.md`
- Canary docs: `docs/computer-use-cua/belief-canary-runbook.md` (built);
  `docs/computer-use-cua/belief-canary-2026-09-17.md` (decision doc, NOT yet
  written — awaits the live run)
- Evidence: `docs/computer-use-cua/evidence/rev15-electron-2026-09-17-*`
  (report.json, console.txt, notes.md, 5 PNGs); canary runs live under
  `/private/tmp/synara-cua-implementation/canary-run-*`
- Fix: `apps/server/src/computer/CuaComputerBackend.ts` (lane) +
  `CuaComputerBackend.test.ts`
- Canary components: `scripts/computer-use-fixtures/{belief_probe.m,
build-canary.mjs, canary-main.ts, belief-canary.mjs, space_ctl.m,
build-space-ctl.sh}`
- Ledgers: `.unlazy/cu-specs/`, `.unlazy/cu-fix3w/`, `.unlazy/cu-belief/`
- Approvals: `~/.unlazy/approved/` (do not touch)
- Apps: `~/Applications/Synara Cua Fixture.app` (rebuilt, ungranted, lane
  fix inside), `Synara Cua Fixture.app.bak-2026-09-17` (old granted build),
  `Synara Cua Canary.app` (fixed build, awaiting grant)

---

## Correction, 2026-09-17 (later same day, appended)

The handoff above is left as written. Several "still pending" items have
since been resolved on this machine; the current state is:

- **G5 is closed.** The three-window semantic-text fixture passes: web
  content `typeText` composes `existing + text` through `set_value` and
  re-reads independently; 10 consecutive green runs with sentinel focus
  held. Evidence:
  `docs/computer-use-cua/evidence/fixture-g5-set-value-2026-09-17-notes.md`.
- **The belief canary question is answered without the live run:** no
  synthetic stage is needed. `AXValue` writes are already focus-neutral on
  Electron, and `delivery_mode=foreground` performs the short-lived
  activate-and-restore natively. The Option-C sidecar reduces to optional
  theft sampling; do not wire belief stages.
- **Scroll v2 landed** in commit `78bc88bae` (native rev 16): two axes
  plus held modifiers in one pixel-unit wheel gesture, AX scrollbar
  preference for unmodified vertical element scrolls, macOS before/after
  measurement inside a 2-leg/3-capture budget, and route-keyed gearing
  with a durable per-app file. Verified live on TextEdit both directions.
  TextEdit ignores horizontal wheel deltas, an NSScrollView limitation,
  not a refusal.
- **The milestone tools shipped** in `7eeb083d4`: `computer_list_apps`,
  `computer_verify_state`, `computer_zoom`, `computer_set_window_frame`,
  `computer_invoke_menu`, `computer_kill_app`. Agent-facing tool count is
  31 at rev 16, adding `computer_get_accessibility_tree` and
  `computer_get_cursor_position`.
- **`space_ctl` update:** move/add are not merely mis-ABI'd. The SLS
  move/add/compat-id calls are silent no-ops on foreign windows under SIP
  on this VM, and `SLSSpaceCreate` produces orphaned type-3 spaces that
  `SLSShowSpaces` never attaches to a display. Space work is in progress,
  blocked at display-attach; moves are SIP-gated. Neither "solved" nor
  "impossible" is proven.
- **`open -g -n -a` is verified**: it launches without stealing focus or
  switching Spaces. `open -n -a` steals focus; the fixture launch line
  using it is a known bug being fixed separately.
- **Commits exist now.** The no-commit standing order above applied to
  that session; the milestone and scroll work landed on the branch as
  `7eeb083d4` and `78bc88bae`.
