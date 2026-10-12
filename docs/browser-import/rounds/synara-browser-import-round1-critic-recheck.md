# Browser import round 1 — independent critic recheck

**ACCEPT for this catalog-only slice. No actionable correctness findings remain.** The three incorrect platform entries and the exact-matrix test gap identified in the previous review are resolved. No repository source edits were made.

## Severity-ranked findings

- **P0/P1/P2:** None found in the revised slice.
- **P3:** None requiring a change before acceptance.

## Independent platform verification

Checked the actual catalog against official publisher sources on 2026-10-12. All 15 IDs, display names, and desktop platform sets match. These are current published desktop products within the contract's three-OS universe; historical discontinued products and mobile platforms are excluded.

| ID | Exact catalog platform set | Official evidence independently read | Result |
| --- | --- | --- | --- |
| `chrome` | macos, windows, linux | [Google system requirements](https://support.google.com/chrome/answer/95346?hl=en) lists each OS | Match |
| `edge` | macos, windows, linux | [Microsoft supported operating systems](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems) has Windows, macOS and Linux sections | Match |
| `brave` | macos, windows, linux | [Brave downloads](https://brave.com/download/) explicitly lists all three | Match |
| `arc` | macos, windows | [Arc downloads](https://arc.net/download) provides Windows and Mac downloads | Match |
| `dia` | macos, windows | [Dia homepage](https://www.diabrowser.com/) explicitly lists macOS and Windows | Match |
| `vivaldi` | macos, windows, linux | [Vivaldi downloads](https://vivaldi.com/download/) lists all three and their installers | Match |
| `opera` | macos, windows, linux | [Opera downloads](https://www.opera.com/download) provides separate Windows, macOS and Linux downloads | Match |
| `opera-gx` | macos, windows, linux | [Opera downloads](https://www.opera.com/download) separately provides GX downloads for all three, including Linux | Match |
| `chromium` | macos, windows, linux | [Chromium downloads](https://www.chromium.org/getting-involved/download-chromium/) describes platform selection for Mac, Win and Linux snapshots | Match |
| `helium` | macos, windows, linux | [Helium downloads](https://helium.computer/download) explicitly lists all three and separate platform sections | Match |
| `comet` | macos, windows | [Perplexity platforms](https://www.perplexity.ai/platforms) search-indexed official content lists macOS and Windows under Comet; [official release announcement](https://www.perplexity.ai/changelog/what-we-shipped--march-27-2026) corroborates desktop Mac and Windows | Match |
| `aside` | macos, windows | [Aside downloads](https://aside.com/download) explicitly describes both Mac and Windows installation | Match |
| `firefox` | macos, windows, linux | [Mozilla release downloads](https://www.mozilla.org/en-US/firefox/releasenotes/) redirects to official Firefox release page with download links for all three | Match |
| `zen` | macos, windows, linux | [Zen downloads](https://zen-browser.app/download/) explicitly lists all three and download links | Match |
| `safari` | macos | [Apple Safari support](https://support.apple.com/en-ie/102665) lists macOS and states Windows/non-Apple updates are discontinued | Match |

Comet's directly opened platforms page returned only an image to the extraction tool. The official page's indexed text and the separate official changelog supplied the corroborating evidence; no third-party claims were used.

## Schema, tests and boundaries

- `BROWSER_IMPORT_CATALOG_IDS` has exactly the requested 15 unique IDs in the expected order. `BrowserImportCatalogId` is constructed directly with `Schema.Literals(BROWSER_IMPORT_CATALOG_IDS)`, so there is no independently maintained schema list that can silently diverge.
- The catalog's `satisfies` constraint checks ID membership and restricts platforms to `macos | windows | linux`. Catalog completeness and uniqueness are asserted by comparing its ID sequence to the complete expected tuple.
- The tests contain an explicit expected matrix for **every** browser. Exact array equality rejects missing platforms, extra platforms and wrong sets. A separate set-size assertion rejects duplicates. The matrix is not derived from the catalog values.
- The passing test explicitly rejects `unknown`, `__proto__`, `constructor`, and `toString` through `Schema.is(BrowserImportCatalogId)`. All 15 intended literal values pass. This uses schema membership, not an inherited-property object lookup.
- `BrowserCookieSource` remains the seven-value runtime gate: chrome, safari, edge, helium, aside, arc, dia. Each candidate's membership in that gate is asserted separately.
- The inspected IPC source still decodes profile requests with `BrowserCookieSource` and import requests with `BrowserCookieImportInput`, after trusted-renderer/main-frame checks. The inspected runtime discovery filters results through `BrowserCookieSource`, and `profiles()` rejects values outside it.
- The only tracked diff is the catalog export in the contracts barrel; the two new files contain the catalog and tests. No runtime or UI change was introduced by this slice.

## Checks actually run

All repository commands used `/Users/user/.codex/worktrees/browser-cookie-import/synara`.

| Check | Actual result |
| --- | --- |
| `git status --short`, `git diff --stat`, index diff and full new-file inspection | Only index.ts modified plus the two new catalog files; same status after checks |
| `git diff --check` | Passed |
| `bunx oxfmt --check packages/contracts/src/index.ts packages/contracts/src/browserImportCatalog.ts packages/contracts/src/browserImportCatalog.test.ts` | Passed, 3 files |
| `bun run --filter @synara/contracts test -- src/browserImportCatalog.test.ts` in sandbox | Could not start: localhost `listen EPERM` |
| Same focused test with approved escalation | Passed: 1 file, 2 tests, exit 0 |
| `bun run --filter @synara/contracts typecheck` in sandbox | Could not start: localhost `listen EPERM` |
| Same contracts typecheck with approved escalation | Passed, exit 0; Effect suggestion diagnostics appeared in other files |

Full workspace formatting/lint/typecheck/tests and native browser imports were not rerun for this focused, read-only recheck. No live credentials, browser databases or user state were accessed. No new test files, repository edits, commits or pushes were made.

## Every local file inspected

Outside the worktree:

- `/private/tmp/synara-browser-import-round1-critic.md` — complete previous critic report.
- `/private/tmp/synara-browser-import-round1-builder-revision.md` — complete revision report, treated as claims to verify.

Relative to `/Users/user/.codex/worktrees/browser-cookie-import/synara`:

- `AGENTS.md` — complete worktree instructions.
- `CONTRIBUTING.md` — complete contribution and verification instructions.
- `packages/contracts/src/browserImportCatalog.ts` — complete revised source, including numbered reread.
- `packages/contracts/src/browserImportCatalog.test.ts` — complete revised tests, including numbered reread.
- `packages/contracts/src/index.ts` — changed export and surrounding diff context only.
- `packages/contracts/src/browserVault.ts` — first 100 lines, including runtime source and import schemas.
- `packages/contracts/package.json` — complete scripts and package exports.
- `packages/contracts/tsconfig.json` — complete typecheck configuration.
- `apps/desktop/src/browserAutomation/browserCookieImport.ts` — first 120 lines, covering discovery, profile gate and initial import path.
- `apps/desktop/src/browserVaultIpc.ts` — complete IPC handlers and validation.

The file-name search enumerated package.json and AGENTS.md locations; other enumerated files were not opened. Compiler diagnostics naming additional source files are not counted as manual inspection.

## Single biggest remaining gap

**Installed-browser discovery and live importer qualification remain unproven by this slice.** The catalog correctly describes published availability, but cannot establish that a browser is installed or that its sessions, bookmarks, history or passwords can be imported on a given OS. That is an integration obligation for subsequent rounds, not a defect in the accepted metadata contract. Exact matrix tests also cannot automatically detect future vendor availability changes; this verdict reflects the vendor evidence read today.

Visual assessment: not applicable; this slice contains no rendered UI change.
