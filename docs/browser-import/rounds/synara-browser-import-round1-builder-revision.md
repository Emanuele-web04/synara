# Browser import round 1 revision report

## Result

Corrected the confirmed platform metadata errors for Helium, Aside, and Opera GX. Added a complete expected platform matrix for all 15 candidate browsers, duplicate-platform checks, exact schema/catalog ID consistency, and rejection checks for unknown and prototype-like IDs. `BrowserCookieSource` and IPC/runtime validation remain unchanged.

## Platform evidence

Each platform set below was checked against official publisher pages on 2026-10-12. These describe desktop product availability, not importer support or local installation.

| Browser | Desktop platforms | Official source |
| --- | --- | --- |
| Chrome | macOS, Windows, Linux | [Google Chrome system requirements](https://support.google.com/chrome/answer/95346?hl=en-GB8) |
| Edge | macOS, Windows, Linux | [Microsoft Edge supported operating systems](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems) |
| Brave | macOS, Windows, Linux | [Brave downloads](https://brave.com/download/) |
| Arc | macOS, Windows | [Arc downloads](https://arc.net/download) |
| Dia | macOS, Windows | [Dia homepage](https://www.diabrowser.com/?price=free), [Windows release log](https://www.diabrowser.com/changelog/windows) |
| Vivaldi | macOS, Windows, Linux | [Vivaldi downloads](https://vivaldi.com/download/) |
| Opera | macOS, Windows, Linux | [Opera downloads](https://www.opera.com/download) |
| Opera GX | macOS, Windows, Linux | [Opera downloads](https://www.opera.com/download), [Opera GX Linux launch](https://press.opera.com/2026/03/19/opera-gx-gaming-browser-lands-on-linux/) |
| Chromium | macOS, Windows, Linux | [Chromium downloads](https://www.chromium.org/getting-involved/download-chromium/) |
| Helium | macOS, Windows, Linux | [Helium downloads](https://helium.computer/download) |
| Comet | macOS, Windows | [Perplexity platforms](https://www.perplexity.ai/platforms) |
| Aside | macOS, Windows | [Aside downloads](https://aside.com/download) |
| Firefox | macOS, Windows, Linux | [Mozilla Firefox release downloads](https://www.mozilla.org/en-US/firefox/releasenotes/) |
| Zen Browser | macOS, Windows, Linux | [Zen downloads](https://zen-browser.app/download/) |
| Safari | macOS | [Apple Safari update policy](https://support.apple.com/en-ie/102665) |

No platform set remains uncertain based on the checked vendor sources. Availability can change; catalog metadata is not installation discovery.

## Files changed

- `/Users/user/.codex/worktrees/browser-cookie-import/synara/packages/contracts/src/browserImportCatalog.ts`
- `/Users/user/.codex/worktrees/browser-cookie-import/synara/packages/contracts/src/browserImportCatalog.test.ts`
- `/Users/user/.codex/worktrees/browser-cookie-import/synara/packages/contracts/src/index.ts` (catalog ID tuple now exported with the catalog schema)

No UI, user database, credentials, or other worktree was touched. No commit or push was made.

## Checks

- `bunx oxfmt --check packages/contracts/src/index.ts packages/contracts/src/browserImportCatalog.ts packages/contracts/src/browserImportCatalog.test.ts` — passed.
- `git diff --check` — passed.
- `bun run --filter @synara/contracts test -- src/browserImportCatalog.test.ts` — passed, 1 file / 2 tests (approved elevated execution required because sandbox localhost binding is denied).
- `bun run --filter @synara/contracts typecheck` — passed, exit 0; existing Effect suggestion diagnostics only (approved elevated execution required for the same sandbox restriction).
