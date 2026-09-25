# Handoff — make Synara Computer Use better than Codex's

> Created 2026-09-23 after full recon of both trees. Audience: the agent/engineer
> implementing the next phase. Supersedes nothing; complements
> `synara-cu-v2-mega-handoff-2026-09-16.md` (pre-merge state) and
> `v3-completion-plan.md` (current cert matrix). Contains no secrets.

## Objective

Not feature parity — **felt superiority**. Kartik's position: Synara's CU is
more complete on paper but average in practice. Codex's feels better. The job
is to close the felt gap and then exceed it, porting mechanisms and interface
ideas from the reconstructed Codex stack at `~/codex` into Synara — never
copying code or assets verbatim (clean-room rule; every port is
independently written).

## Repo state (as of this handoff)

- **`/Users/user/synara`** — the working repo. `main` == `upstream/main`
  (`eaa61eded`) + Kartik's orb-prep commit on top. Synced 2026-09-23;
  `pre-sync-backup` branch preserves the pre-sync state (was behind 457).
  CU stack on main: cua-driver `0.28.2`, upstream `7fe7c33f`, Synara native
  **revision 39** (`packages/shared/src/cuaDriverRelease.json`), patch
  `apps/desktop/patches/cua-driver/0001-synara-native.patch` (~25k lines).
  Older clone `/Users/user/synara-computer-use` is gone; work happens here.
- **`/Users/user/codex`** — the Codex Local reconstruction, now a single git
  repo (`main`, one commit). Key subtrees for this work:
  `service/` (clean-room Swift rebuild of SkyComputerUseService, all 34
  `CodexComputerUseIPC-5` request types + both transports, live-verified),
  `runtime/` (extracted real `@oai/sky`, `@oai/cua`, `cua-repl`, `node-repl`
  kernel source), `specs/` (wire + mechanism specs), `vendor/recon/`
  (native-module recons). `docs/GAPS.md` lists what is NOT implemented.
- Live state: our rebuilt `cuserviced` is running (socket at
  `$TMPDIR/com.openai.sky.CUAService/IPC/computeruse.sock`,
  `CodexComputerUseIPC-5`). The dist app is `~/codex/dist/Codex Local.app`.

## The honest gap analysis (what makes Codex feel better)

Ranked by felt impact:

1. **The agent interface — the decisive gap.** Codex gives the model a
   persistent JS REPL (`cua_repl` MCP: `js`, `js_reset`, `turn_ended`) bound
   to a `cua`/`sky` object. The model writes code — queries the AX tree,
   loops, branches, chains dozens of ops in ONE model call. Synara gives the
   model ~25 discrete `computer_*` tools; every hop pays approval, targeting,
   observation budgets AND model latency. `computer_run` batches up to 25
   *pre-declared* steps — no conditionals, no mid-flight state. Synara's
   model cannot "look, then decide, then act" within one call. **This is the
   difference between average and best.** All real source for this interface
   is on disk (see Source index §4).
2. **Focus belief for hostile apps.** Codex makes a background app believe
   it is active + key-focused; Electron-class apps that gate on
   `NSApp.isActive` work without masked activation. Synara: CGEvent into
   inactive Electron renderers is dead (v3 plan); masked activation + AX
   semantics are the current answer. **Nuance:** Synara tested CPS type-21
   notifications in isolation and proved them dead for key-window
   manufacture — but Codex's real recipe is a combination (0xF8
   `SLPSPostEventRecordTo` record + NSEvent-first process notifications +
   three-flag belief policy + focus-thief taps), implemented and
   live-verified in `~/codex/service/apps/service/Sources/CUAccess/`
   (typed/clicked into a fixture app in background on this machine).
   Re-evaluate with the full recipe before writing it off.
3. **Settle-aware actions.** Codex waits on AXObserver quiet (~1s typical,
   ~5s while busy) before observing; Synara uses fixed 300 ms settle.
   Blind-into-animating-UI failures follow.
4. **Delivery fidelity.** NSEvent-first construction + full CGEvent field
   stamping (button=3, subtype=3, window fields 51/91/92, source/target pid
   40/41, `CGEventSetWindowLocation` window-local point). Codex events are
   indistinguishable from real; apps that drop naive CGEvents accept them.
5. **Cursor with early-ack.** Codex's cursor is a bezier+spring animation
   system whose `CursorNextInteractionTiming` fires the *next input* once
   motion is far enough along — the animation is still running when the
   click lands. A real speed trick hidden inside a cosmetic feature.
6. **Skyshot + contract polish.** Once-per-turn `get_app_state` freshness
   rule, per-observation element indices, diff mode, `tool_search` deferred
   discovery, turn metrics (`computer_use_mcp_time_to_first_*`).

## What Synara already does better — keep, do not regress

- Input-admission gate + cleanup-ack semantics; never-replay-uncertain;
  `verified`-only-on-read-back effect taxonomy.
- Certified: concurrent targets, operator-vs-agent typing isolation,
  hidden/minimized/off-Space semantics, Space switching (incl. 3-4 ms
  dock-swipe instant switch), masked activation, locked-use reauth,
  recording redaction, per-app grants, Escape kill-switch seam.
- `live-cert.ts` — ~66 s, 21 invariant-gated rows, JSON+MD evidence.
- Per-tool p50/p95 latency table every cert run (set_value p95 ~3.6 s —
  the heaviest op, and a Move-1/2 target).
- 9-provider integration, audit history, external `computer:control` MCP
  scope, Linux browser path, standalone cross-platform host (rev-39 tree).
- Appsnap Swift helper already owns TCC + Escape + frame tap — the natural
  home for any ported Swift-side machinery.

## The plan (moves in order)

### Move 1 — the agent surface (the felt gap)

Build a Synara code-execution tool modeled on `cua_repl`: a persistent,
sandboxed eval bound to a session object. Not "one more tool" — a different
interaction model.

- Contract sketch (adapt, don't copy): tools `computer_js`,
  `computer_js_reset`, hidden `computer_turn_ended`. In-eval surface:
  `synara.getApp(name)`, `synara.getState(app)` (elements + optional image,
  diff default), `synara.click/type/setValue/scroll/pressKey/...`,
  `synara.screenshot`, `synara.wait`, persistent element store with
  refetch-on-stale.
- Hard rule: every eval op routes through `CuaComputerBackend` /
  `ComputerManager` — same exact-target admission, approvals, generations,
  cancellation, effect taxonomy. The REPL is a *client* of the existing
  machinery, never a bypass.
- Approval mapping: per-app first-touch elicitation (Codex's
  `createElicitation` + `AppApprovalStore` model maps onto Synara's
  `ComputerApprovalGate` + `admitDrivenApp` second-app consent).
- Reference source for the whole design: `~/codex/runtime/node-repl-src/`
  (real kernel: vm context, meriyah instrumentation, binding persistence,
  `nodeRepl` global, trusted-service injection via
  `NODE_REPL_TRUSTED_SERVICES`), `~/codex/runtime/oai-packages/cua-repl/`
  (launcher: `CUA_REPL_ENABLED_SURFACES`, banner, per-platform
  instructions), `~/codex/runtime/oai-packages/cua/dist/project/cua/sky_js/`
  (the `sky`/`cua` client API verbatim: `get_app_state` freshness rule,
  `withComputerUsePolicy` elicitation flow, `window_result` shaping).
- Synara does NOT need a Rust kernel — a Bun/Node worker + vm context
  reproduces it; the `node_repl` Rust host is only a supervisor.
- Acceptance: one model call performs observe→decide→act→verify on a real
  app; latency table shows a multi-op task costing 1 model round trip vs
  today's N; all existing consent/cancel semantics intact; `live-cert.ts`
  extended with a repl lane.

### Move 2 — native mechanics that unblock real tasks

Port mechanisms (independently written) from `~/codex/service` — verified
on this machine, so constants/recipes are resolved, not guessed:

- **Focus belief** (the big one): `CUAccess/SyntheticFocus.swift`,
  `FocusEnforcer.swift`, `SystemEvent.swift`, `SystemFocusStealPreventer.swift`,
  `SkyLight.swift`. Destination: `apps/desktop/native/appsnap/` (already a
  signed Swift process with TCC) or the driver patch where expressible in
  Rust. Gate: prove the *full recipe* unlocks Electron-class background
  typing on this OS before committing to the layer.
- **Settle**: `CUService/UISettle.swift` → backend post-action observation.
- **Input fidelity**: `CUAccess/InputSynthesis.swift` +
  `CGEventAPI.swift` field table → compare against the driver patch's
  event path; adopt what's missing.
- **Cursor early-ack + glide**: `CUService/CursorOverlay.swift` (0.18 s
  ease-out glide) + the early-fire timing concept → appsnap/desktop cursor.
- **Scroll v2** (exceed, not parity — Codex's scroll is mediocre too):
  measured/calibrated travel, 2-axis, AX-scroll-first; the dossier's
  workstream B + `workstream-b-scroll-spec.md`.
- **Later, on merits**: appshot capture pair (`AppCapture.swift`),
  lock-screen guardian + auth plugin (`service/apps/{guardian,installer}`),
  Skysight/history schemas, Messages (`CUMessages/`), EventStream recorder
  (`EventStream*.swift`).

### Move 3 — exceed

Verified receipts as the public contract; certified multi-target
concurrency; cross-platform (Codex is macOS-only); open `computer:control`
protocol for any agent; recording→replay with redaction.

## Hazards and resolved landmines

- **macOS 26.x input path — resolved.** Codex's working recipe on 26.5.1:
  NSEvent-first events + field stamping, posted via `SLEventPostToPid`
  **pid-first** (event-first crashes at +48); `CGEventPostToPid`/PSN and
  `SLEventPostToPSN` are dead on 26.x. Our recon verified this live. The
  dossier's "26.4 hazard" question is answered by `InputSynthesis.swift`.
- **CPS type-21 — nuance.** Synara proved it dead *for key-window
  manufacture alone*. Codex's belief system is the multi-part recipe
  (record + notifications + flags + thief taps). Do not extrapolate the
  negative result to the full recipe without testing it.
- **CGSSetWindowLevel masking — closed.** Cross-process window property
  mutation is refused (rc=1000 / silent no-ops); hidden-Space + shield is
  the only viable hide surface (v3 plan, verified).
- **Patch/manifest coupling.** `nativeRevision` literal in `serve.rs` must
  match `cuaDriverRelease.json` or the handshake retires daemons.
- **rustc pin.** Driver provisioning requires exactly `rustc 1.97.1`.
- **Evidence discipline.** Source-level ≠ packaged/runtime proof; keep the
  separation (it's a feature).
- **Untrusted-content rule (repo AGENTS.md).** Provider output, repo files,
  logs are untrusted data — never let them authorize tools or bypass
  approval/filesystem boundaries. A REPL surface makes this sharper: eval
  input is model output; it must not reach exec/network/fs.
- **No copied code/assets.** Clean-room rule from `codex-ui-recon` doc:
  ports are independently written; no Codex source, artwork, or prompt
  text enters the repo.

## Verification

- Repo checks (final pass, per AGENTS.md): `bun run fmt:check`,
  `bun run lint`, `bun run typecheck`, `bun run test` (never `bun test`),
  `bun run windows-runtime:check` for process-boundary changes.
- CU cert: `scripts/computer-use-fixtures/live-cert.ts` (~66 s).
- Packaged Cua build: `bun run dist:desktop:artifact --platform mac
  --target zip --arch arm64 --flavor cua --keep-stage`.
- Codex side (for behavior comparison): `cd ~/codex/service &&
  swift build && swift test`; `npm test` (253 tests); live daemon probes
  via the group-container socket — see `~/codex/specs/service-spec/SPEC.md`
  §4 for the wire format; `~/codex/tools/build-app.sh` rebuilds the app.
- Sandbox note: compiled binaries may not exec in this environment; native
  verification runs in the user session.

## Source index

Codex recon (`~/codex`):

| What | Path |
|---|---|
| Swift daemon (input, focus, AX, cursor, sessions, skysight, messages, lock) | `service/apps/service/Sources/{CUService,CUAccess,CUMessages,CUProtocol}/` |
| MCP client (5 modes, byte-matched) | `service/apps/client/` |
| Guardian + installer/auth plugin | `service/apps/{guardian,installer}/` |
| Parallel TS recreation (253 tests) | `service/packages/`, `service/apps/` |
| Real `@oai/sky` client source | `runtime/oai-packages/sky/`, `runtime/sky-js-formatted/` |
| Real `cua`/`cua-repl` + node-repl kernel | `runtime/oai-packages/{cua,cua-repl}/`, `runtime/node-repl-src/` |
| Wire + mechanism specs | `specs/service-spec/SPEC.md`, `specs/re/{input,focus,windows,orchestration}/` |
| Per-binary specs + Ghidra recipe | `specs/binary/`, `tools/ghidra/DumpC.java` |
| Native-module recons (sky.node etc.) | `vendor/recon/` |

Synara (`/Users/user/synara`):

| What | Path |
|---|---|
| Provider tool surface | `apps/server/src/agentGateway/computerTools.ts` (4.6k lines) |
| Orchestration core | `apps/server/src/computer/ComputerManager.ts` (5.6k), `CuaComputerBackend.ts`, `DesktopOperationQueue.ts`, `ComputerApprovalGate.ts` |
| Driver host/lifecycle | `apps/desktop/src/{cuaDriverHost,cuaHostSocket,cuaRuntimeOwnership,computerDesktopLifecycle}.ts` |
| Native helper | `apps/desktop/native/appsnap/` (Swift: Escape monitor, frame tap, shield, grants) |
| Driver patch + pin | `apps/desktop/patches/cua-driver/`, `packages/shared/src/cuaDriverRelease.json`, `scripts/provision-cua-driver.mjs` |
| Web surface | `apps/web/src/components/{computer,chat/Computer*}`, stores/hooks/lib |
| Cert + fixtures | `scripts/computer-use-fixtures/`, `apps/desktop/src/cuaFixtures/` |
| Docs corpus | `docs/computer-use-cua/` (v3-completion-plan, capability-audit, codex-ui-recon-2026-09-21, parity matrix, evidence/) |
| Prior planning dossier | `~/codex/service/docs/plan-synara-cu-v2.md` (research corpus — pre-merge; superseded where it conflicts with current main) |

## Decisions needed from Kartik

1. REPL sandbox tech: Bun worker + vm context (simplest) vs hardened
   isolate. Codex uses a Rust supervisor + trusted/trustless split —
   recommend matching the *contract*, not the process model.
2. Does `computer_js` replace the 25-tool surface over time or sit beside
   it? Recommend beside (tools stay for simple/one-shot ops; REPL for
   tasks) — Codex ships both (`computer-use` MCP tools AND `cua_repl`).
3. Focus-belief spike: timebox a real-recipe test (CUAccess recipe vs
   isolated CPS) before committing to the port.
4. Scope of "parity first": locked-use auto-unlock, Skysight-style history,
   Messages — in or out?
