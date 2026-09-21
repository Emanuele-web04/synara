---
name: verify-library-panel
description: How to reach and exercise the per-group git-versioned Library panel in an isolated Synara web instance.
---

# Verifying the group Library panel

The Library panel only renders on group-container threads (gated by
`resolveProjectPanelEnabled` = environmentEnabled && isGroupContainer). Group
projects have no list UI, so create them via devtools:

```js
const a = (await import("/src/wsNativeApi.ts")).createWsNativeApi();
await a.orchestration.dispatchCommand({
  type: "project.create",
  commandId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  kind: "group",
  title: "<name>",
  workspaceRoot: "<abs path>",
  createWorkspaceRootIfMissing: true,
  createdAt: new Date().toISOString(),
});
// then thread.create {threadId, projectId, title, modelSelection:{provider:'codex',model:'gpt-6-astra'},
//   runtimeMode:'full-access', interactionMode:'default', branch:null, worktreePath:null, createdAt}
// navigate to /<threadId>
```

- Toggle = book icon, `aria-label="Toggle library panel"`, leftmost of the trailing
  chat-header toggles; its tooltip reads "Library".
- "+ Add" opens a native macOS file dialog: Cmd+Shift+G, type the FULL file path
  (not just the folder — the folder alone leaves the column browser at home), Return,
  then click Open. Repeat per file; multi-select also works.
- Row context menu is an in-page fallback (Rename/Delete/History) — right-click the row.
- History subview uses `git log --follow`, so pre-rename commits appear; Restore on a
  pre-rename sha exercises the cross-rename path (regression: used to fail with
  a pathspec error).
- Remote-status pill renders only when `libraryRemoteUrl` is configured. There is no
  settings UI for it; configure via
  `api.projectAgent.configure({projectId, requestId, coordinatorModelSelection:{provider:'codex',model:'gpt-6-astra'}, libraryRemoteUrl:'<url>', libraryPushOnChange:true})`
  then any mutation pushes; the pill shows "Pushed"/"Push failed". Verify with
  `git -C <remote repo> log --oneline main`.
- The list shows "size · relative date" per row (e.g. "75 B · 4m").
- `.synara-library` is an ownership marker: `ensureLibraryRepo` refuses existing git
  dirs lacking it. Libraries seeded before commit 922c20c9 have no marker — to keep
  testing an old library, write it manually: `printf 'synara-library\n' > <lib>/.synara-library`.
- `libraryRemoteUrl` accepts only https://, ssh://, git@host:path; file:// fails the
  schema and push-time re-check, so a persisted file:// remote yields the "Push failed"
  pill. A reachable https/ssh remote is needed for a positive push test.
- Server-side commit messages: `Initialize library`, `Add <path>`, `Rename <a> to <b>`,
  `Delete <path>`, `Restore <path> from <sha7>`; repo lives at
  `<stateDir>/project-context/<projectId>/library`.
