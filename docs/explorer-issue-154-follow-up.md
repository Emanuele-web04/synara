# Explorer follow-up (#154)

The existing dock/editor explorer shares
[`workspaceExplorer.tsx`](../apps/web/src/components/chat/workspaceExplorer.tsx).

- Single-child directory chains compact as their lazy listings become available.
  Expanding a row loads only that chain, not sibling directories. Existing
  hover/focus prefetch remains. Collapse uses the original directory's expansion
  key; drag, chat references, and copy actions use the chain's final path.
- Shared disclosure transitions and arrow-key/Enter navigation remain in use.
  A refreshed listing with multiple children splits a compact row again.
- File indicators use the existing workspace-scoped Git status query/cache:
  green **Added/Untracked**, amber **Modified/Renamed/Copied/Unmerged/Type changed**,
  and red **Deleted**. Missing files are not invented as explorer rows. Parent
  directories summarize changes in amber and explicitly identify unmerged
  descendants, including when a chain is compacted or closed. A direct status
  on an intermediate directory (for example a submodule) survives compaction.
- The optional `workingTree.files[].changeType` contract field is authoritative
  Git metadata from the existing NUL-delimited porcelain read, not line counts.
  Empty and binary files retain their real types. Normal and move-aware summaries
  preserve these fields; existing NUL rename pairs identify unstaged moves without
  an extra command or changing the real index. Temporary-index staging retains
  zero-count porcelain metadata when staged/worktree changes cancel, including
  conflicts and type changes, without reintroducing consumed rename sources or
  aggregate untracked-directory records. Normal reads still count untracked text
  files through the existing read path. Older servers without the field retain a generic amber
  **Working tree changes** indicator. Opaque status filenames are not trimmed.
- Right-click **Copy** groups relative path, absolute path, and (for files) file
  content. Absolute paths use the shared native-path joining helper. Content is
  read on selection through the existing workspace-authorized API, never through
  a new filesystem or preview-grant bypass. The existing clipboard helper reports
  empty files and partial large-file copies; read failures leave content uncopied.
- No virtualization or dependencies were added: no measurement demonstrated a
  need. Rename/delete/create and user-configurable exclusions remain out of scope.

Focused regressions live in `workspaceExplorer.logic.test.ts`,
`workspaceExplorer.browser.tsx`, `fileReferenceContextMenu.test.ts`, contract
`git.test.ts`, and server `gitStatusParsing.test.ts` / `GitCore.test.ts`. The core
cases use isolated real Git repositories, including binary moves and unresolved
merge indexes. Browser tests use a mocked native API, not a live provider or
production Synara state.

## Issue #154 acceptance status

The original core explorer pane, lazy directory loading, directory-first sorting,
and exclusion rules predate this follow-up; this PR adds lazy single-child path
compaction, authoritative Git change types, and grouped copy actions. Existing
keyboard navigation is retained. The one advanced acceptance item still not
implemented is virtualized rendering: no large-project measurement has shown a
need for it. Live filesystem watching, drag-and-drop import, create/rename/delete,
and user-configurable exclusions are explicitly deferred. These are remaining
scope gaps, not functionality this PR claims to deliver.

## Handoff verification (2026-10-10)

| Check                                                                   | Exact result                                                                                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/git/gitStatusParsing.test.ts`                          | **41 passed**, final metadata-retention fix included                                                                                                      |
| Focused `apps/server/src/git/Layers/GitCore.test.ts`                    | **9 passed, 126 skipped**, final fix included: opaque paths, untracked counts, move totals, zero-count files, staged rename/copy, type changes, conflicts |
| Full GitCore + parser + GitStatusBroadcaster files                      | **186 passed** on the integrated head, including the final zero-count retention fix; 4 credentialed live tests skipped                                    |
| `packages/contracts/src/git.test.ts`                                    | **12 passed**                                                                                                                                             |
| Explorer logic, context menu, navigation, clipboard, UI font-size files | **55 passed**                                                                                                                                             |
| Explorer + dock + dock autosave Chromium files                          | **22 passed** (13 explorer, 9 dock/autosave); parent-owned dock selector changes preserved                                                                |
| Owned-file formatting / scoped lint                                     | Formatting passed; lint **0 errors, 2 unchanged warnings** (existing parser-test function scope and unrelated GitCore array sort)                         |
| React Doctor, three owned source files                                  | **93/100**, unchanged export/complexity warnings; prior selected-file result also 93/100                                                                  |

The final narrow server commands were:

```bash
bun run --cwd apps/server test src/git/gitStatusParsing.test.ts
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 LC_ALL=C LANG=C TMPDIR=/tmp/opencode bun run --cwd apps/server test src/git/Layers/GitCore.test.ts -t 'preserves adversarial filenames in status details|counts untracked text files|uses rename-aware totals|classifies empty and binary files|keeps zero-count deleted files|retains staged rename/copy|retains staged type changes canceled|retains an unmerged file'
```

Other passing commands:

```bash
bun run --cwd packages/contracts test src/git.test.ts
bun run test:web:focused src/components/chat/workspaceExplorer.logic.test.ts src/lib/fileReferenceContextMenu.test.ts src/components/chat/explorerListNavigation.test.ts src/hooks/useCopyToClipboard.test.ts src/uiFontSize.test.ts
VITEST_BROWSER_API_PORT=51184 PORT=57184 bun run --cwd apps/web test:browser src/components/chat/workspaceExplorer.browser.tsx src/components/chat/DockExplorerPane.browser.tsx src/components/chat/DockExplorerPane.autosave.browser.tsx
```

Earlier failures are resolved in their focused reruns: browser label/cache timing
assumptions, the temporary-index type-change omission, and untracked counts
affected by the first retention attempt. An inherited Git configuration/locale
caused 12 failures in an earlier unisolated full GitCore run; the clean-config,
C-locale full run passed without changing user configuration. The first combined
browser attempt timed out; the subsequent combined run passed all 22 tests.

**Integrated-head verification:** focused explorer/server/contracts/browser tests,
repository formatting, lint, typecheck, and the full GitCore/parser/broadcaster
set were rerun after integrating current main. Lint passed with 871 warnings and
no errors; the server synchronous-filesystem budget passed; all seven packages
typechecked. No live provider/production instance or packaged Windows validation
was performed; real symlink/type-change fixture cases are Linux-tested and skip
Windows. The broader workspace test suite was not rerun here.

Existing `StatusDot`, disclosure components, keyboard navigation, context-menu
grouping, clipboard helpers, and Git/project query APIs are reused. The new lazy
chain helper is necessary because the existing diff-tree compactor requires an
eagerly populated tree; no comparable lazy/status-label helper existed.

Visual evidence from matched mocked Chromium fixtures is in
[`docs/pr-screenshots/explorer-154/README.md`](pr-screenshots/explorer-154/README.md).
It compares the PR against its pre-feature main parent and demonstrates the
compact chain, mocked Git indicator, and copy submenu. The browser fallback menu
is rendered; this is not native desktop-menu or live-workspace evidence.
