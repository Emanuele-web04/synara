# Synara browser import — Round 14 patch repair

## Change

Repaired the BetterWright 2.7.3 patch hunks that prevented clean dependency installation. The updated declarations and generated client diff now apply against the pristine 2.7.3 package; the installed reader contains the cookie transfer failure taxonomy and source-size classification.

## Verification

- `bun install --frozen-lockfile`: passed; 1,669 installs checked, no lockfile changes.
- `git apply --check --verbose` against the pristine Bun cache copy of BetterWright 2.7.3: passed for every patch file; worker hunk 2 applied with a 7-line offset.
- Installed BetterWright runtime contains `cookieSyncFailureCode` in `worker.js` and `source_too_large` classification in `client.js`.
- Desktop browser import/password/reader/IPC tests: 63 passed across 5 files.
- Web onboarding logic tests: 22 passed.
- Browser import catalog contract tests: 2 passed.
- Desktop, web, and contracts native TypeScript checks: passed. Web/contracts emitted existing Effect suggestion diagnostics.
- Repository `bun run fmt:check`: passed (4,644 files).
- `git diff --check upstream/main...HEAD`: passed after representing the three nested blank context lines as blank-line replacements; the dependency patch still applies cleanly.

## Cross-platform report review

- Linux Round 6 (head `1f330ce1e`): 12,001-cookie Chrome profile still failed as `transfer_failed`; the report confirms size is below the documented source cap. The existing-user announcement remained absent after three clean launches. Linux discovery, truthful password messaging, and real UI cancellation passed. Small imports passed with an honest session-restore-unavailable warning.
- Windows latest report (head `1f330ce1e`): App-Bound Chrome/Edge failures now state the limitation plainly; no injection was attempted. Vivaldi v10 imported a signed-in local-site session; Opera failed honestly. Password import is explicitly unsupported on Windows. Arc/Brave/Chromium were not verifiable in that VM.

## Remaining blockers

- The large-profile Linux transfer failure has not been diagnosed from runtime logs or retested with the repaired patch.
- Existing-user announcement still fails to appear in Linux's real install.
- Windows Chrome/Edge v20 App-Bound cookies remain unreadable; recovery injection is disabled.
- Password import remains macOS-only; the objective's Windows/Linux support is unmet.
- Full supported-browser and OS matrix, populated Cedar visual comparison, onboarding live flow, and PR replacement closures remain incomplete. PR #1830 stays draft; #1856 and #1212 remain open.
