# Synara Computer Use V2 - Mega Handoff & Research Dossier

> **Created:** 2026-09-16, evening (local), by Kartik's agent (Aside session `I0UdxznQh9nis05h`), following the `handoff` skill (saved to the OS temp dir).
> **Purpose:** one self-contained document with everything learned and researched so far about the Synara Computer Use effort, the macOS background-control research, the current implementation, and exactly how to continue.
> **Audience:** the next agent or engineer picking this up.
> **Working basis:** branch `agent/computer-use-preview` @ `e2a1deb06` (2026-09-17; rebased driver, native revision 15) at PR `kartikkabadi/synara#1227` targeting `Emanuele-web04/synara`, clone at `/Users/user/synara-computer-use`.
> **Mode right now:** planning and research only. Kartik explicitly asked for "really good plans and stuff", not implementation, from this assistant. If you are the implementing agent, sections 5-8 are written for you.
> **Redaction:** contains no secrets, tokens, or credentials.

---

# UPDATE 2026-09-17 (read this first)

> The 09-16 dossier below is still the research and architecture reference. This block says what
> changed, what is decided, what is proven, and what to do next. Where the two disagree, this
> block wins.

**State in one screen**

- Clone `/Users/user/synara-computer-use`, branch `agent/computer-use-preview`, HEAD `e2a1deb06`, tree clean.
- Three local commits on top of `bb7eb421c`, **not pushed**: PR #1227 still shows `bb7eb421c` on GitHub.
  - `25850f947` build(cua): rebase native driver patch onto 0.28.2
  - `52300a0b4` fix(computer): update Cua version copy to 0.28.2
  - `e2a1deb06` docs(computer): record the 0.28.2 driver rebase
- Driver pin is now **cua-driver 0.28.2**, source `fc188250b4ca8549b8e61f937fdb1fb560770e86`, **native revision 15**, patch sha `94261ed9...`, upstream binary archive sha `386db225...`, Rust 1.97.1 (`libs/cua-driver/rust/rust-toolchain.toml` pins it; rustup already has that toolchain).
- `node_modules` removed again. `bun install --frozen-lockfile` restores in ~8 s. Before `bun run typecheck`, run `bun run postinstall` inside `apps/marketing` once; it generates the gitignored `.source` the typecheck needs.
- Checks after the rebase: typecheck pass (7/7), lint 0 errors / 630 warnings, fmt:check pass, tests 5,751 pass / 1 fail / 20 skip. The one failure is pre-existing: `apps/server/src/codexAppServerManager.test.ts:97` expects "Split the script when new page state requires inspection", but `packages/shared/src/browserAutomationCatalogue.ts:103` now says "Split when new state needs inspection or a human decision". The stale phrase exists only in the test, also at `bb7eb421c`. One-line test fix, awaiting Kartik.
- **Standing rule: no implementation, no push, no PR update until Kartik explicitly says go.**
- Quick sanity check (five seconds): `shasum -a 256 apps/desktop/patches/cua-driver/0001-synara-native.patch` must equal `patchSha256` in `packages/shared/src/cuaDriverRelease.json`.

**Decisions made (Kartik, 2026-09-17)**

1. Engine strategy is **option C**: keep the patched Rust `cua-driver` and add a thin native Swift sidecar for the Codex-style synthetic focus/event work (09-16 section 5.1). No Swift rewrite.
2. Milestone-one parity includes **menus and window frames**; the Chrome debug/CDP path is **deferred** (Kartik answered "Yes" to the scope question; this is the working reading of that answer, confirm at kickoff).
3. The driver **rebase is done** (this update). Everything else stays planning-only until he says start.

**Open questions from 09-16, now closed or corrected**

- **6.6-1, macOS 26.4 `SLEventPostToPid` hazard: not reproducible on this Mac (26.5.1).** Tested the driver's exact call pattern (mouse and HID-source keyboard, AX-trusted caller, real GUI pid): calls return SkyLight error codes and never crash. Keep the canary (probe script in the findings doc, section 3) before any OS bump; do not build a PSN fallback yet.
- **6.6-2, CPS constants: resolved from Codex's shipping binary** (`SkyComputerUseService`, build 26.913.1001067). Process-notification NSEvent type 21; `NewFront 0x0002`, `LostKeyFocus 0x1000`, `KeyFocusTaken 0x4000`, `KeyFocusReturned 0x8000`, `KeyFocusChanged 0xF102`, `LostTypingFocus 0xF105`, `TypingFocusChanged 0xF107`. `notifyWindowKeyFocusRemoved` posts `KeyFocusTaken`; app activate/deactivate use NSEvent type 13 with subtype 1/2 and `0xC0000` modifiers when a window id is known. The `cua-rs-mcp` table matches Codex; the Operon table is mislabeled.
- **Codex `SetFrontProcess` claim: the binary has it.** `SystemSoftware.ApplicationRegistrySPI` wraps `setFrontProcess(windowID:options:)`, `getKeyFocusProcess`, `releaseKeyFocus`, resolved via dlsym. The 09-16 note that Codex may not use it is wrong.
- **Upstream drift: our pin was 0.24.0 (2026-09-07); upstream is 0.28.2 (2026-09-15).** Ten commits touched macOS driver code. Inherited in the rebase: #2907 click delivery, #3704 cursor overlay excluded from foreground verification, #3687 embedded-host link fix, #3616 snapshot identity, #3404 browser checkbox. Still **open upstream, not shipped**: #3842 (AX read-back settle), #3897 (text outcome uncertainty), #3804 (scroll amount on the keystroke path). Full table in the findings doc, section 7.
- **Correction:** PR #1227 is 504 files / +96,594 / -2,184 and 92 commits ahead of `origin/main` (`dd88d9272`), not 652 files / +104k.
- **Correction:** the manifest `sha256` is the upstream **binary release archive** (`cua-driver-rs-<version>-darwin-universal-binary.tar.gz`), not a git archive. Documented in `docs/computer-use-cua/README.md`.

**What the rebase changed, so nobody re-derives it**

- Conflicts were only 6 files / 12 hunks: `input/mouse.rs` (7), `tools/click.rs`, `tools/set_value.rs`, `tools/type_text.rs`, `cursor/overlay.rs`, `cua-driver/src/serve.rs`. Everything else merged clean.
- `MousePostMode::Both` now means one SkyLight-first post (Synara's single-transport rule); upstream's `PublicOnly` is used for foreground clicks. New helper `click_at_xy_native_with_window_local` keeps the non-Chromium synthetic background recipe. Synara's cancellation-gate wrapping, `semantic_only` lease selection and pid-less `set_value_blocking` are preserved.
- Full resolution record: `apps/desktop/patches/cua-driver/README.md` (Revision 15) and the findings doc, section 8.
- To redo or extend the rebase: the findings doc, section 8, has the method (blobless clone with sparse checkout, materialize both tags, per-file three-way merge, bump the `serve.rs` literal, regenerate the patch, verify with `patch -p1` and `cargo build`).

**Proven vs not proven**

- Proven: the patch applies to a pristine 0.28.2 tree and reproduces the rebased tree byte for byte; `cargo check` and a release `cargo build` pass; the binary reports `cua-driver 0.28.2`; manifest/patch/fetch consistency checks pass; repo checks above.
- Not proven (the certification gap): rev-15 runtime behavior on real apps. Three concurrent provider targets, human foreground focus isolation, off-Space semantic text, screenshot freshness refusals, hidden/minimized refusals. There is still no focus-theft instrumentation in the code, and the CPS typing-focus values (`0xF105`/`0xF107`) are untested behaviorally.
- The 09-16 "Explicitly unproven" list in section 3.1 stays valid, now at revision 15 instead of 14.

**Tomorrow, in order**

1. Do nothing implementation-wise until Kartik says go.
2. If he says go on certification: build the app with the rev-15 driver, sign it, grant Accessibility + Screen Recording to that bundle, run the fixture suites in his session, collect evidence (see the certification paragraph below).
3. If he says go on workstream A: write the option-C spec (Rust driver stays the gate; the sidecar does the focus events) before code.
4. Small pending item: the one-line stale test fix, needs his yes.

**Open decisions for Kartik**

- Certification route: local signed app first (recommended) or the Lume VM harness for final sign-off.
- Fix the stale test line now or later.
- When to push the three local commits (after certification is the natural point; PR #1227 is still on `bb7eb421c`).

**Certification, in plain words (for the brief)**

Source checks prove the code builds and the contracts hold. They do not prove the driver works against real apps. Certification runs the real path: the packaged app with the rev-15 driver, signed, with fresh macOS permissions, driving real windows. Four parts: (1) stage the driver and build/sign the app, (2) grant Accessibility + Screen Recording to that exact bundle, (3) run the fixture set (three apps typed into at once while the human uses a fourth; background work while the human types; off-Space text; refusals for stale screenshots, hidden windows, wrong targets), (4) save evidence JSON plus before/after images under `docs/computer-use-cua/evidence/`. Fixtures live in `apps/desktop/src/cuaFixtures/` and `scripts/computer-use-fixtures/`; the tier list is in the 09-16 section 6.3. Needs the operator at the screen for the permission toggles and the runs; an agent shell cannot grant permissions. Roughly one to two hours of operator time plus the build.

**Trust map for the 09-16 body below**

- Still accurate: section 2 (paths), 3.2-3.7 (implementation map, read the pin values from this block), 4 (research corpus, apply the corrections above), 5 (plan; engine choice is now C), 6.1-6.3 (setup and verification tiers), 7 (risks).
- Superseded: section 0 pin/state lines, 3.1 PR stats, 6.4 next steps, 6.6 open questions 1-3, 11.3 decision shortlist items 1-3.
- New companion doc: `/tmp/synara-cu-v2-exploration-2026-09-17.md` (verified facts, corrections, the rebase record, the CPS table, the 26.4 probe, check results).

---

## 0. Executive summary (the 10 things that matter most)

1. **Goal:** the best open-source computer-use system for AI agents on macOS. Feature parity with OpenAI's Codex Computer Use first, then better (speed, scroll reliability, robustness, full local capability). Agents are the primary consumer; Synara is the first host.
2. **Current work:** PR #1227 is the top of stack. It runs a heavily patched, pinned `cua-driver 0.28.2` (Synara native revision 15, rebased 2026-09-17) inside an Electron host, wrapped by a server-side `ComputerManager`/`CuaComputerBackend` layer, with a live in-chat preview UI built on top.
3. **Biggest known weaknesses:** it is not fast; macOS scroll is quantized and unmeasured; some control paths are limited (foreground-only drag, no hover, no menu tool, no window-frame tool); and human-vs-agent input isolation has an admission gate but no certified isolation guarantee.
4. **The single most important research finding:** there is no single "hidden API". Background, non-stealing input is a _combination_: per-process event delivery (`CGEventPostToPid` / SkyLight `SLEventPostToPid` + full CGEvent field stamping), a synthetic "you are active / you hold key focus" layer (AppKit-defined `NSEvent`s + private CPS process notifications + `_SLPSSetFrontProcessWithOptions`), NSEvent-first event construction (for AppKit identity bits), and optional visual masking when a real activation is unavoidable (Electron-class apps). See section 4.
5. **Codex parity reference:** Codex's (closed-source) implementation is now well documented by third parties and by our own reverse-engineering. The shape: per-pid delivery + synthetic focus belief + AX-first actioning + settle/verify + virtual cursor + per-app approvals. We already have big parts of this in the patched cua driver; gaps are enumerated in section 5.4.
6. **Hazards to check first:** macOS 26.4 changed the argument order of `SLEventPostToPid` (community fix: use `SLEventPostToPSN` on 26.4+; unverified against our pinned driver). 2026-09-17 update: not reproducible on this Mac's 26.5.1 with the driver's call pattern; keep the canary probe, no fallback needed yet. Two community reconstructions disagree on the CPS notification constants; 2026-09-17 update: resolved from Codex's binary (see the update block). Rev-15 behavior (three concurrent apps, human-vs-agent focus, off-Space semantic input) is unproven and needs a signed app + fresh permissions to certify.
7. **Environment:** this Mac runs macOS 26.5.1. The assistant sandbox kills freshly compiled binaries on exec (do not run compiled test binaries from the agent sandbox; it also pops a scary Gatekeeper dialog for the user). Disk is ~97% full (~17 GB free). Use sequential subagents, no git worktrees. The clone is a partial clone with `node_modules` removed; `bun install` restores deps in ~8 s from cache.
8. **Next steps:** (a) read section 3 (current state) then section 4 (research); (b) close the open questions in section 6.6 (especially the 26.4 API hazard and the scroll approach); (c) produce the parity matrix and workstream specs; (d) get Kartik's decisions on engine strategy and the open-source boundary; (e) implement with the verification tiers from section 6.3.
9. **Most useful reference repos already on this machine:** `/Users/user/background-computer-use` (Swift, pure-background engine), `/Users/user/pi-computer-use` (agent tool model + macOS bridge), plus upstream `trycua/cua` (our driver base). Full catalogue in section 4.2.
10. **Keep the promises of the current architecture:** never replay an uncertain action, never auto-promote background to foreground, fail closed, and preserve the input-admission gate and cleanup-ack semantics. These encode hard-won reliability lessons.

---

## 1. Mission and goals

From the conversation with Kartik:

- "I want to make the best open source computer use system for agents." Main use case: agents (Synara first, usable by others). "I don't want to make this for something else."
- **Full macOS:** in theory the agent should be able to do anything a user can do. If no accessible API exists for something, that is an acceptable gap; but the default should not be an artificial sandbox. Sandboxing (VMs, containers) comes later as an option, not as the primary posture.
- **Phase order:** first full capability parity with Codex Computer Use; then surpass it (speed, reliability, scroll, robustness).
- **Open source:** "this is going to be open source... we should see what we should do and what we should not do." Boundary undecided; treat as a design decision (section 5.6).
- **Quality bar:** thorough, complete, no early stops; use subagents sequentially (not parallel); no worktrees; don't clutter the machine.
- **Pain points named by Kartik about the current state:** not fast; the agent "has trouble scrolling"; it "can't really control" some things; input conflicts when the agent drives a background app while the human types elsewhere; multi-space/desktop handling "should be close".
- **Current deliverable mode:** plans, designs, specs, research, briefs. No implementation from this assistant unless Kartik explicitly re-asks.

### 1.1 Success criteria sketch (to be refined with Kartik)

- Capability: parity checklist vs Codex CU (section 5.4) fully green on macOS.
- Speed: measured targets for `get_state` round trip, click round trip, type round trip, host startup; no regressions in reliability budgets.
- Reliability: no focus theft, no pointer hijack, fail-closed on ambiguity, deterministic cancellation, verified delivery where the platform can verify.
- Isolation: human and agent can use the machine simultaneously; three concurrent agent targets work; off-Space operations never drag the user's desktop.
- Open source: clean licensing/attribution (cua MIT + Synara MIT), guardrailed design (section 5.6), publishable docs.

---

## 2. Where everything lives

### 2.1 Repos and checkouts on this Mac

| Path                                  | What it is                                                                                                                                                                    | State / notes                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/Users/user/synara`                  | Main Synara repo checkout (Kartik's fork).                                                                                                                                    | On `agent/pi-midstream-followup`, dirty with unrelated changes. Do not use for CU work. |
| `/Users/user/synara-computer-use`     | Fresh clone made for this effort: `kartikkabadi/synara`, branch `agent/computer-use-preview` @ `bb7eb421c`. Partial clone (`blob:none`). `node_modules` removed to save disk. | The working base for CU v2. `bun install` restores deps (~8 s from cache).              |
| `/Users/user/synara-cua`              | Older "Synara Cua" checkout, branch `cua-rebuild`, native rev ~5. Has the original `docs/computer-use-cua` corpus.                                                            | Historical reference.                                                                   |
| `/Users/user/synara-wt/cua-port`      | Worktree of `agent/cua-port-1090` (PR #1090 era), ahead 8 / behind 30 vs upstream main.                                                                                       | Stale; not for new work.                                                                |
| `/Users/user/synara-beta`             | Older beta checkout.                                                                                                                                                          | Not CU related.                                                                         |
| `/Users/user/background-computer-use` | Separate Swift project: local macOS background computer-use API (loopback HTTP; no pointer stealing; window motion; session cursors).                                         | Clean. Best-in-class reference for background input + window movement.                  |
| `/Users/user/pi-computer-use`         | Pi extension `@injaneity/pi-computer-use` v0.5.0 (macOS/Windows/Linux).                                                                                                       | Clean. Best reference for agent tool model + permission onboarding.                     |
| `computer-use-sdk`                    | Private TS SDK repo on GitHub (`kartikkabadi/computer-use-sdk`), not cloned locally.                                                                                          | Wraps `cua-driver-rs`; reference only.                                                  |

### 2.2 GitHub surface

- Fork: `github.com/kartikkabadi/synara` (origin of the clone).
- Upstream: `github.com/Emanuele-web04/synara` (public; MIT; PRs live here).
- **PR #1227**: "Ambient in-chat computer preview plus foreground focus restore" (draft; head `agent/computer-use-preview` @ kartikkabadi; base `main`; 92 commits per GitHub; updated 2026-09-16). Branch is 125 commits ahead of main, 652 files changed, +104,356 / -4,110 vs main.
- PR #1090: earlier native macOS computer-use port (`agent/cua-port-1090`).
- Branch `upstream/codex/computer-use-nativo-macos-con` on the upstream repo: older CU work that flows into #1227.

### 2.3 Codex (the competitor) on this disk

- `~/.codex/computer-use/Codex Computer Use.app` - the Sky daemon (`com.openai.sky.CUAService`, build 26.913.1001067): `SkyComputerUseService`, `SkyComputerUseClient` (MCP), `CUALockScreenGuardian`, `Codex Computer Use Installer.app` + `CodexComputerUseAuthorizationPlugin.bundle`.
- `~/.codex/plugins/cache/openai-bundled/computer-use/` - plugin versions (1.0.x on this machine) with `.mcp.json`, skills, and a `computer-use-client-launcher`.
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/` - Node 24 runtime with `@oai/sky` 0.6.32 (plus `@oai/cua`, `@oai/cua-repl`, `@oai/browser-desktop`), Playwright, sharp.
- `/Applications/ChatGPT.app/Contents/Resources/native/` - `sky.node` (SkyNative: CGWindow helpers, PIP stack), `input-monitoring-permission.node`, `browser-use-peer-authorization.node`, `launch-services-helper`, `bare-modifier-monitor`, `hid-topology-watcher.node`.

### 2.4 Skills, memory, and evidence

- Account skills (agents on this Mac): `/Users/user/.agents/skills/` - notably `codex-computer-use`, `verify`, `research`/`link-research`, `hygiene`, `performance-engineer`, `thermo-nuclear-code-review` variants, `commit`, plus many `principle-*`/`caveman-*` helpers.
- Repo-local skills: `.claude/skills/verify/SKILL.md` and `.claude/skills/react-doctor/SKILL.md` (present in both the main checkout and the clone).
- Project memory: `/Users/user/synara/.mind/` - `python3 .mind/runtime.py recall|capture|confirm`. Already captured: CU v2 is planning-only; clone path; sandbox exec-kill; disk pressure warning.
- Evidence and docs: `docs/computer-use-cua/` in the clone (see 3.5).

---

## 3. Current state of the implementation (branch bb7eb421c; see the 2026-09-17 update block above for the driver rebase)

### 3.1 PR #1227 in one screen

Implemented (per the PR comment and recon):

- Exact `(pid, window_id)` target admission (WindowServer ownership, positive geometry, visibility, Space membership, Accessibility ancestry checks).
- Focus-neutral semantic text insertion through the exact writable Accessibility element; background semantic input does not use process-wide HID or transient foreground activation.
- Concurrent native semantic leases + server-side scoped scheduling: different exact targets may overlap; the same target is not admitted concurrently; pointer and generic keyboard operations remain exclusive; cancellation and shutdown drain active controllers.
- Multi-Space safety contract: active-Space routing for pointer, generic keyboard, scroll, drag, activation, and foreground actions; stable-membership routing only for exact retained semantic text targets; revalidation of identity/ownership/geometry/membership/AX ancestry; fail-closed refusal for ambiguous or stale targets; off-Space screenshot freshness explicitly unverified.
- Per-thread browser/Computer tool guidance on first use and every tenth use (bounded LRU).
- Removed the misleading right-sidebar Computer pane while keeping the ambient in-chat live preview and backend tools.
- Foreground-only composer focus guard (pending focus waits for a real window-focus event instead of activating Synara after turns).
- Rebuilt unsigned DMGs from the staged app (checksums in the PR comment).

Source verification at PR time: `bun run fmt:check` pass; `bun run lint` 0 errors / 630 warnings; `bun run typecheck` pass (7 packages); `bun run windows-runtime:check` pass (249 files); `rustfmt --check` pass; `cargo check -p cua-driver` pass (one dead-code warning); React Doctor 65/100 (unchanged); `bun run test` run twice with timing flakes (reported as a verification gap, not a pass).

Packaged artifacts at PR time: `Synara-0.8.4-arm64.dmg` + `.zip` (hashes in the PR comment; bundle `com.emanueledipietro.synara`, Cua Driver 0.24.0, upstream revision `4b3396d9...`, native revision 14, patch sha `3375ac1c...`). Unsigned; not notarized.

**Explicitly unproven** (needs a freshly packaged rev-14 app + new TCC grants; from the PR comment and repo docs):

- Three simultaneous provider-backed threads typing into three real background applications while a fourth foreground app remains usable.
- Fresh persisted `computer_type_text` lifecycle events plus before/after target readback.
- Retained exact semantic input into an off-Space application.
- Screenshot freshness refusal and active-only pointer/generic-keyboard refusal in the packaged app.
- Identity, Space-membership, hidden-window, and minimized-window interruption/refusal behavior in the packaged app.
- The canonical macOS Lume harness (requires a logged-in maintainer VM with SIP disabled, the signing keychain, GUI access, TCC grants).

### 3.2 The native driver and its patch (rev 1-14)

Pin (`packages/shared/src/cuaDriverRelease.json`): cua-driver `0.24.0`; upstream commit `4b3396d9fe4bd3cf723b0eb8db83c18a8764b520` (trycua/cua); archive sha `31790cb4...`; patch sha `3375ac1c...`; `nativeRevision 14`; Rust `1.97.1`.

Patch: `apps/desktop/patches/cua-driver/0001-synara-native.patch` (~7,888 lines, 30 file hunks). The daemon stamps `synara_native_revision` from a literal in `serve.rs` (patch line ~455), NOT from the manifest. The patch README warns: bumping the manifest without the literal breaks the handshake and daemons get retired seconds after spawn.

Revision recap:

- **rev 1**: irreversible per-process input-admission gate; keyboard/mouse guards pre-prepare matching releases and release on return/error/cancel/unwind; separate action lease for restore+verify; private `cancel_input` (authenticated embedded parent + exact child PID only); cleanup ack requires zero pending input + drained contexts; host stdin-EOF drains the same gate; host refuses to kill/replace a generation without a valid ack.
- **rev 2**: read-only `check_input_ready` for exact PID/window; admission rechecks window ownership, active Space, visibility, optional observed bounds at dispatch; Space change invalidates the current action while held releases and focus restoration drain (generation survives); semantic AX distinguishes pre-dispatch refusal vs attempted/uncertain mutation; submitted selection/value writes never fall through to another actuator; exact foreground activation no longer requests all sibling windows.
- **rev 3**: `window_points` coordinate space + `expected_window_bounds`; input frame resolution without extra captures (`tools/px_frame.rs`, `tools/scroll.rs`).
- **rev 4-5**: `--compact-cursor` overlay (one replaceable pending bitmap, one queued presentation, CoreGraphics takes ownership); synthetic click/text delivery selection (native-app vs Chromium recipe from process metadata; single transport, no duplicate SkyLight/CoreGraphics submissions).
- **rev 6**: `SYNARA_CUA_BACKGROUND_OBSERVATION_MS` bounds post-action window observation for background delivery; per-element AX attributes fetched in one `AXUIElementCopyMultipleAttributeValues` IPC call; per-attribute failures decoded via API error markers; `AXActionNames` fallback to the dedicated call.
- **rev 7**: bounded worker pool overlaps sibling-array AX IPC; assembly/ordering/budget/truncation stay serial on the walk thread; `CUA_AX_SERIAL_FETCH` restores inline fetch for comparison. (Live numbers: tree walk 673 -> 207 ms.)
- **rev 8**: second liveness channel: daemon polls `CUA_DRIVER_EMBEDDED_HOST_PID` with `kill(pid, 0)` (2 s) alongside stdin EOF; leaked lifetime-fd duplicates can't orphan the daemon.
- **rev 9**: `catch_unwind` around `run_serve_cmd` so a serve-thread panic still runs `exit(0)` (no immortal orphan with dead serve loop, live socket, and ghost overlay).
- **rev 10**: exact semantic-only text delivery: retained AX element token receives text without app activation or process-scoped key events; unavailable/unverifiable insertion is refused, never falls back; process-scoped mutations exclusive; cross-window semantic mutations may overlap; same-window ordered.
- **rev 11**: progressive + concurrently admissible exact semantic text (per-target native input lease; generation gate validates every active target before character-paced AX requests; post-submit cancel reports observed-partial or uncertain, never "nothing happened").
- **rev 12**: rejects a second concurrent native semantic lease for the same exact PID+window (native backstop for server-side same-window ordering; independent windows still concurrent).
- **rev 13**: exact semantic lease survives Space moves when WindowServer ownership, stable Space membership, AX ancestry, and positive geometry stay valid; Active-Space changes still cancel pointer/synthetic-keyboard/foreground actions; off-Space pixels labeled freshness-unverified, unusable as live grounding.
- **rev 14**: `get_window_state` reports exact layer-0 window Space metadata via the same Space-aware WindowServer lookup as admission (keeping an any-layer fallback for accessory surfaces).

Gate scope note (README): the gate applies to the SDK tool path admitted by the Synara GUI host, not the separate interactive-worker API. An ack means release events were submitted and action contexts drained; fixture-owned event counts are the independent evidence that a target consumed them. SIGKILL/crash/OS failure have no cooperative guarantee.

### 3.3 Architecture map (files to know)

**Desktop host (Electron)** - `apps/desktop/src/`:

- `cuaDriverHost.ts` (~1065 lines): private 0700 dir + 0600 unix socket; one JSON line/connection, 1 MiB request cap; capability check via `timingSafeEqual` (>=32 bytes; fd handoff, never inherited); methods `stop`, `end_task`, `probe`, `setup`, `call` (allowlisted read/action tools only, desktop-pause refusal, serialized); driver spawn: `cua-driver serve --embedded --socket <ep> --compact-cursor --idle-hide-ms 900` with env `CUA_DRIVER_EMBEDDED=1`, `CUA_DRIVER_HOST_BUNDLE_ID`, `CUA_DRIVER_PERMISSION_MODE=standard`, telemetry/update-check disabled, `SYNARA_CUA_FOREGROUND_OBSERVATION_MS=100`, `SYNARA_CUA_BACKGROUND_OBSERVATION_MS=350`, `CUA_DRIVER_PARENT_LIVENESS_STDIN=1`, `CUA_DRIVER_EMBEDDED_HOST_PID`, `CUA_DRIVER_RS_HOME=<dir>/state`; handshake asserts version + nativeRevision + embedded + child pid; `start_session` + `set_agent_cursor_motion(glide 100ms, dwell 0)` within 5 s.
- Retirement: `cancel_input{expected_pid}` (5 s); ack requires pid match + `input_admission_closed` + `cleanup_complete` + `pending_input==0`; never kills/replaces without ack when input was ever dispatched (barrier persists across resume); dead-during-input without ack -> `releaseHeldInput()` then fail closed; orphan sweep kills daemons whose embedded host pid is dead and reaps stale `synara-cua-*` tmpdirs.
- `computerDesktopLifecycle.ts`: pause on lock/sleep/user-session resign, resume after.
- `computerFrameTap.ts` + AppSnap helper (`stopNativeHelper.ts`): preview frames `[u32LE len][jpeg]` (4 MiB cap, ~12.5 fps measured) on `computerPreview.frame`; one helper per task+target; dead tap stays dead.
- `cuaFixtures/{native,electron,gateway,live,cancellation}.ts`: real host+backend fixtures for verification (section 6.3).
- `scripts/provision-cua-driver.mjs`: build-from-source + patch + provenance; requires `rustc 1.97.1` exactly; verifies patch sha before use; `--archive` rejected ("lacks Synara's native patch").

**Server** - `apps/server/src/computer/`:

- `ComputerManager.ts` (~3570 lines): lease/orchestration; `withDesktopControl`; `admitDrivenApp` (second-app consent); scoped injection; scroll (`scrollCalibrated` with probe/gearing on non-macOS; macOS path skips measurement); `foregroundWithRestore`; clipboard; waits; frame pub/sub; control enable/disable with generations; provision/revoke; thread removed/restored. Key constants: action settle 300 ms, paste restore 250 ms, windows publish debounce 250 ms, lease idle 300 s, control enable timeout 30 s, scroll probe 48 px, frame queue limit 8, frame socket budget 2 MiB.
- `CuaComputerBackend.ts` (~1278 lines): translates Manager intents to native IPC; target resolution from fresh AX state (window-scoped, role verbatim, onScreen trusted, ambiguity refused); coordinate mapping via screenshot registry (`screenshotFrames.ts`); Space policy (off-Space pixels never live grounding); effect semantics: `verified` only on native read-back; `not-dispatched` vs `dispatched-unknown`; never replay uncertain actions.
- `DesktopOperationQueue.ts`: serialized lane (limit 64) + admission/cancellation + delivery-mode context (`background`/`foreground`).
- `ComputerApprovalGate.ts`: per-turn approval rendezvous; in-memory; 128 global / 8 per-thread caps; frozen generations prevent stale consent reuse.
- `ComputerControlState.ts`: durable per-thread on/off + generations (`computer-control.json` in server stateDir).
- `Layers/ComputerService.ts`, `Layers/ComputerLeaseReactor.ts`, `Services/*`: wiring; releases the desktop lease on provider-runtime terminal events.
- Helpers: `scrollCalibration.ts` (pure PNG travel measurement + `ScrollGearingStore`, used on non-macOS), `scrollUnits.ts` (80 px nominal per notch, `PIXELS_PER_NOTCH`), `screenshotFrames.ts` (registry + desktop mapping), `stillFramePublisher.ts`/`stillFrameDedupe.ts` (Tier-1 stills loop), `uiTreeTargeting.ts`, `uiTreeText.ts`, `waitForControl.ts`, `waitForWindow.ts`, `computerSetupSignal.ts` (missing-grant classifier), `computerGeometry.ts`, `modelDesktopObservation.ts`, `cursorActivity.ts`, `computerEventInterests.ts`, `computerFrameRoute.ts`, `wsComputerHandlers.ts`, `FakeComputerBackend.ts`/`UnavailableComputerBackend.ts`.
- Gateway: `apps/server/src/agentGateway/computerTools.ts` (~2815 lines) + `computerGuidance.ts` (60 lines).

**Web** - `apps/web/src/`:

- `components/computer/` (status badge, input-pause notice, click dispatch with double-click pairing 500 ms, input queue limit 24, image stream hook, preview tap hook), `components/ComputerPanel.logic.ts`, `components/chat/ComputerPreviewPopover.*` (phase machine, tap-vs-stills source selection), `ComputerControlDeniedCard`, `ComputerSetupRequiredCard`, `ComposerComputerControlEffortHint`.
- Stores: `computerPreviewStore.ts` (per-thread sessions/agent-active/footprint), `computerStateStore.ts` (version-gated thread state, last action), `computerControlMode.ts` (`off|request|chat`).
- Hooks: `useComputerDesktopControl`, `useComputerControlModeChange`, `useProvisionComputer` (single-flight), `useThreadComputerAvailability`, `useComputerEventBridge`, `useCachedComputerStatus`, plus component-hosted `useComputerPreviewTap`/`useComputerImageStream`.
- Lib: `computerFrameSource.ts` (WS binary frames + resync cooldown), `computerProvisioning.ts`, `computerToolPresentation.ts` (verb/where/window copy for approval + transcript).

### 3.4 Provider tool surface (from `computerTools.ts`)

Perception (not approval-gated): `computer_list_windows` (topmost-first, bounds/stacking/occlusion, window_id scopes without activating), `computer_get_state` (elements + optional image/text, diff mode), `computer_screenshot` (window or region, capped), `computer_get_screen_size`, `computer_wait` (duration + optional label/window readiness).

Mutating (all approval-gated): `computer_read_clipboard`, `computer_launch_app`, `computer_click`, `computer_double_click`, `computer_triple_click`, `computer_right_click`, `computer_move_cursor` (overlay-only on macOS Cua), `computer_drag` (macOS: foreground required, 10 s cap, endpoints in-window), `computer_scroll` (screenshot-pixel deltas, half-frame clamp, 4th-unchanged refusal), `computer_type_text`, `computer_press_key`, `computer_hotkey`, `computer_write_clipboard`, `computer_set_value`, `computer_perform_action` (macOS named AX actions: `AXPress`/`press`, `open`→AXOpen, `show_menu`/`menu`→AXShowMenu, `pick`→AXPick, `confirm`→AXConfirm, `cancel`→AXCancel; unknown names and targets that do not advertise the action refuse `not-dispatched`), `computer_paste` (save/write/paste/restore, reports clipboardRestored), `computer_run` (batch; validated up front; same targeting/consent per step; stops at first failure; no per-step screenshots by default), `computer_activate_window` (foreground-only, approval-gated, restores after).

Delivery: `delivery_mode: background|foreground` (default background). Foreground excursions restore the previously frontmost window (`withForegroundRestore`). Guidance forbids replaying uncertain actions and auto-promoting to foreground. Batch scroll steps inherit the frame window and clamp to half a frame.

Deliberately unexposed (audited): `invoke_menu`, `set_window_frame`, `verify_state`, raw session tools, raw recording tools.

### 3.5 Tests, evidence, docs

- Test counts (latest recorded): 421 server tests (combined run), 137 frontend (incl. 11 real headless browser cases), 12 desktop host, 60 + 6 native rev-2 control-plane, plus contract/socket/transport checks. Sources: `docs/computer-use-cua/integration-refresh.md`, `final-checks-and-comparison.md`.
- Measurements worth knowing: AX tree walk 673 -> 207 ms (rev 7); orphan sweep 6+ min -> ~1 s; preview 12.5 fps / 75 frames, no leaks; retained ingress serialization for a 512 KiB image 699,469 -> 475 B (one retained event, not RSS); native rev-1 fixture peak 307.84 MiB (not a rev-14 claim).
- Docs corpus: `docs/computer-use-cua/` = README (canonical overview + limits table), `qualification.md` (rev-1 record; 19 assertions; explicit "does not qualify later revisions"), `integration-refresh.md` (rev 2 + rev 6-9 addendum; "Verification and limits"), `capability-audit-2026-09-16.md` (tool mapping + "Remaining certification boundary"), `final-checks-and-comparison.md` (counts + Swift comparison), `completion-audit.md`, `permission-guide.md`, `permission-flow-fix.md`, `native-preview.md`, `task-invocation-and-consent.md`, `optimization-and-readiness-plan.md`, `CUA-LICENSE.txt`, `import-provenance.json`, and `evidence/` (per-run JSON + before/after PNGs, incl. `refresh-2026-09-08/` and `final-checks-2026-09-08/` ledgers).
- Latest claimed status: rev 14 integrated; rev 6-9 live-verified on a packaged signed app (2026-09-15); repo checks green; rev-14 packaged certification still pending.

### 3.6 Known limitations (as stated in-tree)

- macOS scroll: quantized single-axis notches (120 px, max 50), no modifiers, no travel measurement, no corrective replay. (`CuaComputerBackend.scroll`; `ComputerManager.scrollCalibrated` macOS branch skips measurement.)
- macOS drag requires foreground (10 s cap); no hover promise; no background drag on macOS; Swift-era comparison showed the Swift engine had broader hover/background-drag/2-axis/modified scroll.
- `set_window_frame`, `invoke_menu`, `verify_state` deliberately unexposed (capability audit).
- Mixed-scale / secondary-display capture unproven; Intel slice compiled but not executed; production signing/notarization not established.
- Simultaneous human input: there is an admission gate and pause semantics, but no isolation _guarantee_ claim; three real concurrent targets unproven at rev 14.
- Whole-desktop pane and remote/SSH/VM previews unproven.

### 3.7 Recent branch history worth knowing

- `bb7eb421c` feat(computer): harden background control and guidance (current head; 54 files, +3587/-1700).
- `4ea386f8` Improve computer activity feedback.
- `0e862235` Revert "fix(desktop): repair macOS permission setup flow"; `7d503eb1` Revert "fix(web): refresh computer status after permission checks" (the fixes `4d6551c25`, `e21888628` were reverted shortly after landing; check intent before touching the permission flow).
- `05910def` feat(computer): restore user focus after foreground (the `withForegroundRestore` behavior).
- Revisions 6-9 landed 2026-09-15; revs 10-14 landed in the rev-14 bump commit.

---

## 4. Research corpus (knowledge that otherwise lives only in the chat log)

This section is the deep dive. It is written to be self-sufficient: it includes everything learned from reverse-engineering sessions, third-party reconstructions, and hands-on probing of this Mac, with confidence markers where evidence is conflicting.

### 4.1 Codex Computer Use internals (how the competitor works)

**Process model (confirmed from disks + third-party disassembly):**

- `ChatGPT.app` is an Electron shell + a Rust `codex app-server` + a bundled Node 24 runtime (`cua_node`) with `@oai/sky` 0.6.32. The model sees ONE JavaScript REPL tool (`cua_repl` MCP server: `js`, `js_reset`, `turn_ended`); it writes JS against a persistent `sky` object.
- Native Mac control happens in the **Sky daemon**: `~/.codex/computer-use/Codex Computer Use.app` (`com.openai.sky.CUAService`, an `LSUIElement` app that owns the TCC grants: Accessibility + Screen Recording). It is signed by OpenAI (team `2DC432GLL2`).
- The daemon speaks **JSON-RPC 2.0 over a unix socket** with u32-LE length-prefixed frames: `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock` (plus `.lock`). An XPC transport exists behind `CODEX_COMPUTER_USE_IPC_TRANSPORT_XPC`. A separate lock-screen guardian socket lives at `/tmp/com.openai.sky.CUAService/LockScreenLoginAuthorization.sock`.
- `SkyComputerUseClient.app` is the MCP-facing client (`mcp` subcommand) and a `turn-ended` notify handler. `CUALockScreenGuardian.app` + `CodexComputerUseAuthorizationPlugin.bundle` implement "locked use" (an Apple authorization plug-in installed into the unlock flow).
- The CU plugin ships as `openai-bundled/computer-use/<version>` with `.mcp.json` pointing at `./bin/computer-use-client-launcher mcp`; guidance comes from a `computer-use` skill and a `computer-use-node-repl.md`.
- Companion servers in the same client binary: `messages` (reads `chat.db` via SQLite, resolves names via Contacts, sends via ScriptingBridge with two-phase Prepare/Commit), `computer-history` ("Skysight": ScreenCaptureKit + Vision OCR + CoreML, JSONL segments, 10-minute/6-hour summaries), `event-stream` ("Record & Replay": UIRecorder captures clicks/keys/AX diffs to `events.jsonl`).

**Input synthesis model (the "no focus steal, no cursor move" trick):**

- Events are **posted to the target process, not to HID**: `CGEventPostToPid` under the hood (via a once-initialized function-pointer table; also `tapCreateForPid` in the wrapper). None of the CGEvent functions are static imports; they are resolved at runtime, which is why a naive `nm` scan shows almost nothing.
- **Events are built as `NSEvent` first** (`mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:`) and converted with `-cgEvent`. Reason: a from-scratch `CGEvent` has no AppKit identity (`[NSEvent eventNumber]` is 0, `[NSEvent window]` is nil) and custom NSViews / Electron hit-testing drop it. After conversion they patch CG-space fields.
- **Field stamping on mouse events** (confidence: high, read from multiple binaries): field 3 = button number; field 7 = subtype, set to **3** (the value real pointing-device events carry; without it the event self-identifies as synthetic); fields 51/91/92 = window number / window-under-mouse-pointer / that-can-handle-this-event (so backgrounds apps accept a click the real pointer is nowhere near); field 41 = source pid (their own); field 40 = `kCGEventTargetUnixProcessID`. Then `WindowServerSPI.setWindowLocation` (i.e. private `CGEventSetWindowLocation`) stores the **window-local** point, flipping Y for AppKit windows.
- Private field ids are kept in a once-initialized table `(51, 55, 64, 66, 67, 69, 71, 73)` with an "unavailable" flag per entry, so a future macOS can disable them without a crash.
- Click timing: `humanClickInterval` = **0.1 s** between down/up; multiple clicks increment the click-state field; drag is the same event stream with `andDragTo:` (mouseDown -> mouseDragged -> mouseUp). There is also a press-and-hold path (`leftMouseDownUp(isDown:)`).
- Keyboard: keycodes come from the _current layout_ (`TISCopyCurrentKeyboardLayoutInputSource` + `kTISPropertyUnicodeKeyLayoutData` + `UCKeyTranslate` + `LMGetKbdType`); literal typing uses `keyboardSetUnicodeString` (layout-independent); `press_key` accepts an xdotool-style keysym table (`Return`, `BackSpace`, `KP_0`..`KP_9`, `KP_Enter`, `Page_Up`, `F1`..`F20`, `super`/`cmd`, `alt`/`option`, `ctrl`, `shift`, `fn`, `Caps_Lock`, `Menu`, ...).

**Focus model (the real "hidden API" answer):**

- `SyntheticAppFocusEnforcer` keeps three flags per pid: `applicationIsActive` (genuinely frontmost), `applicationBelievesItIsActive` (told so synthetically), `applicationBelievesItHasFocus` (told its window has key focus). It posts nothing when the target already believes it is active+focused, and it re-asserts only when needed (this avoids flicker).
- It synthesizes **AppKit-defined notifications** and posts them _to the target pid_:
  - `notifyAppDeactivated()` = `[NSEvent otherEventWithType:NSEventTypeAppKitDefined(13) ... subtype:NSEventSubtypeApplicationDeactivated(2)]` -> `.cgEvent` -> pid.
  - Activation and key-focus variants use the **private `NSEventType` 21 ("processNotification")** with **private CPS subtypes**: `kCPSNotifyNewFront`, `kCPSNotifyKeyFocusTaken`, `kCPSNotifyKeyFocusChanged`, `kCPSNotifyKeyFocusReturned`, `kCPSNotifyLostKeyFocus`, `kCPSNotifyLostTypingFocus`, `kCPSNotifyTypingFocusChanged`. These are Core Process Services notifications that AppKit normally receives from the window server; here they are forged and delivered to one process.
  - `notifyWindowKeyFocusRemoved()` sends `kCPSNotifyKeyFocusTaken` (counter-intuitive; verified by matching the lazily-initialized global each builder loads); `notifyWindowKeyFocusReturned()` sends `0xF102`.
  - When a window id is known, activation events carry it (windowNumber) and control|option modifiers (`0xC0000`).
- `_SLPSSetFrontProcessWithOptions` (ApplicationRegistrySPI.setFrontProcess) plus key-focus bookkeeping (`getKeyFocusProcess`, `releaseKeyFocus`, `setApplicationDesiresAttention`) is the "make this window key" half of the puzzle. **Evidence conflict:** some reconstructions say Codex uses it directly (a shipping implementation they surveyed "reaches for" it); another says Codex does NOT use it and CPS-level focus change alone is what they do. Our own string scan of `SkyComputerUseService` on this machine finds `CPSNotify*` names and `SetFrontProcess` but no `SLPS*`/`SLS*` strings. Resolve empirically before copying.
- `SystemFocusStealPreventer` installs event taps (`viewBridgeKeyboardTap`, `systemProcessNotificationTap`, per-thief `mouseEventTaps`) to suppress the window server's menu-dismissal / focus-return events while a menu of a background app is open; window ordering is observed (`WindowOrderingObserver.menuDidOpen/menuDidClose`). Focus theft is detected by reading private `kCPSNotifyTypingFocusChanged` events and CGEvent fields `focusTheftID` / `focusThiefAlsoStoleTypingFocus`.
- `waitUntilAppBelievesItIsFrontmost(timeout:)` polls the AX side to confirm the belief actually landed.
- The overall effect: the target app believes it is active/key while the user's real foreground app is untouched. This is how Codex types into a background app while you keep working.

**Observation model:**

- "Skyshot" = window screenshot + formatted accessibility tree text with integer `element_index` per interactive element; diff mode ("the following is a diff from the previous accessibility tree, ~ changed, + added"); the tree is refetchable by element id with validation.
- Tree pipeline: associateTitleUIElements -> flattenIntoSelectableAncestor -> flattenRepetitiveStaticText -> pruneNonDescriptiveSubtrees, then render one line per element. Interactive elements get ids; frames are window-relative for action targeting.
- Settle: an AXObserver-based `waitForUIToSettle` (layout/value/focus/`elementBusyChanged` notifications, debounced; ~1 s after an action, up to ~5 s while busy indicators show). Actions set `needsUISettleBeforeSkyshot`.
- Fast window capture uses a private `SLSHWCaptureWindowList`-style path for previews/PIP; model screenshots use ScreenCaptureKit. PIP streams the controlled window into the ChatGPT window either as a remote CoreAnimation layer or VideoToolbox-encoded frames.

**Action model:**

- AX-first: `AXUIElementPerformAction` for menu items and secondary actions; `perform_secondary_action` invokes a named AX action on an indexed element.
- Clicks: multi-tier (from a reverse-engineered replica, plausible for Codex): AXPress/AXOpen (zero activation) -> AX hit-test then AXPress -> `CGEvent.postToPid` (native apps) -> _real activate + visual masking_ for Electron-class apps (~80 ms: raise the user's windows to `kCGPopUpMenuWindowLevel` (25) via private `CGSSetWindowLevel`, activate the target so its window sits behind the user's raised windows, deliver the click, restore). Known cosmetic issue: the menu bar can flash during the activation; the community fix is a transparent fullscreen overlay at level 25.
- `set_value`: writes `kAXValue` when the element says settable; autosubmits search fields by pressing Return.
- `select_text`: resolves text ranges via text markers (WebKit) and sets the selection.
- `paste`: writes `NSPasteboard` (String/HTML/RTF/file URLs) and restores the previous clipboard contents afterwards.
- `scroll`: synthesized scroll wheel deltas (pages x visible size) with an AX scroll-bar fallback (`scrollUsingScrollBar`).
- `drag`: the same synthesized events with `andDragTo:`; middle button = `mouseButton: 2`.

**UX and safety features:**

- Virtual cursor overlay ("ComputerUseCursor", including a fog style): spring animation, press effect, idle wobble; ordered directly above the target window; visual-only and never used for coordinates. Multiple agents = multiple cursors.
- Per-app approvals (allow / always allow / deny), approvals for launching apps, URL policy checks for browser use, "Computer Use was stopped by the user with the physical Escape key" stop flow.
- Menu bar UI: "No Active Sessions" / "Stop Computer Use for App"; sessions deactivate at turn end.
- Locked use (macOS): optional authorization plug-in; auto-unlock only during active CU turns; every display is covered while temporarily unlocked; relock-on-local-input.

**Chrome path (important architecture lesson):**

- Chrome is NOT driven through macOS Accessibility. It is driven through the **Chrome DevTools Protocol** obtained by a ChatGPT extension via `chrome.debugger`, relayed through a native messaging host and `browser-service.mjs`. Tab APIs: `tab.ax.*` (index-addressed), `tab.playwright.*`, `tab.dom_cua.*`, `tab.cua.*` (raw coordinates); a content-script cursor overlay; agent tab groups; favicon badges; takeover of user tabs with fail-closed checks. Without the extension, Chrome falls back to the AX path (with `AXManualAccessibility`).

**IPC and security posture:**

- Sender authentication: the daemon authorizes clients by code signature / team id / bundle identity (audit token, `getsockopt(LOCAL_PEERTOKEN)`; `browser-use-peer-authorization.node` checks teamId + signingIdentifier + parent/grandparent). `SkyComputerUseClient` carries a parent launch constraint (`SkyComputerUseClient_Parent.coderequirement`, team `2DC432GLL2`), so only OpenAI-signed processes can spawn it.
- Known failure modes (openai/codex issues): `#35234` native pipe rejects a correctly signed in-app sender ("Sender process is not authenticated", macOS 26.5.2); `#32210` service crashes on macOS 15 (missing Swift concurrency symbol); `#18755` client built for macOS 15 crashes on 14; `#26293` `turn-ended` client leaks as PPID=1 orphans; `#28479` CU client needs `CODEX_HOME`/`CODEX_SQLITE_HOME`; `#25321` composer focus loss with the pet/overlay.

**Version hazards (top of the risk list):**

- **macOS 26.4 changed the argument order of `SLEventPostToPid`.** A community implementation (Osaurus, fix #2316) switched to `SLEventPostToPSN` on 26.4+ because pid-first calls crash (crash registers forwarded the pid into `SLEventPostToPSN`'s event slot, #2315). **Check what our pinned driver calls on this macOS 26.5.1 machine, and add a version-gated PSN path if needed.**
- CPS subtype constants: two reconstructions disagree. Operon: `kCPSNotifyKeyFocusTaken = 0x8000`, `kCPSNotifyKeyFocusReturned = 0xF102` (and warns "LostKeyFocus would be the obvious guess and it is wrong"). cua-rs-mcp: `kCPSNotifyKeyFocusReturned = 0x8000`, `kCPSNotifyKeyFocusTaken = 0x4000`, `kCPSNotifyKeyFocusChanged = 0xf102`, `kCPSNotifyNewFront = 2`, `kCPSNotifyLostKeyFocus = 0x1000`. **Verify empirically on this machine before relying on either table.**
- Event field offsets (`SLSEventRecord` pointer at CGEvent offset 24; probed 24/32/16) and other private layouts can shift across macOS releases. Keep availability flags + fallbacks (the current architecture already does this).

### 4.2 Prior art catalogue (what to study, per problem)

**Our engine base:**

- `trycua/cua` (MIT): the upstream of our pinned driver. Its blog post "Inside macOS window internals" documents the SkyLight path: `SLEventPostToPid` for per-process delivery + `SLPSPostEventRecordTo` focus-without-raise + `CGEventSetWindowLocation` + the `SLSEventAuthenticationMessage` envelope for Chromium-class keyboard. The repo has `libs/cua-driver/rust/crates/platform-macos/src/input/{skylight,keyboard,mouse}.rs`, plus `docs/macos-background-input-v1-plan.md` (the ladder + reliability policy we mirror).

**Focus/input recipes:**

- `koekeishiya/yabai` `window_manager_focus_window_without_raise`: the canonical 248-byte `SLPSPostEventRecordTo` record (byte 0x04 = 0xF8, byte 0x08 = 0x0D, window id LE at 0x3C..0x40, byte 0x8A = 0x02 to defocus the outgoing process then 0x01 to focus the incoming one), plus `_SLPSSetFrontProcessWithOptions(psn, wid, kCPSUserGenerated = 0x200)` and `kCPSNoWindows = 0x400` variants.
- `osaurus-ai/osaurus` `SkyLightBridge.swift`: minimal Swift recipe, the `isWindowServerVisible(pid)` guard (kill(pid,0) + `NSRunningApplication.activationPolicy != .prohibited` before posting; GetProcessForPID segfaults on non-GUI pids), the "status is diagnostic only, never retry through a second transport" rule, and the 26.4 PSN switch.
- `nickqiaoo/Operon` `SynthesizedFocusEvent.swift` / `SyntheticAppFocusEnforcer.swift` / `SystemFocusStealPreventer.swift`: clean Swift reconstructions of Codex's activation/focus events (including the activation sequence with arming clicks for Electron), plus the pure policy that avoids re-posting when the target already believes it is active/focused.
- `maestrojeong/cua-rs-mcp` (`crates/cua-hid/src/nsevent.rs`, `examples/slps_click_probe.rs`): Rust probe with the field table + variants (front/cps/flip/global/psn/full/nsapp/hidsrc/awr/sl/winloc/annot) and the NSEvent-first rationale for click identity.
- `Puggo1145/Notch-Agent`: Swift keyboard/mouse posters with the auth envelope.

**Agent/tool model + engine patterns:**

- `~/pi-computer-use` (public `injaneity/pi-computer-use`, MIT, ~1.9k stars): state-scoped observation model (`find_roots` -> `observe_ui` -> `search_ui`/`expand_ui`/`inspect_ui` -> `act_ui` transactional batches with `expect` verification), strict `headless` (background) vs default modes, per-resource scheduling (`desktop-pid:{pid}`, `cdp:{target}`), permission onboarding that pre-registers the helper app in both panes then restarts the helper on "Recheck", helper app identity `~/Applications/pi-computer-use.app`, macOS bridge in `native/macos/bridge.swift`, visual agent cursor owned by the helper (`agent_cursor*.swift`), sockets at `~/Library/Caches/pi-computer-use/bridge.sock` (protocol v6).
- `~/background-computer-use` (Swift package, MIT-ish; `actuallyepic/background-computer-use`): loopback HTTP API (`/v1/bootstrap`, `/v1/routes`, `list_apps`, `list_windows`, `get_window_state`, `click`, `scroll`, `drag`, `resize`, `set_window_frame`, `type_text`, `press_key`, `set_value`, `perform_secondary_action`); AX-first then target-only native dispatch (`SLEventPostToPid` family with a 30-50 ms settle); verifier-first response taxonomy (`success | unsupported | effect_not_verified | verifier_ambiguous`); window-motion planner/executor/verifier stack; session cursors (`cursor:{id,name,color}`); self-signing bootstrap keychain (`~/Library/Keychains/background-computer-use-dev.keychain-db`) and a signed `.app` for TCC. This is the best pure-background engine to study for transport + verification semantics.
- `iFurySt/open-codex-computer-use` (open MCP alternative; `sky_click` method; fail-closed reliability doc in Chinese): useful cross-check on the "SkyLight symbols fail closed" posture.
- `missuo/wisp` `DESIGN.md` (2026-09-14): a disassembly-backed writeup of the ChatGPT app's CU stack (matches many findings above; good cross-reference).
- `paralym/codex-computer-use-cli`: another reverse-engineered replica with a findings table (focus enforcer class names, event taps, masked activation tiers, "no CGEventPost", Electron coordinate offset ~14 px observation).
- `Hannahmana/skylight-cli`, `Lakr233/SkyLightWindow`, `ejbills/DockDoor`, `mcmonad`: more SkyLight/private-API usage patterns (incl. proof that private window APIs can work without special entitlements).
- `lwouis/alt-tab-macos` notes on `SLSManagedDisplaySetCurrentSpace` commit semantics; `velppa/InstantSpaceSwitcher.spoon` + yabai for the synthetic dock-swipe gesture used for instant Space switching.

### 4.3 macOS private API knowledge base (all verified present on this Mac except where noted)

Verified via osascript + dlopen/dlsym on macOS 26.5.1 (all resolve at runtime):

- **SkyLight:** `SLEventPostToPid`, `SLEventPostToPSN`, `SLEventSetAuthenticationMessage`, `SLEventSetIntegerValueField`, `SLPSPostEventRecordTo`, `_SLPSSetFrontProcessWithOptions`, `_SLPSGetFrontProcess`, `GetProcessForPID`, `SLSMainConnectionID`, `CGSMainConnectionID`, `SLSGetActiveSpace`, `CGSGetActiveSpace`, `SLSCopySpacesForWindows` (selector 0x7 = all Spaces containing the window), `SLSCopyManagedDisplayForWindow`, `SLSManagedDisplayGetCurrentSpace`, `SLSManagedDisplaySetCurrentSpace`, `SLSMoveWindowsToManagedSpace`, `SLSAddWindowsToSpaces`, `SLSRemoveWindowsFromSpaces`, `SLSGetSpaceManagementMode`, `SLSCopyManagedDisplaySpaces`, `SLSGetWindowOwner`, `SLSGetConnectionPSN`.
- **HIToolbox/CarbonCore:** `CPSNotifyKeyFocusTaken`, `CPSNotifyKeyFocusReturned`, `CPSNotifyLostKeyFocus`, `CPSNotifyLostTypingFocus`, `CPSNotifyTypingFocusChanged`, `CPSNotifyNewFront`, `CPSNotifyKeyFocusChanged`, `CPSEnableForegroundOperation`, `SetFrontProcessWithOptions`, `GetFrontProcess`, `CGEventTapCreate`, `CGEventTapPostEvent`, `CGEventTapCreateForPSN`, `CGEventTapEnable`.
- **HIServices/ApplicationServices:** `_AXUIElementGetWindow`, `AXUIElementPostKeyboardEvent` (deprecated but present), `_AXUIElementPostKeyboardEvent`, `_AXObserverAddNotificationAndCheckRemote`.
- **CoreGraphics:** `CGEventPostToPid`, `CGEventSetWindowLocation` (also public `CGEventGetFlags`, `CGEventTapPostEvent` etc.).

Key mechanics and constants:

- **Focus-without-raise record** (yabai/cua/ours): 248-byte buffer, `[0x04]=0xF8`, `[0x08]=0x0D`, target window id LE at `0x3C..0x40`, `[0x8A]=0x02` defocus record to previous front PSN, then `[0x8A]=0x01` focus record to target PSN. Posted via `SLPSPostEventRecordTo(psn, buf)`; PSNs from `_SLPSGetFrontProcess` / `SLSGetWindowOwner + SLSGetConnectionPSN` / `GetProcessForPID` fallback. `_SLPSSetFrontProcessWithOptions` deliberately skipped in the background path (it raises + can trigger Space-follow); used with `kCPSUserGenerated = 0x200` only for exact make-key window work; `kCPSNoWindows = 0x400` for "front without raising all windows".
- **Make-key record variant** (for menu key-equivalents): `[0x04]=0xF8`, `[0x08]=0x01/0x02` (focus/defocus), `[0x3A]=0x10`, `[0x3C..0x40]=wid`, `[0x20..0x30]=0xFF`.
- **Keyboard auth envelope** (Chromium/Electron): build `SLSEventAuthenticationMessage` via the ObjC factory `+[SLSEventAuthenticationMessage messageWithEventRecord:pid:version:]` (selector exists macOS 15+; class exists 14; guard with `class_respondsToSelector`), extract the `SLSEventRecord*` from the CGEvent (probe offsets 24/32/16), attach with `SLEventSetAuthenticationMessage`. Use for keyboard only (mouse must NOT carry it, or it routes via a direct-mach path that bypasses `cgAnnotatedSessionEventTap` which Chromium's window handler needs). Skip the envelope for NSMenu key equivalents (they need the `IOHIDPostEvent` path; use a no-auth post for those).
- **Event fields:** `kCGEventTargetUnixProcessID = 40`, `kCGEventSourceUnixProcessID = 41`, `kCGMouseEventWindowUnderMousePointer = 91`, `...ThatCanHandleThisEvent = 92` (these four are public in headers); window number field 51 and private ids (55, 64, 66, 67, 69, 71, 73) from the community table. Mouse subtype = 3. Window-local point via `CGEventSetWindowLocation`.
- **Spaces:** current active Space via `CGSGetActiveSpace`/`SLSGetActiveSpace`; membership via `SLSCopySpacesForWindows(cid, 0x7, [wid])` one window at a time; display association via `SLSCopyManagedDisplayForWindow` + `SLSManagedDisplayGetCurrentSpace`; moving windows via `SLSMoveWindowsToManagedSpace`; programmatic switch via `SLSManagedDisplaySetCurrentSpace` (commit semantics; used by window managers); "instant switch without animation" via a synthetic dock-swipe gesture (fields 55 = 30 `kCGSEventDockControl`, 110 = 23 `kIOHIDEventTypeDockSwipe`, 123 = 1 horizontal, 124 progress, 129 velocity, 132 phase 1/4, posted to `kCGSessionEventTap`); macOS 27 changes the gesture payload to a serialized CGEvent field 4205 (community note), so treat as version-fragile.
- **Safety guards to copy:** `kill(pid, 0)` + `NSRunningApplication.activationPolicy != .prohibited` before posting to a pid; guard `GetProcessForPID` the same way (it can segfault otherwise); `timingSafeEqual` on any socket capability; never treat private-function return codes as delivery acks; never send the same event through two transports.
- Apple's synthetic-event defenses: since Mojave, synthetic events are blocked by default unless the user grants Accessibility, and protected prompts (TCC consent etc.) specifically ignore synthetic clicks. Do not build around bypassing that; it is both fragile and the wrong posture for a responsible open-source project.

### 4.4 Field notes from this machine (environment evidence)

- macOS 26.5.1 (build 25F80), arm64. Xcode 26.4; Swift 6.3; bun 1.4.2; node v26.5 (system) / 24.x (repo pin via `.mise.toml`); cargo/rustc 1.98.0 installed, but the provision script requires **exactly rustc 1.97.1** (it asserts) - plan the toolchain before building the driver locally.
- The assistant sandbox **kills freshly compiled binaries on exec** (SIGKILL / exit 137) and can pop a macOS Gatekeeper "Not Opened" dialog for the user. Do not execute compiled binaries from here; keep to node/bun/osascript and static checks. Verification of native binaries must happen in the user's normal session (or a signed app).
- Disk: ~97% used, ~17 GB free at the time of writing. `node_modules` for this monorepo is ~2.3 GB; `bun install` is fast from cache (~8 s); clean up after heavy installs; avoid large artifacts.
- The `cua-driver` telemetry/update-check are disabled by the host env; keep that.
- Two earlier reverts on this branch (`0e862235`, `7d503eb1`) reverted permission-flow fixes; check current intent before building on the permission flow.
- `docs/computer-use-cua/evidence/` has no rev-10..14 artifacts; rev-14 claims are source-level only right now.

## 5. The V2 plan (workstreams, parity, sequencing)

### 5.0 Principles to preserve

- Reliability first, predictable under failure (repo-level core priority). Never replay an uncertain action; fail closed; one transport per event; verify or report honestly (`verified` only on read-back).
- Keep the pinned-driver provenance: patch sha, native revision literal, handshake. Do not bypass the input-admission gate or cleanup-ack semantics; they encode hard lessons.
- Repo conventions apply: see `AGENTS.md` (bundle `fmt/lint/typecheck` into one final pass when authorized; never `bun test`, use `bun run test`; heavy checks only on request). No git worktrees; sequential subagents; keep the machine tidy.
- Kartik-facing style: no em dashes, plain language, no slop.

### 5.1 Engine strategy options (decision needed from Kartik)

- **Option A: continue the patched Rust `cua-driver`.** Fastest to parity; keeps the proven gate/liveness/verification work; the patch is already ~7.9k lines and will grow; upstream divergence management needed (fork vs upstream contributions).
- **Option B: new native Swift daemon (Codex-like).** Maximum control for AppKit/private-API work (CPS focus events, NSEvent-first construction, window motion, masking, cursor); but a rewrite that gives up the hardened gate/provenance work and duplicates the protocol.
- **Option C (recommended): hybrid.** Keep `cua-driver` as the transport/AX engine; add a thin native sidecar for the pieces awkward in Rust (synthetic focus belief, NSEvent-first events, level-25 masking, richer cursor). Smaller delta than B, fastest credible path past Codex.
- The decision gates which workstream items are patches vs new code. Get Kartik's call before deep implementation.

### 5.2 Workstream A: Input and focus isolation (the differentiator)

**Problem.** The user needs the agent to drive background apps while they keep typing elsewhere, with zero conflicts: "when I am working in an app, and typing something, and the agent is using an app in the background, and typing something, it gets conflicted"; the frontmost window sometimes loses focus; multi-space should "be close".

**Current state.** Exact `(pid, window_id)` admission; focus-neutral semantic text (no HID, no activation); per-pid delivery in the driver; Space-aware cancellation. Not yet: a certified isolation guarantee, three-target concurrency, or reach into apps that demand "NSApp.isActive" (Electron-class).

**Approach.**

1. Adopt the Codex-style synthetic focus enforcer as an opt-in layer for apps that need "believe active/focused" (CPS notifications + AppKit-defined events posted to pid; keep the three-flag policy so nothing is re-posted when not needed).
2. Keep masked real activation (raise user windows to level 25 + restore + optional overlay) as the _last_ rung, never the default, and never to replay an uncertain action.
3. Instrument focus theft: frontmost pid, key window, AX focused element, synthetic-event counters; assert no steals across runs.
4. Reconcile with the current no-transient-foreground rule: default stays background; `foreground` remains explicit per call.

**Acceptance.** Three concurrent targets typing while the human types in a fourth app; 10x repeat with zero focus/cursor theft; Electron matrix (VS Code, Slack, Notion, Cursor, WhatsApp) typing/clicking works with the result; Space churn does not wedge; regressions covered by fixtures + new tests.

### 5.3 Workstream B: Scroll v2 (user-visible pain)

**Problem.** macOS scroll is quantized (120 px notches, max 50), single-axis, no modifiers, no travel measurement, no correction; "the agent has trouble scrolling".

**Approach options.**

1. Extend the existing measurement pipeline to macOS (the non-macOS path already estimates travel + gearing; macOS branch currently skips it). Guard with the observation budget so it does not blow latency.
2. Prefer AX scroll actions when the element exposes them (`AXScrollDownByPage`-class), fall back to wheel.
3. Add 2-axis + modifier support in the driver patch (Swift-era engine had it).
4. Persist per-app gearing (currently runtime-only, per window id, manager lifetime).
5. Keep the safety semantics: half-frame clamp, fourth-unchanged refusal, no replay of uncertain scrolls.

**Acceptance.** Scroll fixture matrix across AppKit / Electron / webview apps; measured travel within tolerance; large scrolls land near target; no over-scroll; documented fallbacks; latency budget respected.

### 5.4 Workstream C: Speed

**Problem.** "It's not fast." Candidate contributors: host startup (~5 s bound), action settle (300 ms), observation budgets (100/350 ms), screenshots and tree walks, preview stream work, per-call round trips.

**Approach.** Define budgets first (p50/p95 for get*state, click, type, scroll, launch, turn start), instrument, then: prefer warm host at first touch; cut redundant captures (reuse frame registry); conditional settle (skip when a read-back already proves the effect); AX-only fast path for get_state when requested; check JPEG quality/size; consider prewarmed cursor; keep everything env-tunable (`SYNARA_CUA*\*` pattern) for A/B.

**Acceptance.** Before/after latency table on a fixed scenario set; no reliability regressions; budgets documented in the repo.

### 5.5 Workstream D: Capability parity + beyond (parity matrix seed)

Codex surface to match: list_apps, get_app_state (skyshot), click, drag, scroll, type_text, press_key, set_value, perform_secondary_action, paste, select_text, get_screenshot, launch_app, list_windows, activate_window (plus window2/full-desktop variants in their stack).

Ours today: list_windows, get_state, screenshot, get_screen_size, wait, click/double/triple/right, move, drag, scroll, type, press/hotkey, set_value, perform_action (macOS named AX actions — press/AXPress, open, show_menu/menu, pick, confirm, cancel — fail-closed on unadvertised targets), paste, read/write clipboard, launch, activate, run batch.

Known gaps to evaluate: menus (`invoke_menu` currently unexposed), window frame ops (`set_window_frame` unexposed), hover/none, 2-axis/modified scroll, background drag on macOS (foreground-only today), mixed-scale/secondary displays, locked use (Codex-style authorization plug-in), Chrome via CDP (Codex does not use AX for Chrome), record & replay / computer history (optional), richer virtual cursor motion, multi-cursor for parallel agents, Intel slice execution.

Beyond-parity ideas: verification receipts for every mutating call, smarter scroll, faster observation, protocol-level openness (any agent), crash-safe liveness (already strong), better permissions UX (see pi-computer-use flow), configurable safety tiers (denylists, audit log).

Decide with Kartik which of these are in the "parity first" milestone vs "later".

### 5.6 Workstream E: Reliability, evidence, packaging

- Re-certify at rev 14 with a freshly signed app + fresh TCC grants: three-target run, human-foreground run, off-Space semantic run, screenshot-freshness refusals, hidden/minimized refusals, identity churn. Produce evidence in the existing pattern (`docs/computer-use-cua/evidence/`).
- Evaluate the canonical Lume harness path (SIP-disabled VM + signing keychain) for the strongest certification.
- Production signing/notarization plan for the CU helper; document the permission-identity rules (ad-hoc rebuild changes identity; grants attach to signed bundle; stale-grant advice exists in `computerSetupSignal`).
- Crash-safety review: host/daemon death paths, orphan sweep, panic exit; disk-safe builds.

### 5.7 Workstream F: Open-source boundary and governance

- Decide what ships open: likely the driver patch + host protocol + tools + docs (MIT/Apache), either as its own project or upstreamed into trycua/cua; Synara product code can stay whatever it is. Keep `CUA-LICENSE.txt` attribution; Synara repo is MIT (T3 Tools Inc + Emanuele Di Pietro).
- Guardrails to ship with it: visible session state (like "ChatGPT is using your computer" + Esc stop), per-app approvals, password-manager denylist, audit log, kill switch, no evasion/anti-detection, no TCC bypass, and a disclosure process if a consent-bypass-class bug is ever found.
- Earlier malware-risk assessment (keep the conclusion): the capability class has been public for a decade (FruitFly 2017 synthetic input, DevilRobber 2011, Wardle synthetic-click work 2018/19, Cua/pi/OSAurus open engines); the abuse bottleneck is TCC consent + distribution, neither changed by our code; marginal risk of open-sourcing is low; design for misuse resistance anyway.

### 5.8 Sequencing proposal

1. Parity matrix + specs (docs; see sections 6.4).
2. Close open questions (6.6), especially the 26.4 hazard and scroll approach.
3. Implement A -> B -> C -> D (A first: differentiator + biggest pain; B next: user-visible; C cross-cutting; D breadth).
4. E: packaged certification + evidence + signing plan.
5. F: open-source extraction + docs + governance notes.

---

## 6. How to continue (setup, verification, next steps)

### 6.1 Working copy and hygiene

- Work in `/Users/user/synara-computer-use` (branch `agent/computer-use-preview`). `git fetch origin` + `git fetch upstream` to refresh; check for commits after `bb7eb421c`.
- `bun install --frozen-lockfile` to restore `node_modules` (~8 s from cache). Remove it again if disk gets tight.
- Do not push to `kartikkabadi/synara` or update PR #1227 without Kartik's explicit go; keep commits local. The PR is his draft and the branch is shared with other workflows.
- No worktrees. Sequential subagents. Keep the home dir tidy (Kartik cares).

### 6.2 Sandbox rules (critical for this assistant context)

- Freshly compiled binaries get **killed on exec** in this sandbox and can trigger a Gatekeeper "Not Opened" dialog for the user (this happened with a test binary named `.tc-test`; do not repeat). Do not leave stray binaries in the repo.
- Safe here: file reading/writing, `git`, `bun`, `node`, `osascript`, compile-only checks (`cargo check`), and any suite that runs entirely under node/bun.
- Not safe here: running built binaries, `cargo test`/`cargo run` (executes test binaries), the native fixtures, anything needing TCC.

### 6.3 Verification tiers (what to run where)

- **Tier 0 - docs/static:** reading, matrix/spec updates, evidence review.
- **Tier 1 - sandbox-safe:** `bun install --frozen-lockfile`; targeted Vitest suites (`apps/server`, `apps/web`, `apps/desktop` per package scripts); `cargo check -p cua-driver` inside a provisioned source tree (needs rustc 1.97.1 + patch applied); typecheck/lint/fmt only when authorized (bundle them once at the end).
- **Tier 2 - user session, no input:** fake/unavailable backend suites; desktop host tests; boot the app with CU disabled; read logs (`~/.synara-cua/userdata/logs` on the older build; check current paths).
- **Tier 3 - user session, real input:** the cua fixtures (`apps/desktop/src/cuaFixtures/{native,electron,gateway,live,cancellation}.ts`): `electron.ts` builds a three-window fixture app through the real `CuaDriverHost` + `CuaComputerBackend`; `native.ts` requires pid + exact title + WindowServer-id agreement before any input; `gateway.ts` exercises the real gateway chain; `live.ts` runs the production server on loopback with a socket proxy restricting input to an owned window (≤1 background click). Then packaged signed-app runs for the certification list.
- **Tier 4 - canonical harness:** Lume VM with SIP disabled + signing keychain + GUI + TCC grants (documented in `docs/computer-use-cua/README.md` and `qualification.md`).

### 6.4 Immediate next steps (ordered)

1. Fetch/refresh the clone; diff against `bb7eb421c`; check PR #1227 for new comments.
2. **Check the macOS 26.4 `SLEventPostToPid` hazard against our driver** (where it is called in the pinned source + patch; whether a PSN fallback exists; plan the fix). This is the top crash-risk item.
3. **Verify the CPS notification constants empirically** (Operon vs cua-rs tables disagree). Use a signed scratch helper in the user's session, or inspect actual Codex behavior with a minimal target app.
4. Re-read `docs/computer-use-cua/README.md`, `capability-audit-2026-09-16.md`, `integration-refresh.md` for the exact current contract + unproven list.
5. Build the **parity matrix** doc (seed in 5.5) with a column per capability: Codex / ours / target / notes / evidence.
6. Write the **workstream specs** (A-E) with acceptance criteria, interfaces, tests, risks; then the **task briefs** for implementers (self-contained prompts with scope, files, dependencies, done-proof).
7. Ask Kartik for the decisions in 5.1/5.5/5.6 before deep implementation.

### 6.5 What to check first (checklist)

- [ ] Branch state: new commits after `bb7eb421c`; PR #1227 status/comments; any new artifacts.
- [ ] 26.4 hazard: does our code path call `SLEventPostToPid` pid-first? Test/canary or gate with `SLEventPostToPSN` on 26.4+.
- [ ] CPS constants: which table matches this OS? Resolve before implementing the focus enforcer.
- [ ] Permission flow: confirm current state after the two reverts (`0e862235`, `7d503eb1`).
- [ ] Scroll: capture current behavior on 3-4 apps (notches, travel, failures) as a baseline.
- [ ] Focus theft instrumentation: does anything today track frontmost/key-window changes? (If not, add it for WS-A verification.)
- [ ] Evidence gaps: no rev-10..14 artifacts in `docs/computer-use-cua/evidence/`; plan the certification run.
- [ ] Disk headroom before any install/build; clean up after.
- [ ] rustc 1.97.1 available for driver builds (provision script asserts exact version).
- [ ] Handshake coupling: `serve.rs` native revision literal vs `cuaDriverRelease.json` before any bump.

### 6.6 Open questions (resolve before/during implementation)

1. **26.4+ compatibility**: `SLEventPostToPid` pid-first vs `SLEventPostToPSN` (Osaurus fix) - does our pinned driver crash on 26.5.1? How: read driver source + patch call sites; run a canary post to a scratch app in the user session.
2. **CPS constants**: Operon (0x8000 taken / 0xF102 returned) vs cua-rs (0x8000 returned / 0x4000 taken / 0xf102 changed). How: disassemble or empirically test focus events on this OS.
3. **Engine strategy** (A/B/C from 5.1): Kartik decision.
4. **Scroll approach**: measurement on macOS vs AX-first vs patch-level 2-axis/modifiers; which budgets are acceptable. Kartik decision + measurements.
5. **"Faster" definition**: which operations matter most (turn start? per action? preview?). Kartik input + baseline timings.
6. **Focus isolation semantics**: what should happen when the human grabs the same app/window mid-action? (pause? queue? cancel? per the current `inputPause` semantics, extended design needed.)
7. **Open-source boundary** (5.6): what ships, where (own repo vs upstream cua), under what license; Kartik decision.
8. **Parity scope**: are menus/window-frame/locked-use/Chrome-CDP in the "parity first" milestone?
9. **Cursor/overlay**: adopt Codex-style motion + multi-cursor, or keep the compact cursor? (Visual identity decision.)
10. **Chrome**: AX path vs CDP integration for browser control (Codex uses CDP; we currently rely on AX with `AXManualAccessibility` fallback).
11. **Certification environment**: Lume harness availability (SIP-disabled VM, signing keychain) vs local signed-app runs only.
12. **Upstream strategy**: keep the Synara patch as a patch file vs fork; contribute upstream fixes (like the input gate) to trycua/cua?

## 7. Risks and gotchas (keep this list visible)

- **Private API drift**: layouts/constants change across macOS releases (26.4 example). Every private path needs availability flags, version gates, and fail-closed fallbacks; never make one API the only route to a capability without a documented refusal path.
- **Argument-order hazards**: `SLEventPostToPid` (26.4 change) and similar binary-compat shocks cause hard crashes, not graceful failures. Prefer canary checks in a scratch process before shipping a version bump.
- **TCC identity churn**: grants attach to the signed app bundle; ad-hoc rebuilds can strand grants (stale signature); the repo already has stale-grant advice + a fresh-child recheck pattern. Keep the CU helper's signing identity stable.
- **Gatekeeper/sandbox interactions in agent contexts**: compiled binaries can be killed on exec here; a stray test binary can scare the user with a "Not Opened" dialog. Never leave binaries behind.
- **Disk pressure**: the Mac is nearly full; installs/builds must be budgeted and cleaned up; `node_modules` is 2.3 GB for this repo.
- **Shared branch discipline**: PR #1227 is a draft on a shared fork; do not push without Kartik; do not force-push or rebase public history.
- **Patch/manifest coupling**: bumping `nativeRevision` in the manifest without the `serve.rs` literal breaks the handshake and retires daemons; always bump both.
- **"Never replay uncertain"**: the whole error taxonomy (`not-dispatched` / `dispatched-unknown` / `verified`) exists to stop duplicate actions. Do not add retries that violate it.
- **Electron/menu edge cases**: real activation causes menu-bar flash; menu dismissal suppression matters; double-click pairing must stay atomic (500 ms window logic exists on the web side).
- **Permission flow reverts**: two permission-flow fixes were reverted on this branch; confirm intent before re-landing anything there.
- **Evidence discipline**: the repo distinguishes source-level checks from packaged/runtime proofs; keep that separation explicit (it is a feature, not bureaucracy).

## 8. Suggested skills for the next agent

Call these via the Skill tool as you work (account skills live in `/Users/user/.agents/skills/`; repo-local ones in the working copy's `.claude/skills/`):

- **`codex-computer-use`** - drive apps on this Mac through Codex's Sky runtime for hands-on verification/evidence capture (reads the official plugin skill; connects to the running `SkyComputerUseService`). Use when you need to observe/compare real behavior.
- **`verify`** (repo-local, `.claude/skills/verify`) - verification discipline before claiming anything done.
- **`react-doctor`** (repo-local) - changed-surface quality checks for the web side (the PR used it).
- **`performance-engineer`** - for the Speed workstream (budgets, profiling, regressions).
- **`research`** / **`link-research`** - for continuing external research and keeping citations.
- **`hygiene`** (and **`commit`**) - keep the repo/branch clean; small, coherent commits.
- **`thermo-nuclear-code-quality-review`** - deep review passes before proposing PR updates.
- **`full-stack-e2e-review`** or **`devin-review`** - end-to-end review passes when a milestone lands.

## 9. Reference index

### 9.1 Local paths

- Working clone: `/Users/user/synara-computer-use` (branch `agent/computer-use-preview` @ `bb7eb421c`).
- Docs: `docs/computer-use-cua/` (README, qualification, integration-refresh, capability-audit-2026-09-16, final-checks-and-comparison, permission-guide, permission-flow-fix, native-preview, task-invocation-and-consent, optimization-and-readiness-plan, CUA-LICENSE.txt, import-provenance.json, `evidence/`).
- Patch + provisioning: `apps/desktop/patches/cua-driver/{0001-synara-native.patch,README.md}`; `apps/desktop/scripts/provision-cua-driver.mjs`.
- Host: `apps/desktop/src/{cuaDriverHost.ts,computerDesktopLifecycle.ts,computerFrameTap.ts,stopNativeHelper.ts}`, `apps/desktop/src/cuaFixtures/`.
- Server: `apps/server/src/computer/*`, `apps/server/src/agentGateway/{computerTools.ts,computerGuidance.ts}`.
- Web: `apps/web/src/components/computer/*`, `components/chat/Computer*`, stores/hooks/lib under `apps/web/src`.
- Pins: `packages/shared/src/cuaDriverRelease.json`, `packages/shared/src/cuaDriverProtocol.ts`.
- Codex on disk: `~/.codex/computer-use/Codex Computer Use.app`; `~/.codex/plugins/cache/openai-bundled/computer-use/`; `/Applications/ChatGPT.app/Contents/Resources/{cua_node,native}`.
- Skills: `/Users/user/.agents/skills/`; repo `.claude/skills/`.
- Memory: `/Users/user/synara/.mind/` (`python3 .mind/runtime.py recall|capture ...`).
- Other checkouts: `~/synara-cua` (older rev-5 corpus), `~/synara-wt/cua-port` (stale), `~/background-computer-use`, `~/pi-computer-use`.

### 9.2 URLs

- Synara PR #1227: `https://github.com/Emanuele-web04/synara/pull/1227` (head `kartikkabadi/synara:agent/computer-use-preview`).
- Synara PR #1090: earlier native CU port.
- OpenAI Codex CU: `https://openai.com/index/codex-for-almost-everything`, `https://developers.openai.com/codex/app/computer-use`, `https://openai.com/index/introducing-the-codex-app`.
- Codex CU issues: `openai/codex` #25321 (composer focus), #26293 (orphans), #28479 (CODEX_HOME), #18755 (macOS 14 crash), #32210 (Swift symbol crash), #35234 (sender auth).
- trycua/cua: `https://github.com/trycua/cua` + `blog/inside-macos-window-internals.md`.
- Osaurus: `https://github.com/osaurus-ai/osaurus` (`Packages/OsaurusCore/ComputerUse/Driver/Mac/SkyLightBridge.swift`; appcast note: route Skylight input through `SLEventPostToPSN` on macOS 26.4+, #2316).
- Operon: `https://github.com/nickqiaoo/Operon` (`native/computer-use/Sources/OperonAccessibilitySupport/{SynthesizedFocusEvent,SyntheticAppFocusEnforcer,SystemFocusStealPreventer}.swift`).
- cua-rs-mcp: `https://github.com/maestrojeong/cua-rs-mcp` (`crates/cua-hid/src/nsevent.rs`, `examples/slps_click_probe.rs`).
- open-codex-computer-use: `https://github.com/iFurySt/open-codex-computer-use`.
- wisp writeup: `https://github.com/missuo/wisp` (`DESIGN.md`).
- paralym replica: `https://github.com/paralym/codex-computer-use-cli`.
- Notch-Agent: `https://github.com/Puggo1145/Notch-Agent`.
- skylight-cli: `https://github.com/Hannahmana/skylight-cli`; SkyLightWindow: `https://github.com/Lakr233/SkyLightWindow`.
- yabai: `https://github.com/koekeishiya/yabai` (`src/window_manager.c` `window_manager_focus_window_without_raise`); InstantSpaceSwitcher: `https://github.com/velppa/InstantSpaceSwitcher.spoon`; alt-tab-macos: `https://github.com/lwouis/alt-tab-macos`.
- pi-computer-use: `https://github.com/injaneity/pi-computer-use`; background-computer-use: `https://github.com/actuallyepic/background-computer-use`.
- MacStories on Codex CU: `https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested`.

### 9.3 Commit / checksum quick refs

- HEAD `bb7eb421c` (rev 14 hardening); `05910def` (foreground restore); `4ea386f8` (activity feedback); reverts `0e862235`, `7d503eb1`; fixes `4d6551c25`, `e21888628`; revs: `75428eed` (5), `3924e2ea` (6), `3504edb2` (7), `2879ad8e` (8), `eed8aa21`+`c2af61b3` (9), `2c38af1f` (1).
- Patch sha `3375ac1c2fe8266672ac1735b8514a8f2f692a64b19d415630745478d0c19a32`; upstream archive sha `31790cb49baa206f6455fbc259f8f83ae27e86be908f5c8cac5ec2f8521f8382`; driver source rev `4b3396d9fe4bd3cf723b0eb8db83c18a8764b520`; driver `0.24.0`; upstream rust pin `1.97.1`.

## 10. Appendices

### Appendix A: constants quick reference

- **Focus record (248 bytes)**: `[0x04]=0xF8`; `[0x08]=0x0D`; window id LE at `0x3C..0x40`; `[0x8A]=0x02` (defocus previous front) then `[0x8A]=0x01` (focus target); posted `SLPSPostEventRecordTo(psn, buf)`.
- **Make-key record variant**: `[0x04]=0xF8`; `[0x08]=0x01/0x02`; `[0x3A]=0x10`; `[0x3C..0x40]=wid`; `[0x20..0x30]=0xFF`; paired after `_SLPSSetFrontProcessWithOptions(psn, wid, 0x200)`.
- **`_SLPS` options**: `kCPSUserGenerated = 0x200`; `kCPSNoWindows = 0x400`.
- **CPS subtype tables (conflicting; verify)**: Operon - `KeyFocusTaken 0x8000`, `KeyFocusReturned 0xF102`; cua-rs - `KeyFocusReturned 0x8000`, `KeyFocusTaken 0x4000`, `KeyFocusChanged 0xF102`, `NewFront 2`, `LostKeyFocus 0x1000`. NSEvent type for process notifications = `21`.
- **CGEvent fields**: 3 button; 7 subtype (=3); 40 target unix pid; 41 source unix pid; 51 window number (private); 91/92 window under mouse / can handle; private table 51,55,64,66,67,69,71,73 (availability-flagged).
- **Timing/quantities**: humanClickInterval 0.1 s; scroll notch 120 px, max 50 notches, single-axis; settle 300 ms; foreground observation 100 ms / background 350 ms; paste restore 250 ms; scroll probe 48 px; host startup bound 5 s; cancel_input 5 s; frame cap 4 MiB; preview ~12.5 fps; approval caps 128/8; queue limit 64; frame queue 8 / 2 MiB.
- **Host env**: `CUA_DRIVER_EMBEDDED`, `CUA_DRIVER_HOST_BUNDLE_ID`, `CUA_DRIVER_PERMISSION_MODE`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`, `SYNARA_CUA_FOREGROUND_OBSERVATION_MS`, `SYNARA_CUA_BACKGROUND_OBSERVATION_MS`, `CUA_DRIVER_PARENT_LIVENESS_STDIN`, `CUA_DRIVER_EMBEDDED_HOST_PID`, `CUA_DRIVER_RS_HOME`.
- **Retire ack fields**: `input_admission_closed`, `cleanup_complete`, `pending_input == 0`, `pid == expected_pid`.
- **Tools**: perception `list_windows/get_state/screenshot/get_screen_size/wait`; mutating (approval) `read_clipboard/launch_app/click/double_click/triple_click/right_click/move_cursor/drag/scroll/type_text/press_key/hotkey/write_clipboard/set_value/perform_action/paste/run/activate_window`.

### Appendix B: evidence and measurement inventory

- `docs/computer-use-cua/evidence/`: rev-1 records (fixture/gateway/native/live before-after PNGs + report/resource JSONs), `refresh-2026-09-08/` (verification ledger, source integrity, native provenance/reconstruction/patch summary, independent reviews), `final-checks-2026-09-08/` (verification, checks, comparisons), calculator + compact-cursor artifacts, preview/suspension smoke logs.
- Recorded numbers: 421 server / 137 frontend / 12 desktop host / 60+6 native rev-2 tests; tree walk 673 -> 207 ms; orphan sweep 6+ min -> ~1 s; 12.5 fps preview; 699,469 -> 475 B retained ingress; rev-1 peak 307.84 MiB.
- Gap: no rev 10-14 evidence artifacts; rev-14 certification not run.

### Appendix C: prompt seeds for implementers

1. **Parity matrix author:** "Read `/tmp/synara-cu-v2-mega-handoff-2026-09-16.md` sections 3-5 and the repo at `/Users/user/synara-computer-use`. Produce `docs/computer-use-cua/v2-parity-matrix.md`: one row per Codex CU capability (incl. behaviors: background input, focus handling, skyshot/settle, cursor, approvals, spaces, locked use, Chrome/CDP), with columns Codex / ours / gap / target / evidence / notes. Cite files and docs. Mark every unverified claim."
2. **Focus-enforcer feasibility (pre-implementation):** "Read sections 4.1 and 4.3. In the user's session, write a small signed helper (or use osascript probes) to (a) confirm the safe argument order of `SLEventPostToPid` vs `SLEventPostToPSN` on macOS 26.5.1 by posting a harmless event to a scratch app, and (b) empirically resolve the CPS subtype constants by testing the AppKit-defined/processNotification events against a fixture app. Return a short report with exact constants and any crashes."
3. **Scroll v2 spec:** "Read sections 3.3, 3.6, 4.1 (scroll) and the current code (`CuaComputerBackend.scroll`, `ComputerManager.scrollCalibrated`, `scrollCalibration.ts`, `scrollUnits.ts`, driver `tools/scroll.rs` + `input/mouse.rs` in the patch). Produce a spec: measurement-on-macOS design (budgets + fallbacks), 2-axis/modifier support, per-app gearing persistence, acceptance matrix (AppKit/Electron/webview), and the test plan. Do not implement yet."

### Appendix D: provenance and maintenance

- Produced by the Aside agent session `I0UdxznQh9nis05h` on 2026-09-16, from: (1) the full conversation research (Codex internals + macOS private APIs + prior art), (2) three read-only recon passes over `/Users/user/synara-computer-use` (native/host; server/web; prior-art repos), (3) live symbol probing on this Mac.
- Copies: `/tmp/synara-cu-v2-mega-handoff-2026-09-16.md` (this file) and the Aside session artifacts copy.
- Maintenance: when re-verify items are closed (26.4 hazard, CPS constants), update sections 4.3/6.6 and bump a revision note here. When rev-14 certification lands, update Appendix B.

## 11. Addendum (late 2026-09-16): agent Spaces, background windows, decision shortlist

Added after a final round of review questions. Fold these into the workstream specs when writing them.

### 11.1 Agent Spaces (one desktop per agent, the user keeps theirs)

- Model: the user keeps one Space (their home desktop, e.g. Desktop 1). Agents get dedicated Spaces, one per agent by default, managed as a pool: create seats at setup or idle time, assign on demand, recycle when the agent finishes.
- macOS mapping: these are the Mission Control desktops (F3 or three-finger swipe up; "+" in the top right creates a new one). Fullscreen windows also appear in that row as their own Space.
- Enforcement: the input gate must only allow input to windows whose Space membership is inside the agent's assigned Space set. The user's current Space is excluded by default; "never use my space" is enforced at the gate, not trusted.
- Concurrency: only one Space per display is current and visible at a time; agents do not need visibility. Input and observation go directly to their windows on non-current Spaces, so multiple agents can work while the user uses their own Space.
- Creation: the fast private operations (list Spaces, set current, move windows between Spaces, membership add/remove) are verified on this Mac. Creating new Spaces goes through Mission Control automation (the same approach yabai uses): slower and briefly visible, so prefer the pool and create only at setup or during idle.
- Catch: if the user switches Spaces mid-action, existing semantics cancel focus-sensitive actions (already implemented); keep that.
- UX: watch via Mission Control live thumbnails or the in-chat live preview; a "jump to this agent's Space" button can switch instantly using the private switch mechanism, and back.
- Caveats to verify: App Nap throttling of off-screen apps (live preview freshness); apps that try to re-place themselves onto a preferred Space; per-display Space sets when "Displays have separate Spaces" is on; agent windows stay non-fullscreen (fullscreen takes over a whole Space with an animation).

### 11.2 Background window creation (the Chrome scenario)

- Scenario: the user works in a fullscreen Chrome on their Space; the agent creates and works in its own Chrome window(s) with zero user impact.
- Path 1 (same Chrome, background): targeted Cmd+N / menu action delivered to the Chrome pid with no activation. Open questions: where macOS places the new window (user's current Space vs Chrome's fullscreen Space), and whether Chrome self-activates on window creation. Both need a fixture test.
- Path 2 (recommended default): a separate Chrome instance with its own user-data-dir, launched in the background (`open -g -na`), optionally with a remote debugging port for the CDP path. The user's Chrome process is untouched by construction.
- Mitigations if any app self-activates: focus-steal prevention (workstream A) plus immediate restore of the user's frontmost window (already in the branch); Space-change cancellation (already in the driver).
- Acceptance: with the user typing in their own app and their fullscreen Chrome on their own Space, the agent creates a window, works in it, and the user sees no Space switch, no focus change, no cursor movement; keystrokes never cross.

### 11.3 Decision shortlist (needed before deep implementation)

Consolidated from section 6.6, with a recommended default so work can proceed if the user does not answer yet:

1. Engine: A) patched Rust cua-driver, B) new Swift daemon, C) hybrid. Recommend C: keep the driver, add a thin native sidecar for the focus/event-belief work.
2. Open-source boundary: recommend the driver, host protocol, tool layer, and docs ship open (permissive license); product code stays as is.
3. Parity-first scope: recommend menus, window frames, and Chrome/CDP in; locked use, record/replay, and Intel slice out of the first milestone.
4. Speed budgets: recommend a published latency table with p95 targets for get_state/click/type/scroll measured warm; ask the user which operations matter most.
5. Certification environment: recommend local signed-app runs first, the Lume VM harness for final sign-off.
6. Cursor/overlay identity: recommend a per-agent cursor with richer motion (identity plus multi-agent clarity).
7. Agent-Spaces defaults: user's Space never assigned; pool size default 2-4; create at setup/idle, never mid-session churn.
8. Chrome default: separate instance profile for agent browsing; the user's Chrome is off limits unless explicitly allowed per session.

### 11.4 Note for implementer agents about this environment

- The "no compiled binaries" restriction in section 6.2 applies to the sandboxed assistant that wrote this doc. An implementer running as a normal process on this Mac (Terminal, Codex CLI, Claude Code) can build and run native code; verify once, then treat verification tiers 2 through 4 as available.
- Clone needs `bun install --frozen-lockfile`; native provisioning needs rustc exactly 1.97.1; disk headroom is tight, so clean caches and node_modules when done and never leave stray binaries in the repo.
- Branch discipline unchanged: local commits only; no pushes to the shared fork (kartikkabadi/synara) or PR updates without the user's explicit go-ahead.
- Section 6.5 (check-first checklist) stays the gate for week one: the macOS 26.4 hazard, the CPS constants, the scroll baseline, and the Chrome fixture test.

---

_End of handoff. If you are the next agent: read section 0, then 3, then 4, then 6, then 11. Do not run compiled binaries from the assistant sandbox (implementers in normal local terminals can). Confirm the section 11.3 decisions with Kartik, or proceed on the recommended defaults in writing. Keep this document accurate as you go._

---

# UPDATE 2026-09-17 (evening): rev 16 shipped

> Appended after the rev-16 commits landed. Where earlier text disagrees,
> this block wins.

- **Driver is now native revision 16** on the same 0.28.2 source pin;
  patch sha `46f7a8cfbb51d18eb3eb91da88b488e5c42fc92bfa91a717dae3fadd43050ee0`.
  Commits `7eeb083d4` (six milestone tools) and `78bc88bae` (scroll v2)
  landed on the branch.
- **Scroll v2 is implemented and live-verified on TextEdit.** Signed
  `delta_x`/`delta_y` ticks (±50 per axis) plus modifiers post as one
  pixel-unit wheel gesture; unmodified vertical element scrolls prefer AX
  scrollbar presses; macOS measures before/after travel inside a
  2-leg/3-capture budget and learns route-keyed gearing with a durable
  per-app file. Known limit: TextEdit ignores horizontal wheel deltas
  (NSScrollView wants continuous trackpad deltas). The section-0 weakness
  "macOS scroll is quantized and unmeasured" is no longer current.
- **The three-window typing failure (G5) is closed** via verified
  `set_value` compose on web-content elements; the fixture passed 10x with
  sentinel focus held. See
  `docs/computer-use-cua/evidence/fixture-g5-set-value-2026-09-17-notes.md`.
- **Belief work is dead by experiment** (input matrix): six stages
  including a real front-process flip cannot manufacture a key window, and
  process-scoped CGEvent never reaches an inactive renderer. Electron
  background scroll/type via CGEvent is likewise dead; the `browser_*` CDP
  surface is the fix path and is being built separately.
- **Space creation is in progress, blocked at display-attach:**
  `SLSSpaceCreate` yields orphaned type-3 spaces that `SLSShowSpaces` does
  not attach; SLS move/add/compat-id calls are silent no-ops on foreign
  windows under SIP. `open -g -n -a` is verified as the silent launch
  form; `open -n -a` steals focus (fixture bug, fix in flight).
- **Agent-facing tool count is 31** (the six milestone tools plus
  `computer_get_accessibility_tree` and `computer_get_cursor_position`,
  now exposed as read tools).
- This machine has a provenance quirk: a freshly built binary can be
  killed by Gatekeeper (`Killed: 9`) until the file is rewritten
  (`cat f > t && mv t f`). One line, real debugging time.
