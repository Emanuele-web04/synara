# Browser catalog round 1 — independent critic verdict

**REQUEST CHANGES.** The candidate/runtime boundary is preserved, but published platform metadata is wrong for three browsers and the new tests cannot detect any incorrect platform assignment. No source edits made.

## Findings by severity

### P2 — published-platform metadata excludes real desktop platforms

File: `packages/contracts/src/browserImportCatalog.ts`, lines 37, 39, 41.

The catalog explicitly represents published desktop availability, rather than importer support. These entries contradict current official publisher evidence:

| ID | Catalog | Required published platforms | Evidence |
| --- | --- | --- | --- |
| `opera-gx` | macOS, Windows | macOS, Windows, Linux | [Opera official Linux launch, March 19 2026](https://press.opera.com/2026/03/19/opera-gx-gaming-browser-lands-on-linux/) |
| `helium` | macOS | macOS, Windows, Linux | [Official Helium downloads](https://helium.computer/download), [official site FAQ](https://helium.computer/) |
| `aside` | macOS | macOS, Windows | [Official Aside download page](https://aside.com/download) |

Any future discovery/UI that filters candidates by `desktopPlatforms` will incorrectly exclude installed browsers on those platforms. Fix these metadata entries without expanding the cookie runtime allowlist. Dia's macOS/Windows entry was independently confirmed by [its official homepage](https://www.diabrowser.com/).

### P2 — tests do not cover platform availability as required

File: `packages/contracts/src/browserImportCatalog.test.ts`, lines 32–39.

The test only requires a nonempty array composed of recognized OS strings. Every browser could incorrectly become macOS-only, or Safari could acquire Linux/Windows, and it would still pass. The three real errors above all passed the two new tests. Add an independently written expected platform matrix with both positive and negative per-browser assertions, and forbid duplicate platform entries. Catalog/schema consistency also only checks that expected IDs are accepted; it does not check that the schema has no extra IDs. Assert the complete schema/catalog identity set, plus rejection of unknown/prototype-like IDs.

## What is sound

- Catalog contains exactly the 15 requested candidate IDs, unique and in requested order.
- Names and comments explicitly describe candidates and published availability, not operational support.
- `BrowserCookieSource` remains the existing seven-ID gate: Chrome, Safari, Edge, Helium, Aside, Arc, Dia.
- `browserVaultIpc.ts` still decodes profile requests with `BrowserCookieSource` and imports with `BrowserCookieImportInput`, behind trusted-renderer/main-frame checks.
- `BrowserCookieImport.sources()` still filters BetterWright results through that schema; `profiles()` still rejects non-runtime IDs.
- Patch source shows Helium, Aside, and Dia use a macOS-only custom reader; metadata must therefore remain conceptually separate from reader availability. The patch advertises all custom sources on macOS without proving installation. This is preexisting behavior, not a regression in this slice.
- No UI or renderer use was added, so this diff itself does not display new unsupported import choices.

## Checks run

All commands ran from `/Users/user/.codex/worktrees/browser-cookie-import/synara`.

| Command/check | Actual result |
| --- | --- |
| `git status --short`, `git diff --stat`, actual new files and index diff | Only the three reported catalog files changed/untracked. |
| `git diff --check` | Passed. |
| `bunx oxfmt --check packages/contracts/src/index.ts packages/contracts/src/browserImportCatalog.ts packages/contracts/src/browserImportCatalog.test.ts` | Passed, 3 files. |
| `bun run --filter @synara/contracts test src/browserImportCatalog.test.ts` in sandbox | Failed before test startup: `listen EPERM: operation not permitted 127.0.0.1`. |
| Same focused test via approved escalation | Passed: 1 file, 2 tests. |
| `bun run --filter @synara/contracts typecheck` in sandbox | Failed before startup with the same listener EPERM. |
| Same contracts typecheck via approved escalation | Passed, exit 0. Existing Effect diagnostic suggestions were emitted; no blocking errors. |
| `bun run --filter @synara/desktop test src/browserVaultIpc.test.ts src/browserAutomation/browserCookieImport.test.ts` via approved escalation | Passed: 2 files, 23 tests. These are mocked regression tests, not live browser-import qualification. |
| Official publisher availability lookup | Confirmed the three errors above and Dia's two platforms. Did not independently requalify every other browser/platform combination. |

Full workspace lint, formatting, typecheck, and tests were not run for this focused review. No live browser credentials, production state, or databases were accessed. No native importer qualification was attempted.

## Every local file inspected

Paths below are relative to `/Users/user/.codex/worktrees/browser-cookie-import/synara`, except the first report:

- `/private/tmp/synara-browser-import-round1-builder.md` — full builder report.
- `packages/contracts/src/browserImportCatalog.ts` — full new catalog.
- `packages/contracts/src/browserImportCatalog.test.ts` — full new tests.
- `packages/contracts/src/index.ts` — actual diff and export section.
- `packages/contracts/src/browserVault.ts` — source/import schemas and public methods.
- `packages/contracts/package.json` — test/typecheck scripts and package exports.
- `packages/contracts/tsconfig.json` — contracts check configuration.
- `apps/desktop/src/browserVaultIpc.ts` — full IPC validation and trust boundary.
- `apps/desktop/src/browserVaultIpc.test.ts` — full IPC regression test.
- `apps/desktop/src/browserAutomation/browserCookieImport.ts` — first 140 lines, discovery/profile/runtime acquisition paths.
- `apps/desktop/src/browserAutomation/browserCookieImport.test.ts` — first 180 lines plus targeted source/rejection assertions search.
- `apps/desktop/package.json` — desktop dependency and test scripts.
- `patches/betterwright@2.7.3.patch` — first 160 lines, cookie-sync integration at 338–382, and targeted platform/source searches through patch.
- `package.json` — root scripts, dependency patch registration and tooling.
- `vitest.config.ts` — root aliases.
- `CONTRIBUTING.md` — full contribution and verification guidance.

Search commands also enumerated references in contracts/desktop/patches, but files represented solely by search hits were not treated as fully inspected. `ls` checked local Vitest/Bun dependency paths; no dependency files were edited.

## Visual assessment

Best visual: not applicable. Worst visual: not applicable. This is a contract-only slice with no rendered UI change.

## Single largest remaining gap

**A correct, explicitly asserted published-platform matrix.** Three entries are currently false, and the passing test suite gives no protection against that class of error. Correct the metadata and assert the full expected matrix before accepting this slice. Native reader qualification is a later integration obligation and must not be inferred from this catalog review.
