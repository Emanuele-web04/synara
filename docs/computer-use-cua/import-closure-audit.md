# Import-closure audit — driver-facing package

Resolves the "Dependency caveat — unverified" in
[`open-package-file-list.md`](open-package-file-list.md). Computed by walking
the real import graph from each candidate seed file on branch `pr-1227`
(native revision 20). Two closures were measured: the narrow driver-facing
milestone (extraction plan phase 3) and the full fixture set including
`gateway.ts`.

## Verdict

The driver-facing stack ships clean **with two seams**, neither of which is
a move today:

1. `cuaDriverHost.ts` already takes `ComputerFrameTapHost`/`ComputerShieldHost`
   as type-only constructor options — in the package these become
   package-declared interfaces; the implementations stay product UX.
2. The qualification fixtures need a backend seam (below).

## Clean as-is (no seams)

| File                                            | Imports                                                |
| ----------------------------------------------- | ------------------------------------------------------ |
| `packages/shared/src/cuaDriverProtocol.ts`      | `node:net` + `./cuaDriverRelease.json` — leaf          |
| `packages/shared/src/cuaDriverRelease.json`     | none                                                   |
| `apps/desktop/scripts/provision-cua-driver.mjs` | `node:*` only                                          |
| `apps/desktop/src/computerDesktopLifecycle.ts`  | **zero imports** — power monitor + host fully injected |
| `apps/desktop/src/cuaDriverHostStandalone.ts`   | `node:*` + `./cuaDriverHost`                           |
| `apps/desktop/src/cuaFixtures/focusProbe.ts`    | zero runtime deps                                      |

Plus the patch set, pin manifest, and docs corpus — all artifacts, no
closure.

## Seam 1 — frameTap/shield (already designed in)

`cuaDriverHost.ts` imports both host interfaces `import type` only
(`:27-28`). In-package they become exported interfaces; the current
implementations (`computerFrameTap.ts`, `computerShield.ts`) stay internal
and pull `ipcChannels.ts` + `stopNativeHelper.ts` — desktop-internal files
that remain product code. No package file needs them.

## Seam 2 — fixture backend interface

The fixtures use **9 backend methods**: `captureScreenshot`, `click`,
`drag`, `getState`, `listWindows`, `pressKey`, `setValue`, `stopInput`,
`typeText`.

| Fixture           | Backend coupling                                                                      | In narrow milestone?                         |
| ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| `cancellation.ts` | `import type` — param only                                                            | Yes, against a ~9-method package interface   |
| `native.ts`       | `import type` — param only                                                            | Yes, same                                    |
| `electron.ts`     | **constructs** `new CuaComputerBackend({endpoint, capability, request})` (`:218`)     | Only with an injected `backendFactory`       |
| `live.ts`         | via `electron.ts` + `pngDimensions` (`server/src/pngHeader.ts`, ~20 lines)            | Same — factory + move/inline `pngDimensions` |
| `gateway.ts`      | `ComputerManager` + `computerTools` + `toolRuntime` + Effect — the agent-facing stack | **No** — wider milestone or stays internal   |

A package-side `ComputerUseBackend` interface covering the 9 methods makes
`cancellation`/`native` compile clean; Synara's `CuaComputerBackend`
satisfies it structurally. `electron.ts`/`live.ts` additionally need the
factory injection — the package's reference wiring maps the same 9 methods
onto `cuaRequest` calls over the protocol module.

## What the audit proves about the alternative

If the fixtures are _not_ seamed, `cancellation.ts → CuaComputerBackend.ts`
is the single bridge that drags the product spine: **44 server files**
(`ComputerManager`, the whole `computer/*` directory, `agentGateway/*`,
provider plumbing) plus **44 contracts files** through the barrel. The seam
is the difference between a ~10-file package and a ~100-file one.

## Narrow-milestone package sketch

```
cua-driver-protocol.ts        (from packages/shared — leaf)
cua-driver-release.json       (pin manifest)
provision-cua-driver.mjs      (unchanged, pure node)
cua-driver-host.ts            (+ ComputerFrameTapHost/ComputerShieldHost as
                               package interfaces)
cua-driver-host-standalone.ts (the verified tsdown artifact entry)
computer-desktop-lifecycle.ts (zero-dep, injected monitor)
fixtures/focus-probe.ts
fixtures/cancellation.ts      (against ComputerUseBackend interface)
fixtures/native.ts            (against ComputerUseBackend interface)
patches/0001-synara-native.patch + README + keymap notes
docs/ (license, permission guide, qualification, evidence pattern)
```

Total: ~10 source files + artifacts + docs. `electron`/`live` join when the
backend-factory seam lands; `gateway` stays product-side.

## Still gated on D1

This audit informs but does not resolve decision D1 (driver-facing only vs
full tool layer). The ~10-file package above is the narrow option's true
cost. The wider option's cost is the 44-file server closure plus the
Effect/contracts dependency wall — the extraction plan's Phase 4.
