# Synara browser import — Round 20 live retest reconciliation

## Tested revisions

- Current PR head: `6750f76ed7314bc39e964f3adb206ca660d99ce6`.
- Linux and Windows Lite app sessions tested `0ae8539031f03eabfbb73c1e34fca7623c183380`. The later `6750f76ed` commit changes browser-test platform setup and coachmark assertions only; no product runtime files changed between these tested revisions.
- Both sessions used Lite and disposable local test accounts/site. Windows ran a fresh desktop build. No App-Bound injection was attempted.

## Linux — Chrome and Edge, disposable keyring

| Check | Result |
| --- | --- |
| Explicit import with no OS keyring | **PASS** — Chrome Person 1 returned `{ok:true, imported:1, skipped:0, sessionRestore:"unavailable"}`; no unprotected `sessions.enc` was written. |
| Add disposable `gnome-libsecret`, then explicit imports | **PASS** — Electron safeStorage became available; Chrome and Edge imports returned session restore available. `sessions.enc` was 78 bytes and `key-protection.json` contained an OS-wrapped key with no master-key fallback. |
| Targeted clean shutdown | **PASS** — SIGTERM to Electron main PID 6819 used the graceful shutdown path; all seven Electron processes exited, the `active-run` sentinel was removed, and the encrypted checkpoint plus OS-wrapped key remained. |
| Restart and restored login | **PARTIAL** — same build/home restarted; the checkpoint was not discarded, decrypt + `backend.restore` ran, and the log had no restore errors. The guest tab stayed suspended, never committed a load, and made no site request; `attachWebview` returned `tab is not available`. Actual restored site login is **NOT VERIFIED**. |
| Large profile | **FAIL / previously reported** — the prior 12,001-cookie whole-profile import was unreliable (persistence failure, then transfer-verification failure); Round 20 did not rerun it. |
| Browser coverage | **LIMITED** — Linux runtime registers Chrome and Edge only; other requested catalog entries remain informational and unavailable for import. |

The no-keyring report and keyring-backed checkpoint are distinct cases. The OS-protected checkpoint was not available for clean-restart login verification.

## Windows — exact Lite report

| Check | Result |
| --- | --- |
| Installed profile inventory | **PASS** — Settings listed Chrome, Edge, Opera, and Vivaldi profiles; browsers without profiles did not appear. |
| Saved passwords | **UNSUPPORTED** — UI clearly says import is supported only on macOS; no unlock/setup path is offered on Windows. |
| Vivaldi signed-in test site | **PASS** — one cookie imported, present in Synara's persistent browser partition, and the local site displayed `SIGNED-IN-OK user=testuser`. |
| Chrome/Edge App-Bound cookies | **FAIL to import; honest warning** — both returned 0 imported; the UI explained that Synara does not use App-Bound injection. |
| Opera | **FAIL** — profile could not be read or decrypted. |
| Arc, Brave, Chromium | **NOT RUN** — no profile was present; Arc could not launch on this Windows Server image. |

## CI and local verification at `6750f76e`

- PR run `38246251989`: all required checks completed successfully, including all three browser component shards, server test shards, web/core unit tests, typecheck, Windows process regression, migration lineage, desktop build, and workspace format/lint/typecheck/build checks.
- Local `bun run fmt:check`, `bun run lint`, `bun run typecheck`, and `git diff --check` passed. Lint reported 886 warnings and zero errors.
- The targeted local browser-test command did not start: sandbox denied the Vitest loopback listener (`listen EPERM: operation not permitted 127.0.0.1`). CI supplied the behavioral test result instead.

## Readiness

PR #1830 remains a draft and is not ready to replace #1856 or #1212. The objective remains incomplete: Linux clean-restart login, the 12,001-cookie case, Windows Chrome/Edge and Opera imports, password import on Windows/Linux, macOS Synara import and Cedar visual comparison, and most requested browser/OS matrix rows remain open. No App-Bound injection opt-in was added.
