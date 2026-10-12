# Browser import round 1 builder report

## Result

Added a candidate browser catalog for exactly the 15 requested IDs, with display names and desktop-platform metadata. The catalog explicitly describes candidates and desktop OS availability; it does not assert installation or import support. Existing `BrowserCookieSource` validation remains unchanged, so discovery and runtime validation still gate import.

## Runtime boundary

The current contract/import path recognizes seven runtime IDs: `chrome`, `safari`, `edge`, `helium`, `aside`, `arc`, and `dia`. The BetterWright patch adds custom macOS reader paths for Helium, Aside, and Dia; other IDs are delegated to BetterWright's native reader. This checkout has no installed `betterwright` package to inspect its accepted-source implementation. Therefore the eight new IDs (`brave`, `vivaldi`, `opera`, `opera-gx`, `chromium`, `comet`, `firefox`, `zen`) were not added to `BrowserCookieSource` or IPC validation. Passing them through `profiles()` would send them to BetterWright without evidence that it accepts them.

## Files changed

- `/Users/user/.codex/worktrees/browser-cookie-import/synara/packages/contracts/src/browserImportCatalog.ts`
- `/Users/user/.codex/worktrees/browser-cookie-import/synara/packages/contracts/src/index.ts`
- `/Users/user/.codex/worktrees/browser-cookie-import/synara/packages/contracts/src/browserImportCatalog.test.ts`

No UI, user database, credentials, or other worktree was touched. No commit or push was made.

## Checks

- `bunx oxfmt --check packages/contracts/src/index.ts packages/contracts/src/browserImportCatalog.ts packages/contracts/src/browserImportCatalog.test.ts` — passed.
- `git diff --check` — passed.
- Focused Vitest and contracts typecheck — blocked before execution: Bun exited with `listen EPERM: operation not permitted 127.0.0.1` in this sandbox.
