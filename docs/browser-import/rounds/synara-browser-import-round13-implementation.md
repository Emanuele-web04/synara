# Synara browser import — Round 13 implementation

## Change

The shared import description now says saved-password import is supported only on macOS. The Settings panel, existing-user announcement, and first-run onboarding use the same copy so Linux and Windows do not promise a capability they lack. When existing-user profile inspection fails repeatedly, the announcement now explains that automatic inspection failed and offers Settings review instead of silently disappearing.

## Verification

- Repository `oxfmt --check`: passed.
- Web onboarding logic tests: 22 passed.
- Desktop browser import/manager/IPC tests: 34 passed.
- Browser import catalog contract tests: 2 passed.
- Web native TypeScript check: passed with existing Effect suggestion diagnostics.
- Focused browser announcement test: could not launch; Playwright's required `chromium_headless_shell-1234` executable is absent. No browser UI tests ran.

## Remaining evidence gaps

- Linux and Windows Devin reports still test the previously pushed commit, not these local changes. Linux reported a two-launch existing-user announcement failure and a 12,001-cookie import failure; Windows reported Chrome/Edge v20 App-Bound cookie transfer failures and no successful signed-in import.
- Password import remains macOS-only. Windows App-Bound recovery stays disabled; no explicit opt-in was authorized.
- The required cross-platform browser/matrix coverage and fresh live Cedar comparison are incomplete. The Cedar probe was isolated and did not touch `/Applications/Cedar.app`; its empty probe world did not provide populated profile counts.
