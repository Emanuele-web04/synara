# Bypass-helper string scan — 2026-09-17

Acceptance criterion 13: no code path requests, scripts, or documents a TCC
bypass, and the string scan for bypass helpers is clean and recorded. This is
the recorded scan.

## Scope and method

Source-only scan (grep, case-insensitive) over the computer-use surface:

- `apps/server/src/computer/` — manager, backend, control state, audit, denylist.
- `apps/server/src/agentGateway/` — `computer*` tool layers and guidance.
- `apps/desktop/src/` — GUI host, driver socket, fixtures, AppSnap helper owner.
- `packages/shared/src/` and `packages/contracts/src/` — protocol and grants modules.
- `docs/computer-use-cua/` — prose (hits here are policy text, reviewed for intent).

Patterns searched: `tccutil`, `TCC.db`, `kTCCService`, `csrutil`, `spctl`,
`task_for_pid`, `DYLD_INSERT_*`, `ptrace`, `osascript`, `cliclick`,
`CGEventPost`, `CGEventCreate`, `SLSPostEvent`, `inject*`,
`bypass`/`disable`/`evade`/`spoof`/`stealth` combined with
`tcc`/`permission`/`sip`/`gatekeeper`/`sandbox`/`cursor`/`overlay`.

## Findings

No TCC, SIP, Gatekeeper, injection, or evasion helper was found. Zero hits for
`TCC.db`, `kTCCService`, `csrutil`, `spctl`, `task_for_pid`, `DYLD_INSERT_*`,
`ptrace`, `cliclick`, `CGEventPost`, `CGEventCreate`, and `SLSPostEvent` in
TypeScript/JavaScript sources. All OS-level input synthesis lives inside the
pinned native driver artifact (`apps/desktop/patches/cua-driver/`), which is
outside this scan's language scope by design and pinned by manifest checksum.

Reviewed hits, each benign:

| Hit            | File                                                                                                         | Verdict                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tccutil`      | `packages/shared/src/computerGrants.ts:68,:120,:140`; referenced by `packages/contracts/src/computer.ts:240` | User-facing **reset** advice for Synara's _own_ ad-hoc grant rows (`tccutil reset Accessibility <bundleId>`), printed as copy-paste guidance — never executed by code, never names another app's grants. |
| `osascript`    | `apps/desktop/src/main.ts:1936`                                                                              | Quits System Settings after a permission-setup session completes. Posts no input into other applications.                                                                                                |
| `inject*`      | Throughout `computer/`                                                                                       | Means the sanctioned input-injection path through the pinned driver — the channel the guardrails protect, not a bypass of it.                                                                            |
| `bypass`       | `apps/server/src/agentGateway/computerGuidance.ts:42,:52`; `computerTools.ts:114`                            | The guidance _forbids_ bypass: "Do not substitute shell, AppleScript or another automation surface to bypass a refusal." `:114` is a comment naming the failure a shared gate prevents.                  |
| AppSnap helper | `apps/desktop/src/appSnapManager.ts`                                                                         | The user-facing screenshot helper opens System Settings panes for the human to grant — it does not drive the panes itself.                                                                               |

## Reachable-surface review (guardrail bypass paths)

Every route to the computer backend was enumerated for paths that could skip
the denylist, consent, or audit seams:

- **Agent tools** (`computerTools.ts`, `computerBrowserTools.ts`): the only
  agent-reachable mutation surface. Approval-gated, denylist-checked,
  audited. `computer_run` steps admit driven apps per step
  (`computerTools.ts:1179`–`:1205`) and dispatch through the same manager
  checks — no step type skips the seams.
- **Pane WS handlers** (`wsComputerHandlers.ts`): all input calls pass
  `threadId: undefined` — the human at the keyboard, exempt from agent
  guardrails by design (same exemption as the desktop lease).
- **Frame route** (`computerFrameRoute.ts`) and event interests: read-only
  streams to the authenticated UI client; not agent-reachable.
- **`cuaFixtures/` harnesses** (`apps/desktop/src/cuaFixtures/*.ts`): direct
  `CuaComputerBackend` callers — developer QA rigs run by a human operator
  against a live driver. They deliberately bypass the manager guardrails and
  are not part of the shipped agent surface. Recorded here as the one
  intentional bypass-bearing surface in the tree.
- **`DeviceManager`/`deviceTools`**: Android device family — a separate
  manager and tool namespace, out of computer-use scope.
- **Env vars** (`SYNARA_CUA_*`): timing, settle, capture-reuse, and warm-spawn
  knobs only; none alter consent, denylist, or audit behavior.
- **HTTP routes**: no HTTP endpoint reaches `ComputerManager` mutations.

## Residual note

The denylist and audit guard the `computer_*` tool surface. A provider shell
tool that could type into a password manager through `osascript`/AppleScript
is outside that surface — the model guidance (`computerGuidance.ts:42`)
instructs against substitution, and any such channel is the provider
harness's own boundary to enforce, not this stack's.
