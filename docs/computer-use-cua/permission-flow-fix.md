# Shared macOS permission flow — 10 September 2026

The reported stuck Computer setup card exposed several code defects. Computer requested Accessibility but merely opened the Screen Recording settings pane; it never made AppSnap's native Screen Recording request. Passive status came from the long-running embedded Cua process, which could retain a negative preflight result. The card also preferred historical missing grants over current status.

## Changes

- `DesktopPermissionService` is owned by Electron and shared by AppSnap and Computer. It reuses the bundled AppSnap helper and its existing build/signing path.
- AppSnap keeps Input Monitoring + Screen Recording. Computer selects Accessibility + Screen Recording. Screenshot-only callers can select only Screen Recording. Checking state never requests access, captures the desktop or enables control.
- Explicit setup requests missing selected grants, rechecks in a separate child, then opens the Settings pane for the first remaining grant. There is no automatic TCC reset.
- Permission changes retire Cua through the native cleanup acknowledgement barrier, invalidate old desktop observations and require fresh observation before input. Capture-health failures can recover after setup or a newly observed Screen Recording grant.
- Visible AppSnap and Computer surfaces share focus/visibility refresh. Live missing grants and optional app identity survive the server contract and replace old transcript labels. Setup pending state is shared across Computer surfaces.
- Native helper output and execution are bounded. Overall queue-inclusive budgets are 30 seconds for checks and 90 seconds for requests; setup transport allows 120 seconds. Expired queued work cannot launch late prompts. Stop, lock, suspend and disconnect release passive Computer waits without cancelling another feature's prompt.
- Development launcher copies are signed after plist/icon customization, verified before caching and reused without re-signing. This fixes invalid generated signatures; the screenshot alone does not establish whether this affected the reporter.

## Verification

Local changes were tested over commit `8b24f6760`; no commit, push or release was made for this fix.

- 141 focused Vitest tests across nine files passed: helper ownership/timeouts, AppSnap extraction, Cua grant transitions and Stop/disconnect behavior, backend recovery, UI state and contract serialization.
- Eight launcher tests and three Chromium settings tests passed.
- `bun fmt`, `bun lint`, and all seven packages in `bun typecheck` passed. Final targeted formatting/lint checks cover subsequent integration edits.
- Desktop, web and server production builds passed.
- The arm64 AppSnap helper compiled and the development helper was rebuilt using the existing build script with Command Line Tools.
- A real temporary Electron 43.4.1 development bundle passed `codesign --verify --deep --strict`. Cached reuse ran zero subprocesses and retained the same CDHash; the source Electron bundle remained unchanged.
- Independent review closed the timeout, Stop coupling and Settings-launch lifecycle findings.

Raw local logs are under `/private/tmp/synara-permission-flow/`. No application was launched for the signing check, and no live permission prompts, TCC resets, screen captures or desktop input were performed in this fix. These checks do not establish successful grants on the reporter's machine. Installed users need an updated build; the next runtime check is that Set up registers missing grants, return-from-Settings refreshes the card, and an explicitly requested Computer observation succeeds in that build.
