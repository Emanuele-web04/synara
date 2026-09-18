# Synara Computer Use — v3 completion plan

Status: active working plan (2026-10-02). Base: `pr-1227` @ `c052a8c38`,
packaged cua-driver 0.28.2 / native rev 20 / source `fc188250b`. Supersedes
nothing; extends the parity matrix and open-decisions sheet. Every phase ends
in verified evidence or an honest open item — no "done" without a read-back.

## North star

Full macOS computer use for agents — no capability left behind — with the
operator never disturbed: per-pid background delivery, hidden/invisible
workspaces, concurrent targets, multi-Space workflows, masked activation,
physical Escape, per-app grants, locked-use safety, structured recording,
external-agent access, and a tight live gate that proves all of it on every
change. Then the same surface on Windows and Linux.

## What is already true (verified, not aspirational)

- Background delivery into visible non-key windows, hidden apps, and
  minimized windows (`set_value` confirmed + read-back) — rev 20.
- Concurrent writes to different windows; same-window semantic lane
  serialization; operator-vs-agent typing isolation proven bidirectionally.
- `SLSManagedDisplaySetCurrentSpace` programmatic Space switching (1→62→1
  verified); MC AX add-desktop provisioning; launch-onto-Space (no move API
  needed — windows land on the active space).
- Off-Space reality: enumerable via CGWindowList, AX-empty → semantic ops
  refuse correctly. Window moves between Spaces are entitlement-dead
  (universal-owner) — formally closed.
- External MCP `computer:control` scope live end-to-end; agent→approval→
  driver→TextEdit write proven on the merged tree.
- Per-app grants, locked-use revocation, Escape kill switch, masked-activation
  shield, bounded recording+replay — all merged, unit/integration green.
- `open -g` launches without focus steal; driver `launch_app` already
  `setActivates(false)` + `hidden` option.

## Honest gaps (the real list)

1. No single live gate — verification is scattered across /tmp scripts and
   narrative certs. Slow to re-run, easy to skip.
2. "Invisible workspace" is not a product behavior — hidden launch exists in
   the driver but is not wired as the default agent-target policy.
3. Masked activation: unit + binary smoke only; no live shield→activate→
   op→release run; Electron-class apps still unreachable.
4. Recording/replay: fake-backend only; no live desktop run.
5. Escape switch: binary smoke only; no live key press through the merged
   host→server→driver chain.
6. Grants/locked-use: no live UX runs.
7. Second display: harness ready, hardware-pending (needs a 2-display Mac).
8. Speed: no measured latency budget (handoff workstream C never ran).
9. Screenshot freshness refusals: uncertified.
10. Cross-platform: driver supports it upstream; Synara gates on darwin.
11. ComputerManager is 5.4k lines post-merge — six features, parallel seams;
    no refactor pass yet.
12. Unused private-API inventory: `SLSHWCaptureWindowList` fast capture,
    dock-swipe instant switch, `CGSSetWindowLevel` masking variant,
    focus-theft suppression taps, CPS type-21 notifications (dead for
    key-window manufacture — proven).

---

## Phase 0 — The tight loop (keystone; everything else gates on it)

**Deliverable:** `scripts/computer-use-fixtures/live-cert.ts` —
one command, ~60–90 s, zero operator interaction.

- Boot trusted host + packaged driver (merged code), isolated SYNARA_HOME.
- Spawn targets: `open -g` visible, `open -j` hidden, minimized, second
  TextEdit instance — never steal frontmost.
- Invariant monitor (~50 Hz): frontmost pid, key window, active Space,
  focused element, cursor position — sampled *during* every op, not just
  before/after. Any unexpected transition = assertion failure.
- Named-assertion matrix (each emits pass/fail + evidence):
  launch isolation · hidden write+readback · minimized write · visible
  non-key write · 3-window concurrent writes · operator-typing interleave
  (CGEvent sim) · Space round-trip (set-current→act→back) · masked
  shield engage/release · Escape latch · recording start/stop/replay-dry
  · grant create/cover/revoke · cancellation mid-type · stale-token
  refusal · screenshot freshness · off-Space refusal correctness.
- Output: one `report.json` + one `-notes.md` under
  `docs/computer-use-cua/evidence/`; exit non-zero on any failure.
- Reuses: `focus_probe.m`, `space_ctl.m`, `display_ctl.m`, existing
  fixture builders. Wire as `bun run cert:live` (package script).

**Gate rule:** unit tests → `live-cert` → commit. Refactors and the rebase
must pass it before and after.

## Phase 1 — macOS depth completion

1. **Invisible-workspace policy** (highest value): wire the driver's
   `hidden` launch option into `computer_launch` + a per-thread
   "invisible workspace" mode — agent targets launch `open -j`-style on the
   operator's Space. Hidden apps keep AX alive (verified) while rendering
   nothing. This is strictly better than a second Space for semantic work:
   off-Space kills AX; hidden keeps it. Dedicated Space stays the fallback
   for pixel-visible work needing real activation.
   Accept: live-cert row — hidden-launched TextEdit write confirmed,
   nothing rendered, frontmost untouched.
2. **Masked activation live cert + hardening**: real shield→activate→
   `set_value`→restore→release run against a canary app; optional
   transparent level-25 overlay variant (own window — feasible; foreign
   `CGSSetWindowLevel` is entitlement-dead). Keep fail-closed.
3. **Electron-class apps**: the known-dead path. Spike: masked real
   activation + focus-belief records (CPS type-21, constants resolved from
   Codex's binary) + theft-suppression taps. Canary-gated; if belief can't
   manufacture key focus (our earlier proof), masked activation is the
   only honest rung — document which Electron apps accept it.
4. **Speed budgets**: p50/p95 table for get_state/click/type/scroll/
   launch/turn-start on a fixed scenario set; then targeted cuts
   (conditional settle, frame reuse, `SLSHWCaptureWindowList` fast
   capture path). No reliability regressions.
5. **Screenshot freshness refusals** live cert.
6. **Remaining tool gaps**: hover verdict status, secondary actions
   beyond AXPress, multi-cursor for parallel agents (P2).

## Phase 2 — Driver rebase to upstream main

- Delta: 21 driver commits since `fc188250b`; ~7 touch our patched surface
  (`platform-macos`, `cua-driver`, shared crates): #3883 cursor-shape
  observation (new verification signal), #3755 PATH-independent capture,
  #3616 snapshot-identity unification, #3752 PiP registry removal,
  #3687 embedded-host builds, #3704 cursor-overlay exclusion, #3820
  Hyprland scroll — plus Windows/Linux hardening that Phase 4 wants.
- Method: handoff §8 (blobless clone, per-file 3-way, bump `serve.rs`
  literal, regenerate patch, `patch -p1` + `cargo build` verify).
- Gate: live-cert before AND after; last rebase was 6 files/12 hunks.

## Phase 3 — Review/refactor merged seams

- `ComputerManager` (5,403): grant store, recording store, shield, esc
  latch, control state, audit — check for duplicated admit/approve/
  dispatch/audit wrappers each agent added independently; extract per-
  feature modules where seams doubled.
- `computerTools` (4,313): unify the per-call pipeline (context →
  denylist → grant check → approval → recording capture → dispatch →
  audit) into one path if the merges produced parallel chains.
- Guard: full suite + live-cert after; refactor only where duplication
  is real, not cosmetic.

## Phase 4 — Cross-platform (Windows + Linux)

Upstream already ships `platform-windows` (UIA cache, `fg_bypass`,
SendInput-class inject, capture, MSAA, overlay), `platform-linux`
(AT-SPI, X11, Wayland `ext_screencopy`, Hyprland input), `cua-driver-uia`.
The engine is cross-platform; Synara's wall is `ComputerService.ts`'s
darwin gate plus provisioning/transport/native helpers.

Work items:
1. Per-platform driver provisioning (manifest per platform+arch).
2. Host transport: unix socket works on Linux; Windows needs the
   driver's transport of choice (check upstream `serve` surface).
3. `ComputerService` darwin gate → platform detection + per-platform
   availability reporting (honest `unsupported-platform` where true).
4. Per-platform native helpers (appsnap equivalents): Escape monitor
   (Win low-level keyboard hook; X11/evdev), shield (always-on-top
   transparent window), frame tap (platform capture), permission UX
   (no TCC — Windows integrity/UIAccess, Linux compositor variance).
5. Space→virtual-desktop mapping (Windows VD APIs; Linux per-DE).
6. Cert matrix per platform — same live-cert runner, platform rows.
   Caveat: SkyLight background guarantees don't port; Windows
   background input is often easier (PostMessage/UIA unfocused);
   Wayland is the hard case — document per-compositor.

Sequenced after the rebase so platform fixes arrive with it.

## Phase 5 — Certification & release

1. Signed-app run: packaged app + fresh TCC grants → full live-cert +
   fixture suites in the operator session (the unbroken chain).
2. Second-display hardware cert on the user's Mac+monitor (harness
   exists; single-display VM exits `skipped-single-display` correctly).
3. Expanded real-app matrix: Safari (refusal classes), Finder, Mail,
   Electron fixtures (VS Code/Slack-class behavior), a native editor.
4. Live runs for: recording→replay, grants UX, locked-use UX, masked
   activation, Escape through the merged chain.
5. Evidence per existing pattern; docs synced; no stale claims.

## Phase 6 — Extraction/OSS

Per `extraction-plan.md`: shared protocol leaf, driver-host cleanup
lifecycle, `select_text`, `wait_for_settle`, background-input
primitives, patch set + provision scripts. Internal-only: approval
policy, denylist, audit, emergency stop, task ownership, recording
privacy, preview transport, permission/setup policy.

---

## Sequencing

```
Phase 0 (harness) ──► Phase 1 (macOS depth) ──► Phase 2 (rebase)
       │                    │                        │
       │                    └──► Phase 3 (refactor, parallel subagent)
       │                                             │
       └──────────────── gate for all ──► Phase 4 (cross-platform)
                                                   │
                                          Phase 5 (cert, needs
                                                   user hardware)
                                                   │
                                          Phase 6 (extraction)
```

- 0 first — it makes every later claim cheap to prove.
- 1 and 3 overlap (refactor via subagent while depth work proceeds).
- 2 before 4 (platform fixes ride the rebase).
- 5's hardware items need the user's two-display Mac.

## Verification rules (unchanged, now enforced by the harness)

`verified` only on read-back. Never replay uncertain actions. One
transport per event. Fail closed. Background default; foreground
explicit. The admission gate and cleanup-ack are load-bearing — no
refactor or rebase may weaken them. Every phase reports real checks,
real failures, and honest "untested" items.
