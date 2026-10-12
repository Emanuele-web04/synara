# Synara browser import — Round 11 implementation

## Report-backed changes

- A successful cookie sync followed by a successful persistent-partition flush now returns its real imported/skipped counts even when the optional session-restoration checkpoint fails. `sessionRestore: "unavailable"` carries that limitation separately; the obsolete `persistence_failed` result was removed.
- Added a cancel action through the shared Settings/onboarding panel, preload, IPC, and desktop importer. The report-backed cancellation regression now leaves `waitForAgents()` unresolved while asserting the import has already settled as cancelled.
- `waitForAgents()` is raced against the import's abort signal, so cancellation no longer waits for browser agents to finish before the UI can leave its busy state.
- Follow-up review found cancellation could still hang during hidden target creation. The importer now races all pre-sync setup/discovery/validation awaits against cancellation; profile target creation takes the signal and destroys its hidden window immediately if cancelled while `about:blank` is still loading.
- Added a deferred-load manager regression proving cancellation destroys the hidden window immediately and disposes it only once when the load resolves late.

## Verification

| Check                                              | Result                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop importer, manager lifecycle, and IPC tests | 88/88 passed (`./node_modules/.bin/vitest run --configLoader runner src/browserAutomation/browserCookieImport.test.ts src/browserAutomation/browserManagerAutomation.test.ts src/browserVaultIpc.test.ts`, from `apps/desktop`) |
| `git diff --check`                                 | Passed                                                                                                                                                                                                                          |
| Live Devin retest of new changes                   | Not run; the two reports above tested `eb068d6`, not the current worktree                                                                                                                                                       |

The first root `fmt:check` invocation found formatting in six changed/source-report files; those were formatted and the final `bun run fmt:check` passed. Root lint's `oxlint` stage reported 0 errors and 886 warnings; the subsequent `server-sync-fs:check` call failed before running because the SFW wrapper could not open its cache (`EPERM`). Running `node scripts/check-server-sync-fs.ts` directly passed. Root `bun run typecheck` was also blocked when Turbo invoked the same wrapper. Direct native TypeScript checks for `apps/desktop`, `apps/web`, and `packages/contracts` passed when their tsbuildinfo files were directed to `/private/tmp`.

## Critic status

Round 11 fresh critic initially rejected the cancellation slice because the wait test resumed too soon and hidden-window setup could hang. After both fixes, a fresh lifecycle recheck **ACCEPTED the cancellation paths**. It confirmed prompt settlement, abort listener cleanup, immediate window destruction, and safe late-load cleanup. No tests were run in that review; the 88-test command above was run locally.

## Remaining objective gaps

- No Linux large-profile fix or new Linux announcement diagnosis has been live-verified.
- Windows Chrome/Edge v20 App-Bound cookies still fail; no successful Windows signed-in import is reported.
- Password import remains unavailable on Linux and Windows, despite the objective requiring saved-password import on each supported OS.
- Browser gates do not cover the objective's supported-browser list across platforms; Linux report says only Chrome/Edge are selectable.
- Locked-vault discoverability, no-browser UI, onboarding-step live verification, macOS Cedar comparison, broad matrix rows, and overall macOS real-app verification remain incomplete.
- Flatpak, KWallet, Snap, custom/non-ASCII profiles, Firefox primary password, denied macOS Keychain prompts, Safari Full Disk Access, Stable/Beta isolation across all flows, and several other matrix cases remain unrun or unsupported.
