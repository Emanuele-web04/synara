# Synara browser import — Round 7 implementation

**Slice:** shared import panel in first-run onboarding and Settings; remove automatic Safari guidance sheet; make the browser vault usable from password import.

**Base:** `510a3184c` (`fix(browser): bind profile imports to app window`), branch `codex/browser-cookie-import`.

## Implemented

- Added `BrowserImportPanel` and `BrowserSessionImport`; the same panel is mounted from onboarding and General Settings.
- Added a `browser-import` step after the existing feature tour. Browser profiles are preselected, session import requires one explicit whole-profile consent, results are reported by profile, and refresh preserves existing selections while clearing consent.
- Kept the General Settings panel mounted while other Settings categories are active and block route changes while an import is running, so users return to the same in-flight state and cannot start a conflicting retry.
- Reused `BrowserVaultMaster` for Saved Logins setup/unlock. Password import waits for a verified unlocked vault and observes vault changes with stale-snapshot protection.
- Added separate inventory loading, empty, error, and retry states. The web surface explains that import requires the Synara desktop app.
- Removed the automatic Safari setup sheet from root startup while retaining manual Safari access setup in Settings. Updated the affected Safari browser test to use that explicit entry point.
- Added browser UI coverage for session consent, selection preservation and consent reset after refresh, initial vault setup, external vault unlock, and Safari Settings access.

## Review and verification

- Initial critic verdict: **REVISE**. It found that first-run password import had no vault setup path, Settings unmounted import state, web mode was blank, a Safari test used the removed startup flow, and discovery failures had no retry.
- Those findings were fixed. A later critic found stale vault protection state when another control unlocked it and consent being retained across profile refresh. The implementation now subscribes to `api.onChanged`, sequence-guards snapshots, gates import until vault state is known, preserves prior profile choices, and clears consent on refresh.
- Final critic verdict: **ACCEPT for this slice**. No P0/P1/P2 issue identified. This is not acceptance of the overall objective.
- `bun run --cwd apps/web typecheck`: passed. Existing Effect diagnostics remain suggestions.
- `bun run --cwd apps/web test -- src/onboarding/logic.test.ts`: passed, 21 tests.
- Browser UI suite: passed, 2 files / 33 tests. Playwright used the installed Google Chrome executable in a fresh isolated browser context because the configured headless shell was absent. The temporary local launch override was reverted afterward; no browser profile was used.
- `bun run fmt:check`: passed across 4,629 files.
- `bun run lint`: passed with 886 existing warnings and 0 errors; server synchronous-filesystem budget passed.
- `git diff --check`: passed.

## Remaining gaps

- Existing users still have no one-time import prompt. The current onboarding gate deliberately exempts completed installations, so the new step alone does not reach them.
- Browser inventory and password counts remain Chromium-focused; browser/platform support and per-browser counts do not yet meet the requested macOS, Windows, and Linux matrix.
- No live Synara desktop import or Cedar-versus-Synara screenshot comparison was performed for this slice. The browser component suite uses mocked APIs; it is not end-to-end evidence.

## Files changed

- `apps/web/src/components/BrowserImportPanel.tsx`
- `apps/web/src/components/BrowserSessionImport.tsx`
- `apps/web/src/components/BrowserPasswordImport.tsx`
- `apps/web/src/components/BrowserVault.browser.tsx`
- `apps/web/src/components/SafariAccessOnboarding.tsx`
- `apps/web/src/components/SafariAccessOnboarding.browser.tsx`
- `apps/web/src/onboarding/OnboardingDialog.tsx`
- `apps/web/src/onboarding/logic.ts`
- `apps/web/src/onboarding/logic.test.ts`
- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/_chat.settings.tsx`
