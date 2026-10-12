# Round 2 critic recheck — ACCEPT

Reviewed the current uncommitted revision on branch `codex/browser-cookie-import` in `/Users/user/.codex/worktrees/browser-cookie-import/synara` on 2026-10-12. Review was read-only with respect to source: no repository edits, commit, or push. Test/typecheck runners may update ignored caches. Final `git status --short` has the same 14 changed/untracked source files as the initial status.

**Verdict: ACCEPT for the backend inventory slice.** All four previously actionable findings are addressed in the actual implementation. No new must-fix defect was established by this recheck.

**Single biggest remaining gap:** an actual packaged desktop artifact has not been built and inspected in this review. Notice staging/configuration/verifier wiring is present and focused tests pass, but these are not evidence of a shipped or signed app containing the notice. This limitation is explicitly acknowledged by the builder and does not invalidate acceptance of this backend slice.

## Recheck of each prior finding

| Prior finding | Disposition | Current evidence |
| --- | --- | --- |
| Engine storage home incorrectly treated as OS home | Resolved | `browserCookieImport.ts:49-50` calls inventory with `homedir()`. The production constructor in `main.ts:5514-5515` still supplies `Path.join(BASE_DIR, "browser-engine")` for the separate BetterWright runtime state. BetterWright construction continues using `this.home`. The new method-level regression invokes the actual class instance configured with `/synthetic-home` and asserts the inventory mock receives the OS home. |
| Modern Opera Default omitted | Resolved | `chromiumProfileInventory.ts:116-162` reserves root-only handling for GX, discovers Opera nested stores first, excludes the legacy root's `Network` directory as a candidate profile, and uses the root only when no nested profile was discovered. Tests cover nested Default winning over a stale root, root-only legacy Opera, and root-only GX. The original independent critic probe now discovers Opera Default with two stored cookies under both Node and Electron. |
| One EACCES rejects scan or erases readable profiles | Resolved for the reported app/profile/store cases | App lookups catch errors per root and continue (`:90-99`), allowing another accessible app root to establish installation. Inaccessible candidates are represented as unavailable. Per-profile discovery catches preserve readable siblings (`:133-162`). Cookie and password lookup/count work have independent catches (`:271-304`). The chmod tests pass for denied application lookup, denied sibling profile, and denied Network store while retaining healthy password and other-browser results. The original independent probe no longer rejects and retains Default beside an unavailable Profile 1. |
| Notice not packaged; provenance overclaims ported scope | Resolved in source and focused tests | Root notice accurately limits adaptation to discovery and pre-decryption row counting; Office Commun copyright and MIT text match `/Users/user/cedar/LICENSE`. `build-desktop-artifact.ts:1256-1257` reads the repository notice and stages it in the app root. All platform config branches include the explicit `extraResources` entry (`desktop-platform-build-config.ts:112-117,226-229`). Electron-builder runs with the staging app as cwd. After packaging, `build-desktop-artifact.ts:1418-1425` invokes the exact-content resources verifier before remaining artifact finalization. Production dependency installation does not remove the staged notice. |

The denied Network path produces `cookieStatus: unavailable` even when a root Cookies file is readable. This avoids claiming a legacy fallback count while the preferred store is inaccessible; password counts and other browsers survive. Discovery-level `profileStatus` and store-level availability describe different scopes, so an available discovered profile can have an unavailable cookie count.

## Checks independently run

All commands below ran from the reviewed worktree unless an absolute temporary probe path is shown.

| Command/check | Result |
| --- | --- |
| `bun run --cwd apps/desktop test -- src/browserAutomation/chromiumProfileInventory.test.ts src/browserAutomation/browserCookieImport.test.ts src/browserVaultIpc.test.ts` | PASS: 3 files, 35 tests, 1.25 s. Initial sandbox run failed on the local runner's `listen EPERM 127.0.0.1`; normal-permission retry passed. |
| `bun run --cwd scripts test -- build-desktop-artifact-mac-config.test.ts desktop-artifact-notices.test.ts` | PASS: 2 files, 11 tests, 505 ms. Same initial runner permission issue; normal-permission retry passed. |
| `/opt/homebrew/bin/node /private/tmp/synara-round2-probe.mjs` | PASS, exit 0: modern Opera found; denied Network isolated; healthy Default retained alongside denied Profile 1; WAL fixture counted 2 and main database hash unchanged. |
| `ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /private/tmp/synara-round2-probe.mjs` | PASS, exit 0: same probe outcomes using installed Electron. |
| `bun run --filter @synara/scripts typecheck` | PASS, exit 0, including computer-measurement project. Existing Effect suggestion diagnostics at build script lines 1036 and 1505. |
| `bun run --filter @synara/desktop typecheck` | FAIL, exit 1: `src/httpRuntime.ts(6,44): error TS2307: Cannot find module 'undici' or its corresponding type declarations.` This is in unchanged code; the package declares undici 8.10.2. No inventory-specific error was emitted, but desktop typechecking is not green. |
| `bunx oxfmt --check` with all 13 changed/new TypeScript files explicitly listed | PASS. |
| `git diff --check` | PASS. |
| Initial and final `git status --short`; `git branch --show-current` | Same expected 14 changed/untracked source paths; branch `codex/browser-cookie-import`. |

The direct probes emitted the known MODULE_TYPELESS_PACKAGE_JSON warning, and Electron emitted a macOS task_name_for_pid codesign diagnostic. Both exited 0 and completed their queries. No private browser database was inspected; all executed inventory cases used disposable synthetic roots.

## Remaining scope and evidence limits

- No packaged app, installer, signed release, or full preload-to-main GUI invocation was exercised. Packaging evidence is source tracing plus config/verifier fixtures, not end-to-end artifact execution.
- The new inventory channel uses the existing trusted-renderer/main-frame wrapper and shared disposal loop. The current IPC test exercises that wrapper on existing channels, but does not specifically invoke the new inventory handler. Class boundary regression and standalone inventory tests cover the reported home defect.
- Root workspace fmt/lint/typecheck/full-suite checks were not run by this reviewer; the parent should report its separate final checks. Desktop typecheck remains blocked as recorded above.
- The notice verifier accepts an exact notice inside a resources-named directory under fresh staging output. Its test establishes exact-content success and altered/missing-match rejection. It does not independently inspect archive/installer contents or certify every possible output tree. No contradictory production output was observed.
- Conventional app-name discovery, macOS-only inventory, stored-row counts before decryption, no bookmarks/history-only profile discovery, and synchronous SQLite counting remain explicit limitations of this slice. Acceptance does not imply complete onboarding or live credential import qualification.
- No model/provider choice was changed, and no SWE-2 Max tool or provider was used.

## Exact source files inspected

All 14 changed/new files were inspected (full new-file contents and changed sections with relevant surrounding integration code):

1. `apps/desktop/src/browserAutomation/browserCookieImport.test.ts`
2. `apps/desktop/src/browserAutomation/browserCookieImport.ts`
3. `apps/desktop/src/browserAutomation/chromiumProfileInventory.test.ts`
4. `apps/desktop/src/browserAutomation/chromiumProfileInventory.ts`
5. `apps/desktop/src/browserVaultIpc.ts`
6. `apps/desktop/src/ipcChannels.ts`
7. `apps/desktop/src/preload.ts`
8. `packages/contracts/src/browserVault.ts`
9. `scripts/build-desktop-artifact-mac-config.test.ts`
10. `scripts/build-desktop-artifact.ts`
11. `scripts/lib/desktop-platform-build-config.ts`
12. `scripts/lib/desktop-artifact-notices.ts`
13. `scripts/desktop-artifact-notices.test.ts`
14. `THIRD_PARTY_NOTICES.md`

Supporting reads: `AGENTS.md`, `CONTRIBUTING.md`, `apps/desktop/package.json`, `scripts/package.json`, `apps/desktop/src/main.ts` construction call chain, `apps/desktop/src/browserVaultIpc.test.ts`; `/Users/user/cedar/LICENSE` and discovery/counting sections of `/Users/user/cedar/Sources/Search/Import.swift`; the requested prior critic and builder-revision reports; the existing `/private/tmp/synara-round2-probe.mjs`; `/Users/user/.codex/memories/MEMORY.md` search hits for acceptance-scope context only. Current conclusions were verified from the current source and fresh checks, not assumed from memory.

## Visual assessment

Visual/screenshots compared: **none**.

Visual ranking: **N/A** — backend-only slice; no UI acceptance claim.
