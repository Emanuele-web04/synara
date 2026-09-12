# Automatic macOS permission setup — 10 September 2026

The earlier permission service fix provided fresh native checks, but the setup UI still depended mainly on returning to Synara. It did not provide a floating guide or a desktop-owned loop that could advance while System Settings was foreground. The reporter's screenshot also contains two differently named app entries; it does not establish that the running build has a valid grant.

[PR #913](https://github.com/Emanuele-web04/synara/pull/913), head `fc77265cd26f5e11197fe72dfbbc26163ef0f38a`, was reviewed as a design reference. This change adopts the floating app-drag guide idea. It does not import that PR's picker, global Escape hook, repeated window-follow scans or same-process permission polling.

## Resulting flow

Follow-up, 11 September: selecting Computer access in the chat composer now reads fresh backend status and opens this same guide when macOS permissions are missing. The existing permission setup buttons and AppSnap use the same controller. Existing grants skip the guide; switching Off or leaving the thread fences a delayed check. Chat access remains an explicit choice, separate from OS grants.

1. Set up starts one Electron-owned setup session and stops active Cua input through the existing cleanup barrier.
2. A fresh AppSnap permission helper checks the selected scopes. Computer uses Accessibility → Screen Recording; AppSnap uses Input Monitoring → Screen Recording. Already-granted scopes are skipped.
3. A small native guide stays visible beside System Settings. Its draggable app icon and Show in Finder action both use the bundle containing the running Electron executable, including custom names such as Synara Cua. The renderer cannot substitute a path.
4. Setup requests and opens only the first missing permission. Once that request returns, a fresh helper checks every second after the previous check finishes. Confirming Accessibility advances to Screen Recording automatically, without returning to Synara or pressing Refresh. Dropping the app or merely listing it in Settings never counts as a grant.
5. Electron pushes confirmed state to the settings panel and chat card. A delayed initiating RPC cannot overwrite newer grant state. AppSnap's existing manager reconciles its watcher after a grant change, and Cua's existing host retires cached native state when its fresh permission check observes a change.
6. Success stops checks and closes the guide after a brief confirmation. Dismissal, application shutdown and the five-minute setup limit stop monitoring and cancel the owned prompt. Cancelled or queued work cannot reopen the guide. Slow native cleanup remains fenced until the child exits.

The service, controller, IPC contract and React setup component are shared. The guide is presentation-only and cannot report a grant. Setup does not enable Computer or AppSnap by itself. Existing AppSnap enable requests retain the user's explicit enable choice. Linux and Windows retain their existing setup flow.

Monitoring starts only for an explicit setup session. It makes no model calls, captures no screenshots and installs no keyboard hook. There is no continuous setup poll after completion or dismissal. This is a structural cost bound, not a measured whole-app CPU/RAM or provider-billing improvement.

## Verification

Changes are local over `671cf5e46`. No commit, push, release or replacement of the installed Synara app was performed.

- 142 distinct focused unit/regression tests passed across 11 files: setup advancement, deduplication, cancellation, feature switching, timeouts, native guide lifetime, trusted IPC/drag target, platform gating, AppSnap, Cua host/backend recovery, cache races and setup copy. The final broad run contains 139; the additional preload run adds three platform/bridge tests and repeats eight hook tests.
- Seven Chromium browser tests passed across the new setup component and existing AppSnap settings panel. These cover native state pushes while blurred, automatic progression, AppSnap scope separation, drag IPC, cancellation and a delayed initial state response.
- `bun fmt`, `bun lint` and all seven packages in `bun typecheck` passed. Scoped formatting, lint and desktop/web typechecks cover subsequent lifecycle, preload and hook edits. Existing repository lint warnings remain.
- Desktop, web and server production builds passed. The arm64 AppSnap helper was rebuilt using the existing build/signing script and Command Line Tools.
- An offscreen AppKit harness rendered Accessibility, Screen Recording and completion states, and checked that dragging over the icon targets the app chip rather than moving the guide. It did not display a desktop window.

Local raw logs and previews: `/private/tmp/synara-permission-guide/`. The first expanded socket test run encountered sandbox `EPERM`; those tests passed when rerun with temporary local sockets allowed. Mocked grants and offscreen rendering do not prove a real TCC transition or successful drop in System Settings. No live permission prompts, permission resets, screen captures or desktop input were performed for this change.

## Test an updated app

Use a signed app built from this worktree; an older installed build does not contain these changes.

1. Open Settings → Computer use → Set up. With missing grants, the floating guide should appear and open the first missing pane.
2. If the app is absent, drag the guide's app chip into the list. Turn on that exact app. Remain in System Settings: Accessibility should become granted and Screen Recording should open without another click in Synara.
3. Turn on Screen Recording. Both steps should become granted and the guide should close. Relaunch only if macOS asks; a fresh setup should skip existing grants.
4. Enable Computer in a test chat and ask it to list the open windows. This checks that the backend consumes the new grants, not just that the setup UI turned green.
5. Check AppSnap separately: its guide must request Input Monitoring and Screen Recording, preserve an existing Screen Recording grant, and leave Computer's enablement unchanged.
6. Dismiss setup while waiting, then grant access later. The dismissed guide must stay closed. Starting setup again should detect the current grants. Denying access or cancelling a drag must never show Granted.

Actual grant reconciliation on the reporter's updated signed app remains the runtime acceptance check. A stale grant for a different build or app copy is not something the UI can turn into permission.

## Main integration — 11 September

Rebased all four branch commits onto `origin/main` at `31ed6b9ae`. Preserved main's AppSnap window picker, provider retry/settlement changes, browser shutdown and pending-interaction recovery alongside Computer capabilities. The previous head remains available locally as `codex/backup-computer-before-main-20260911`. No remote push was made.

The running dev watcher attempted to restart Electron while rebasing/rebuilding removed `dist-electron/main.js`, producing the reported “Cannot find module” dialog. The launcher now checks all required bundles before every start, waiting when they are missing or empty. The dev process was stopped for integration, dependencies aligned to the lockfile, and the native helper plus production bundles rebuilt.

Verification: 656 focused regressions passed, with one existing live Codex test skipped without `CODEX_BINARY_PATH`; 200 activation/dispatch tests passed (overlapping the broad run), nine Chromium tests passed, 28 AppSnap/source-launch tests passed, and eight launcher tests passed. Formatting, lint, seven-package typecheck and production builds passed; subsequent formatting/import-only changes received scoped checks. Logs are under `/private/tmp/synara-main-rebase/`. Initial root-level Vitest discovery followed the dev overlay into unrelated worktrees; those results were discarded, and verification was rerun with `--exclude '**/.synara/**'`. Run package-scoped tests or exclude the dev directory when testing this checkout.

## Live reopen and stale grants — 11 September

The reported Electron welcome screen was reproduced in the running process: LaunchServices opened the generated `.app` with no arguments, so Electron loaded `Resources/default_app.asar`. The generated bundle now includes a signed source bootstrap in `Resources/app`, following [Electron's application loading layout](https://www.electronjs.org/docs/latest/tutorial/application-distribution). A small allowlist of launch routing (home, flavor, source-build marker and renderer URL) is saved outside the signed bundle. An OS reopen restores the same source checkout and data directory; explicit source/smoke launches retain their own environment. Tokens and provider credentials are never persisted in this file. Changing routing does not re-sign the app.

A second live issue was confirmed in macOS TCC logs: `Failed to match existing code requirement` for the Synara development bundle and ScreenCapture, comparing the previous and rebuilt cdhashes. System Settings showed its switch on, but the fresh helper correctly reported denied. The attribution log confirms the responsible process is the Synara GUI, not the shell or standalone helper. Polling cannot repair this stale OS grant. The shared native/web guide now explains removing only this app's old entry with the minus button, dragging the current app back in and enabling it. No permissions were reset or toggled by the agent.

The settings/chat checklist also incorrectly converted a merely installed backend into granted permissions before its first native check. Both surfaces now share the same mapping: unprobed grants say `Not checked`, partial native results name the missing grant, and availability alone does not imply permission. An existing server-rendering failure in Computer settings was fixed by guarding access to the desktop bridge.

Validation for this follow-up: 79 unit regressions across five files, 12 launcher tests and five Chromium permission UI tests passed. Scoped formatting, full lint and seven-package typecheck passed; the final small rendering guard and bootstrap changes received targeted tests/lint. The arm64 AppSnap helper rebuilt successfully and the generated app passed strict recursive signature verification. Logs: `/private/tmp/synara-main-rebase/permission-*.log`.

Live validation: quit the development GUI, verified its process exited, then reopened the `.app` through macOS with no application arguments. Synara loaded the same isolated chat and settings. The initial checklist correctly remained unchecked, and starting setup displayed the native missing grants plus the recovery instructions. The final rebuilt app still requires the user to renew its stale Accessibility/Screen Recording grants in System Settings. An actual renewed grant, successful drop and Computer action have not been validated for this final build. The development runner remains active with home `.synara/electron-dev` and renderer port 8891; the unrelated Synara/Canary instances were preserved.

## Authorized live grant recovery — 11 September

After the user explicitly authorized repairing the running development app's permissions, reset only `Accessibility` and `ScreenCapture` for `com.emanueledipietro.synara.dev`. The previous section's no-reset statement describes the earlier verification pass. No production, Canary, Codex or fixture permissions were changed.

The final GUI remained at cdhash `0ebb702b219514d50459f963518085cf426a362a`, with no rebuild or re-sign during recovery. TCC had retained different old requirements for Accessibility and ScreenCapture; dragging an already-listed app had not renewed those requirements. After resetting and enabling Accessibility in System Settings, the running setup automatically advanced to Screen Recording. Synara's own checklist showed Accessibility `Granted` and Screen Recording `Not granted`, confirming a real native transition and state push without Refresh.

Adding the development app back to Screen Recording then reached macOS's **Privacy & Security — Touch ID or enter your password** authentication sheet. The user was away; authentication was not entered or bypassed. Screen Recording renewal, a successful native drag/drop and a Computer capture/action remain unverified on this exact build. The authentication sheet was left ready in System Settings. Setup has a five-minute lifetime; if it has paused when authentication is completed, choose Set up again to resume its fresh checks.

Strict recursive signature verification and `git diff --check` passed after this live pass. The existing 96 focused tests and final lint/typecheck results above were re-inspected, not rerun; this recovery changed only OS state and this report. Restricted TCC diagnostics are in `/private/tmp/synara-main-rebase/permission-renewal-tcc.log`.

## Completed permission renewal and native read-only smoke — 11 September

After the user completed authentication and asked to continue, selected the exact current Synara (Dev) bundle in the Screen Recording add dialog, then accepted macOS's Quit & Reopen. Synara reopened the same isolated chat instead of Electron's welcome screen. A fresh Set up check reported both Accessibility and Screen Recording `Granted`, `Computer control available`, and capture/input capabilities. The GUI cdhash remained `0ebb702b219514d50459f963518085cf426a362a`.

The user's 22:11 chat response still said tools were unavailable because its Computer mode was Off. This was directly confirmed in the composer permissions menu after the system grants succeeded. Enabled `Computer: Keep enabled in this chat`; the next dispatch logged `computerControlChanged: true` and restarted the Codex provider session. A bounded read-only request then used native window listing and reported a direct Synara (Dev) capture, PNG 1536×964, screenshot ID `shot-1`. Native screenshot tool activity was also visible in the user's subsequent independent desktop task. This verifies real permission consumption and Codex tool exposure; it does not qualify every provider or every input action. Renewal used the macOS add dialog, so successful native guide drag/drop is still a separate acceptance check.

Updated the Computer settings ready-state explanation to name the two per-chat enable choices explicitly. Its usage description now makes clear that Set up checks system permissions without enabling existing chats. The eight existing settings rendering tests passed after updating their copy expectations. No provider prompt/schema changes or signature changes were needed for this clarification.
