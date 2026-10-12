# Synara browser import — Round 14 patch repair

## Change

Repaired the BetterWright 2.7.3 patch hunks that prevented clean dependency installation. The first clean-install repair exposed a second defect: the worker failure-code hunk landed in the wrong location, making `worker.js` syntactically invalid. Linux Round 7 caught it before release. Regenerated the complete worker diff against pristine 2.7.3 source so the taxonomy stays inside the declared catch result.

## Verification

- `bun install --frozen-lockfile`: passed after both repairs; one package reinstalled and patched.
- `git apply --check --verbose` against pristine BetterWright 2.7.3: all patch hunks pass.
- `node --check` on the installed patched `worker.js`: passed after regeneration. The first repair's generated worker failed syntax validation and was discarded.
- Installed BetterWright runtime contains `cookieSyncFailureCode` in the worker catch response and `source_too_large` classification in the client.
- Desktop browser import/password/reader/IPC tests: 63 passed across 5 files.
- Web onboarding logic tests: 22 passed.
- Browser import catalog contract tests: 2 passed.
- Desktop, web, and contracts native TypeScript checks: passed. Web/contracts emitted existing Effect suggestion diagnostics.
- Repository `bun run fmt:check`: passed (4,644 files).
- `git diff --check upstream/main...HEAD`: passed after representing the three nested blank context lines as blank-line replacements; the dependency patch still applies cleanly.
- Linux Round 7 on `4d86dd375`: clean install passed but all imports failed because the worker could not parse; the 12k exact error code was unreachable. This is why the worker hunk was regenerated.
- Linux Round 8 on `3d0beae5b`: clean frozen install and worker syntax passed; Chrome Person 1 imported 1 cookie through IPC. The 12,001-cookie profile returned `{code:"target_capacity"}`. Report evidence identifies Chromium's safe target-partition cookie capacity as the cause (not the source reader/size cap); the UI maps it to a clear capacity message and says existing target cookies were preserved. This round verified the IPC result; the matrix's remaining UI rows are still open.

## Cross-platform report review

- Linux Round 6 (head `1f330ce1e`): 12,001-cookie Chrome profile still failed as `transfer_failed`; the report confirms size is below the documented source cap. The existing-user announcement remained absent after three clean launches. Linux discovery, truthful password messaging, and real UI cancellation passed. Small imports passed with an honest session-restore-unavailable warning.
- Windows latest report (head `1f330ce1e`): App-Bound Chrome/Edge failures now state the limitation plainly; no injection was attempted. Vivaldi v10 imported a signed-in local-site session; Opera failed honestly. Password import is explicitly unsupported on Windows. Arc/Brave/Chromium were not verifiable in that VM.

## Remaining blockers

- The 12,001-cookie case is now diagnosed and reported truthfully as target capacity; the test intentionally still fails at the product's safe Chromium capacity.
- Existing-user announcement still fails to appear in Linux's real install.
- Windows Chrome/Edge v20 App-Bound cookies remain unreadable; recovery injection is disabled.
- Password import remains macOS-only; the objective's Windows/Linux support is unmet.
- Full supported-browser and OS matrix, populated Cedar visual comparison, onboarding live flow, and PR replacement closures remain incomplete. PR #1830 stays draft; #1856 and #1212 remain open.
