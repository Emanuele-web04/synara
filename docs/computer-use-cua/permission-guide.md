# Automatic macOS permission setup — 10 September 2026

The earlier permission service fix provided fresh native checks, but the setup UI still depended mainly on returning to Synara. It did not provide a floating guide or a desktop-owned loop that could advance while System Settings was foreground. The reporter's screenshot also contains two differently named app entries; it does not establish that the running build has a valid grant.

[PR #913](https://github.com/Emanuele-web04/synara/pull/913), head `fc77265cd26f5e11197fe72dfbbc26163ef0f38a`, was reviewed as a design reference. This change adopts the floating app-drag guide idea. It does not import that PR's picker, global Escape hook, repeated window-follow scans or same-process permission polling.

## Resulting flow

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
