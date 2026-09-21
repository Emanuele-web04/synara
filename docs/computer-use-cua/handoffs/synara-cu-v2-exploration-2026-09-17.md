# Synara Computer Use V2 - independent exploration findings

> **Created:** 2026-09-17, early morning (local), by the agent session that read
> `/tmp/synara-cu-v2-mega-handoff-2026-09-16.md` in full and then verified/explored the ground truth.
> **Purpose:** corrections, confirmations, and newly closed questions against the handoff. The handoff
> remains the master document; this file only records what exploration changed or proved.
> **Scope discipline:** read-only. No repo writes, no pushes, no builds, no compiled binaries executed.

## 0. One-line summary

The handoff is accurate where it matters. Two of its open questions are now closed from this machine
(the macOS 26.4 `SLEventPostToPid` hazard does not reproduce on 26.5.1; the CPS notification constants
are resolved from Codex's shipping binary), one claim was corrected (Codex does use the
`SetFrontProcess` SPI family), and one big gap was not in the handoff at all (upstream cua is already at
0.28.2 while the patch is pinned to 0.24.0).

## 1. What was verified as accurate

- Clone `/Users/user/synara-computer-use`: branch `agent/computer-use-preview`, HEAD `bb7eb421c`,
  clean tree, zero commits after `bb7eb421c`. PR #1227 is open, draft, head = `bb7eb421c`,
  updated 2026-09-16T14:41Z.
- File sizes: `ComputerManager.ts` 3569, `CuaComputerBackend.ts` 1277, `cuaDriverHost.ts` 1064,
  `computerTools.ts` 2815 lines.
- Scroll limits: `120 px` per notch, `max 50` notches, one axis, no modifiers
  (`CuaComputerBackend.scroll`); macOS branch skips measurement and corrective replay
  (`ComputerManager.scrollCalibrated`); fourth-unchanged refusal is in `computerTools.ts`.
- Drag is foreground-only on macOS (`CuaActionError ... cannot drag in the background on macOS`).
- `computer_move_cursor` is overlay-only on macOS (tool description says it posts no hover events).
- Tool surface: perception (`list_windows`, `get_state`, `screenshot`, `get_screen_size`, `wait`) plus
  the approval-gated mutating set, exactly as listed. No `select_text` tool exists.
- Host spawn env/args and the retire-ack contract in `cuaDriverHost.ts` match the handoff.
- Docs: README limits table, `capability-audit-2026-09-16.md` deliberately-constrained list,
  and the "remaining certification boundary" paragraph all match.
- Environment: macOS 26.5.1 (25F80); `/System/Volumes/Data` is 97% full with ~16 GB free; bun 1.4.2;
  default rustc 1.98.0 but the `1.97.1` rustup toolchain is installed; the clone has no `node_modules`.
- The previous session's artifact set exists in `/private/tmp` (`svc.txt` strings dump of the Codex
  daemon, Operon/`cua-rs-mcp` sources, yabai source, etc.). The string-scan claim was checked:
  `svc.txt` contains `kCPSNotify*` names and no `SLPS*`/`SLS*` strings.
- Evidence gap confirmed: `docs/computer-use-cua/evidence/` has no rev-10..14 artifacts.

## 2. Corrections to the handoff

### 2.1 PR #1227 size

Handoff says "652 files changed, +104,356 / -4,110" and "125 commits ahead of main".
Actual (both vs `origin/main` and local `main`, merge-base `dd88d9272`):

```
504 files changed, 96,594 insertions(+), 2,184 deletions(-)   # git diff --shortstat origin/main...HEAD
92                                                             # git rev-list --count origin/main..HEAD
```

GitHub's own numbers agree with the 504 / 96,594 / 2,184.

### 2.2 CPS notification constants: closed from Codex's shipping binary

The handoff listed the Operon vs `cua-rs-mcp` conflict as unresolved. It is resolved by disassembling
`SkyComputerUseService` (build 26.913.1001067) on this machine: the daemon's
`NSEventSubtype.debugDescription` and the lazy-global initializers of
`AccessibilitySupport.SynthesizedEvent` give the exact values.

| Name                           | Value    |
| ------------------------------ | -------- |
| `kCPSNotifyNewFront`           | `0x0002` |
| `kCPSNotifyLostKeyFocus`       | `0x1000` |
| `kCPSNotifyKeyFocusTaken`      | `0x4000` |
| `kCPSNotifyKeyFocusReturned`   | `0x8000` |
| `kCPSNotifyKeyFocusChanged`    | `0xF102` |
| `kCPSNotifyLostTypingFocus`    | `0xF105` |
| `kCPSNotifyTypingFocusChanged` | `0xF107` |

The `cua-rs-mcp` table matches Codex exactly; the Operon table is mislabeled. The process-notification
`NSEventType` is `21` (`0x15`), built with `+[NSEvent otherEventWithType:...subtype:...]` and converted
with `-[NSEvent CGEvent]`.

Builder-to-constant mapping, from the binary:

- `notifyWindowKeyFocusRemoved` posts `kCPSNotifyKeyFocusTaken` (`0x4000`) - counter-intuitive, confirmed.
- `notifyWindowKeyFocusReturned` posts `kCPSNotifyKeyFocusReturned` (`0x8000`).
- App activate/deactivate use `NSEventTypeAppKitDefined` (13) with subtype `1` / `2`; the activation
  event carries `modifierFlags 0xC0000` (control|option) when a window id is known, and the window id
  as `windowNumber`.

### 2.3 Codex does use the `SetFrontProcess` SPI family

The handoff quoted a community claim that Codex does not use `_SLPSSetFrontProcessWithOptions` and
relies on CPS-level focus change alone. The binary contains a Swift wrapper named
`SystemSoftware.ApplicationRegistrySPI` with:

- `setFrontProcess(_:windowID:options:)`
- `getKeyFocusProcess(_:flags:)`
- `releaseKeyFocus(withID:)`

resolved dynamically through a lazy function-pointer table (`dlopen`/`dlsym` are imported; no static
`SLPS*` symbol is linked). So the SPI is present and wired, alongside the CPS notifications. Exact call
sites of `setFrontProcess` inside the daemon were not mapped.

## 3. Open question 6.6-1: the macOS 26.4 `SLEventPostToPid` hazard

**Not reproducible on this Mac (macOS 26.5.1, build 25F80).**

Method (sandbox-safe; python3 + ctypes, no compiled binary):

```python
import ctypes, os, sys
sky = ctypes.CDLL("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", mode=ctypes.RTLD_GLOBAL)
cg  = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", mode=ctypes.RTLD_GLOBAL)
cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_double, ctypes.c_double, ctypes.c_uint32]
ev = cg.CGEventCreateMouseEvent(None, 5, 100.0, 100.0, 0)   # kCGEventMouseMoved
fn = sky.SLEventPostToPid; fn.restype = ctypes.c_int32; fn.argtypes = [ctypes.c_int32, ctypes.c_void_p]
print(fn(490, ev))   # Finder's pid
```

Results, run from a process that `AXIsProcessTrusted()` reports as trusted:

- `SLEventPostToPid(pid, mouseMoved)` to Finder: returns `0x03078000`; no crash.
- `SLEventPostToPid(pid, F20 key down + up)` with a `CGEventSourceStateHIDSystemState` source
  (the driver's exact pattern): returns `0x026AC000`; no crash.
- Same call to the caller's own (non-GUI) pid: returns cleanly.
- `SLEventPostToPid` and `SLEventPostToPSN` both resolve. `GetProcessForPID` resolves from
  ApplicationServices (not from SkyLight/CarbonCore directly).

For reference, the Osaurus crash (issue #2315, macOS 26.4) is
`SLEventPostToPid + 48` -> `SLEventPostToPSN + 40`, `KERN_INVALID_ADDRESS at 0x2e87` (a pid-sized
value used as a pointer). Their fix routes through `SLEventPostToPSN` on 26.4+.

Conclusion: the driver's pid-first call pattern is not crashing on 26.5.1. Treat this as OS-build
dependent, keep a cheap canary (the snippet above) before any OS bump, and do not spend v2 budget on a
PSN fallback until a crash is observed. The pinned driver would need a `SLEventPostToPSN` path anyway if
26.4 (not 26.5) turns out to be an affected build in the field.

## 4. Facts the handoff did not contain

- **Upstream drift.** The pin is `cua-driver 0.24.0`, source commit `4b3396d9` (2026-09-07). Upstream is
  already at `cua-driver-rs v0.28.2` (2026-09-15) with nightlies. Open upstream issues that touch the
  same subsystems:
  - #3804 - macOS scroll ignores the advertised `amount` range on the keystroke path (`amount: 1100`
    ran 82-117 s; `amount: 0` reports a scroll). Directly relevant to workstream B.
  - #3897 - preserve uncertainty in macOS text outcomes (replay/retry advice for unknown AX effects).
  - #3842 - settle the macOS AX write's read-back before calling it partial (wrong `type_text_incomplete`
    delivered counts).
  - #2874 - window-scoped click duplicates mouse events (both SkyLight and `CGEventPostToPid`; Synara's
    patch already posts once instead).
    Any pin bump must bump the `nativeRevision` literal in `serve.rs` as well as the manifest.
- **Driver build toolchain.** `provision-cua-driver.mjs` asserts `rustc 1.97.1` exactly. The upstream
  tree pins it itself: `libs/cua-driver/rust/rust-toolchain.toml` sets `channel = "1.97.1"` (verified
  present in the 0.24.0 and 0.28.2 trees), so rustup honors it automatically when the script runs
  rustc from that directory. No `RUSTUP_TOOLCHAIN` override is needed. (An earlier draft of this
  note claimed the file was absent; that was wrong.)
- **Installed app is 0.8.4 without the driver**: `/Applications/Synara.app` contains no `cua-driver`
  (only `app.asar.unpacked/node_modules`), consistent with CU living only in the PR artifacts.
- **Codex CU tool surface** (from the shipped plugin 1.0.1001067 `computer-use-node-repl.md`):
  `click`, `drag`, `get_app_state`, `list_apps`, `paste`, `perform_secondary_action`, `press_key`,
  `scroll` (`pages`-based, optional `element_index`/`x`/`y`), `select_text`, `set_value`, `type_text`,
  all on a persistent `sky` object in a JS REPL. `get_app_state` transparently launches a not-running
  app; state waits ~1 s and up to ~5 s while busy. The same skill carries a full "Computer Use
  Confirmations Policy" (hand-off required / always confirm / pre-approval / no confirmation
  taxonomies) that is useful raw material for the open-source guardrails workstream.
- **Codex session config on this machine** (`~/.codex/computer-use/sessions/*.toml`): `[apps] allowed =
["com.apple.Safari"]` - i.e. Codex is running with a per-app allowlist, Safari only.
- **Our driver still has no focus enforcer.** Neither upstream 0.24.0 nor the 7,888-line patch uses CPS
  notifications or NSEvent-first focus events. The ComputerManager's `frontmost` handling exists only to
  restore the user's window after a foreground excursion; there is no focus-theft tracking or assertion
  anywhere. Workstream A starts from zero on the instrumentation side.

## 5. Still open (unchanged)

- Rev-14 packaged certification list (three concurrent targets, human foreground focus, off-Space
  semantic input, screenshot freshness refusals, hidden/minimized refusals): still requires a freshly
  signed app plus new TCC grants.
- Behavioral confirmation of the typing-focus CPS values (`0xF105` / `0xF107`) on a scratch app.
- Focus-theft instrumentation (see 4).
- Kartik's decisions (handoff 11.3): engine strategy A/B/C, open-source boundary, parity scope,
  speed budgets, certification environment, cursor identity, agent-Spaces defaults, Chrome default.

## 6. Reproduce the checks

```sh
# clone state
cd ~/synara-computer-use && git log --oneline -1 && git status -sb && git rev-list --count origin/main..HEAD
gh pr view 1227 --repo Emanuele-web04/synara --json headRefOid,additions,deletions,changedFiles,updatedAt

# Codex constants: disassemble the daemon, then read the initializer at 0x100717e14 etc.
xcrun -f llvm-objdump
"$(xcrun -f llvm-objdump)" --macho --arch=arm64 -d \
  "/Users/user/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService" > /tmp/sky.disasm
# grep the SynthesizedEvent / NSEventSubtype.debugDescription symbols in the disassembly

# 26.4 canary: the ctypes snippet in section 3 (post to a GUI pid, observe exit code)
```

---

## 7. Follow-up (2026-09-17): the upstream drift in detail

Correction first: the new fixes/commits are on **cua** (trycua/cua, the driver repo). Synara is not the
source of any of them; `origin/main` moved 1 commit since the CU branch's merge-base
(`72414a843 chore(orb): prepare orbs with pinned toolchain and dependencies`), and the CU branch itself
has no new commits.

### 7.1 Release timeline (cua-driver-rs)

| Release | Date       | Notes                                                                                      |
| ------- | ---------- | ------------------------------------------------------------------------------------------ |
| v0.24.0 | 2026-09-07 | our pin (source commit `4b3396d9`)                                                         |
| v0.25.0 | 2026-09-09 | macOS click delivery fix, browser checkbox AX, envelope/Fleet features                     |
| v0.26.0 | 2026-09-10 | typed window SDK flow, opt-in MCP envelopes                                                |
| v0.26.1 | 2026-09-10 | Hyprland pointer fix                                                                       |
| v0.27.0 | 2026-09-11 | Swift bridge symbol dedupe, consent labels, MCP connection sharing                         |
| v0.28.0 | 2026-09-11 | modern stdio MCP + skills resources                                                        |
| v0.28.1 | 2026-09-12 | embedded-host builds, cursor overlay excluded from foreground verification, encoder errors |
| v0.28.2 | 2026-09-15 | desktop snapshot identity/payload ownership, desktop capture PATH fix                      |

### 7.2 Every commit that touched macOS driver code since the pin (10)

| Commit            | Release | What it does                                                                                            | Files we patch                                                     |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `b11709305` #3404 | 0.25.0  | read macOS browser checkbox state                                                                       | `ax/bindings.rs`                                                   |
| `467c103be` #2907 | 0.25.0  | click delivery: background = one SkyLight post + public fallback; foreground = one public pid post      | `input/mouse.rs`, `tools/click.rs`                                 |
| `75b04aac0` #3683 | 0.26.0  | typed native-window SDK flow (breaking, cua framework plumbing)                                         | `tools/click.rs`                                                   |
| `2ec5858d1` #3680 | 0.27.0  | eliminate duplicate Swift bridge symbols                                                                | none                                                               |
| `4c96f2496` #3706 | 0.27.0  | normalize repeated macOS consent labels                                                                 | none                                                               |
| `44c9d1f6d` #3704 | 0.28.1  | exclude the agent cursor overlay window from foreground verification                                    | `cursor/overlay.rs`, `tools/bring_to_front.rs`                     |
| `2dbc1c2cf` #3687 | 0.28.1  | embedded-host builds: `libdispatch` -> System.framework link, Linux async-io                            | `cursor/overlay.rs`                                                |
| `f2472854c` #3752 | 0.28.1  | remove PiP backend factory registry                                                                     | `cua-driver/src/main.rs`                                           |
| `a8a7b1e5e` #3616 | 0.28.2  | unify desktop snapshot identity and payload ownership; trusted Chrome input; exact trusted click coords | `tools/{click,get_window_state,mod,scroll,set_value,type_text}.rs` |
| `f67be123e` #3755 | 0.28.2  | resolve the system desktop capture executable directly (PATH-independent)                               | none                                                               |

Overlap is limited: at most 6 patched files in one commit (`#3616`), 2 in `#2907`, 1-2 elsewhere. A
rebase is tractable, not a rewrite.

### 7.3 Correction to the earlier summary

The macOS text-outcome (#3897), AX read-back settling (#3842) and scroll-amount (#3804) items I named
earlier are still **open** upstream PRs / issues. None of them is in any release through v0.28.2. A
rebase today does not get those fixes; it gets the five fixes in the table above.

### 7.4 Recommendation

Rebase once, when implementation is authorized and before workstream A code lands: the conflicts only
grow, and the two most useful inherited fixes (`#2907` click delivery, `#3704` overlay verification)
touch exactly the input/cursor files the focus work will also touch. Keep rev-14 / 0.24.0 as the
current certified base for dry-runs; treat the rebased tree as a new base with its own re-verification.
If risk tolerance is low, wait until #3842 and #3897 land and take one rebase onto that, since those
are the text-path fixes we actually want.

---

## 8. The rebase, executed (2026-09-17)

Landed in the clone as working-tree changes (not committed, not pushed):

| File                                                         | Change                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/patches/cua-driver/0001-synara-native.patch`   | regenerated against 0.28.2, 7,956 lines, sha256 `94261ed962199becebe450f226d5a80bbae88c8730cd39d1a002bde9353c749a`                                 |
| `packages/shared/src/cuaDriverRelease.json`                  | version `0.28.2`, source `fc188250b4ca8549b8e61f937fdb1fb560770e86`, upstream binary archive sha `386db225...`, nativeRevision `15`, new patch sha |
| `apps/desktop/patches/cua-driver/README.md`                  | revision 15 note (inherited upstream fixes, judgment calls)                                                                                        |
| `apps/server/src/computer/CuaComputerBackend.ts`             | 3 user-facing version strings 0.24.0 -> 0.28.2 (capability claims re-verified in the rebased driver)                                               |
| `apps/server/src/agentGateway/computerTools.ts`              | drag guidance version string                                                                                                                       |
| `apps/web/src/components/settings/ComputerSettingsPanel.tsx` | settings label version string                                                                                                                      |
| `docs/computer-use-cua/README.md`                            | provenance + meaning of the manifest `sha256` field                                                                                                |
| `docs/computer-use-cua/capability-audit-2026-09-16.md`       | header notes the surface is unchanged in the rebase                                                                                                |

Conflicts and resolutions (6 files, 12 hunks):

- `input/mouse.rs` (7): adopted upstream's `MousePostMode`/`post_mode` threading, kept Synara's
  cancellation-gate wrapping (`press`/`pause`/`post`) and made `MousePostMode::Both` mean one
  SkyLight-first submission instead of the upstream duplicate SkyLight + public post.
- `tools/click.rs` (1): kept the `fg || force_synthetic && !chromium_mouse` recipe selection; added
  `click_at_xy_native_with_window_local` in mouse.rs so the background native recipe survives
  upstream's `WindowClickDelivery` split.
- `tools/set_value.rs` (1): kept Synara's pid-less `set_value_blocking` (the osascript fallback
  removal) over upstream's retained-guard call.
- `tools/type_text.rs` (1): kept Synara's `semantic_only` lease selection and added upstream's
  `RetainedElement` guard around the pointer.
- `cursor/overlay.rs` (1): both imports (`AtomicU32` from upstream, `Arc` from Synara).
- `cua-driver/src/serve.rs` (1): kept both match arms (`cancel_input` from Synara,
  `mcp_envelope_stream` from upstream).

Verification performed:

- Patch applies to a pristine 0.28.2 extraction with `patch -p1` and reproduces the rebased tree
  byte-for-byte (`diff -r` clean).
- `git apply --check --reverse` passes on the patched tree.
- `cargo check --locked -p cua-driver` and `--all-targets`: pass, no new warnings in patched crates.
- `cargo build --release --locked -p cua-driver`: pass (arm64 binary, 32 MB); binary strings report
  `cua-driver 0.28.2`.
- `git fetch --depth=1 <url> <source-sha>` works (the provision script's fetch path).
- Only 8 files modified; manifest JSON parses; patch sha matches the manifest.

Not run: repository typecheck/lint/test (node_modules absent), rev-15 runtime certification (needs a
signed app plus fresh TCC grants), any push or commit.

---

## 9. Commits and repo checks (2026-09-17)

Committed on `agent/computer-use-preview` (local only, not pushed):

- `25850f947` build(cua): rebase native driver patch onto 0.28.2
- `52300a0b4` fix(computer): update Cua version copy to 0.28.2
- `e2a1deb06` docs(computer): record the 0.28.2 driver rebase

Repo checks (after `bun install --frozen-lockfile`):

- `bun run typecheck`: pass (7/7 packages) after running `apps/marketing`'s
  `postinstall` (`fumadocs-mdx`) to generate the gitignored `.source`; the first
  run failed only on that missing generated directory.
- `bun run lint`: 0 errors, 630 warnings (same count as the PR record).
- `bun run fmt:check`: pass.
- `bun run test`: 6/7 packages pass; 5,751 passed, 1 failed, 20 skipped.
  The single failure is **pre-existing and deterministic**, not from the rebase:
  `apps/server/src/codexAppServerManager.test.ts:97` expects the phrase
  "Split the script when new page state requires inspection", but the production
  guidance in `packages/shared/src/browserAutomationCatalogue.ts:103` now says
  "Split when new state needs inspection or a human decision". The stale phrase
  exists only in the test at both HEAD and `bb7eb421c`. Fix is a one-line test
  expectation update (or restoring the old copy).
- `node_modules` and the generated `.source` were removed again after the checks.

---

## 10. Correction, 2026-09-17 (later same day, appended)

The verified state above was true at native rev 15. Since then:

- The driver is staged at **native revision 16** (same 0.28.2 source;
  patch sha `46f7a8cfbb51d18eb3eb91da88b488e5c42fc92bfa91a717dae3fadd43050ee0`).
- The section-1 scroll limits are obsolete: scroll now takes two axes plus
  held modifiers as one pixel-unit wheel gesture, and macOS runs the
  before/after measurement loop. Live-verified on TextEdit; the remaining
  limit is that NSScrollView ignores horizontal wheel deltas.
- The "deliberately unexposed" milestone tools shipped: `computer_list_apps`,
  `computer_verify_state`, `computer_zoom`, `computer_set_window_frame`,
  `computer_invoke_menu`, `computer_kill_app`; plus the reads
  `computer_get_accessibility_tree` and `computer_get_cursor_position`.
  Agent-facing `computer_*` tools now number 31.
- The three-window `type_text` failure is closed via verified `set_value`
  compose on web-content elements (fixture evidence under
  `docs/computer-use-cua/evidence/fixture-g5-set-value-2026-09-17-*`).
