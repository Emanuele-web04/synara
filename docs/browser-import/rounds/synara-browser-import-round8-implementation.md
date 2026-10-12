# Synara browser import — Round 8 implementation

**Slice:** One-time existing-installation prompt for browser import.

**Changes**

- Added a reusable prompt using the existing `AnnouncementSheet` and startup slot. It probes installed browser sources and profiles, prompts only when at least one profile is available, and routes users to the shared Browser Import panel in General Settings.
- Acknowledgments are stored per server installation. Dismissal and confirmation acknowledge the current installation.
- First-run onboarding records the installation only when its browser-import step is actually displayed. A provisional welcome that auto-closes before that step leaves the existing-user prompt eligible.
- Browser discovery waits for the first-run gate, stops while onboarding is open, and scopes results to the installation being inspected.
- Added browser tests for routing, empty profiles, provisional onboarding, actual step acknowledgment, startup gating, dismissal/remount, and installation changes.

**Critic:** Initial review was `REVISE` for provisional onboarding persistence and incomplete async assertions. Fixes added a step-seen signal, discovery gating and awaited async checks. A second review found the signal needed installation identity; it now stores the `worktreesDir`, and an A→B regression test covers mounted installation changes. Final fresh-context verdict: `ACCEPT`.

**Validation**

- `bun run fmt:check`: passed on 4,636 files.
- `bun run lint`: passed, 886 warnings and 0 errors; server synchronous filesystem budget passed.
- `bun run typecheck`: passed for all 7 packages after the final installation-key refinement.
- Focused browser UI tests: 7/7 passed in installed Chrome with an isolated context.
- Default Playwright Chromium launch is unavailable because its headless-shell binary is not installed. Test-only Chrome config was restored after each run.
- `git diff --check`: passed before commit.

**Not covered by this slice:** real desktop import, macOS Keychain/vault restart, Windows/Linux browser matrix, and broader browser/profile support.
