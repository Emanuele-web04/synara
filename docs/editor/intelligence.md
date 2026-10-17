# Native editor intelligence

Synara keeps its Files, Changes, file headers, chat, search, Git, terminal, and document sessions. Editable previews, file editors, docked editors, and editable diffs use the native document session as their shared buffer. Monaco-backed surfaces share one text model for that session. There is no Code-OSS workbench, alternate IDE mode, new explorer, extension host, or second disk writer in this change.

## Supported operations

TypeScript and JavaScript use the project's nearest `tsconfig.json`/`jsconfig.json`, including unsaved open dependencies. Without a configuration, the compiler creates an inferred project. Completion, completion documentation, signature help, hover, declaration/definition/type navigation, references, symbol search, rename, diagnostics, text-only quick fixes/refactors, formatting, organize imports, semantic classification, inlay hints, and folding use the actual TypeScript language service. No static suggestions or tsserver plugins are loaded. Project-local dependencies are readable; symlinks and configuration references outside the workspace are deliberately not traversed.

JSON, CSS and HTML have Monaco's standalone language workers. Other registered languages retain syntax highlighting, editing, folding, and find/replace; they do not gain a project language server from this PR. Workspace text search remains Synara's existing search interface. Workspace-symbol search is limited to the current compiler project, not every nested project in a monorepo. Auto-import completion and code actions requiring arbitrary commands or file creation are not advertised.

Press F1 in an editor for Synara's command picker. F12 navigates to a definition, Shift+F12 opens references, and F2 opens the native rename dialog. Completion and signature widgets live inside the editor engine and use Synara's theme tokens. Diagnostics and code actions are contextual, with a native problems picker. Selected code can still be referenced in chat through the existing callback.

## Ownership and safety

`WorkspaceEditorSession` remains the authoritative dirty buffer, conflict handler and sole disk writer. Monaco shares that session's text across file/diff surfaces; changing view or theme does not create another undo history. Explicit reload/discard resets the model history; ordinary edits do not. The existing native autosave, encoding/BOM, line-ending, optimistic disk-version and navigation-flush rules still apply.

Language services receive immutable UTF-16 snapshots and return edits, never save files. A multi-file refactor rereads every target through Synara's file API, validates expected buffer contents and native conflict state, and rejects unsafe/duplicate paths and overlapping spans before changing any buffer. Disk persistence remains independently version-checked for each file; this is **not a transactional multi-file filesystem commit**. Failed writes preserve native drafts. This change does not add or claim crash recovery.

The compiler is lazy and isolated in a worker, with at most four client/workspace instances, 512 MB worker heaps, sixteen queued requests per instance, a 15-second deadline, and idle disposal. Input is bounded to 64 documents, two million UTF-16 units per document and eight million in total. Refactor results are bounded to 200 files/eight million units. These are limits, not performance-improvement measurements. Large unsupported snapshots show a recoverable service notice without disabling editing/saving.

Large file previews retain Synara's existing numbered-textarea fallback (more than 1,000 lines or the existing syntax-highlighting character threshold). That engine choice is stable for the open document, including clearing, saving, and toggling Markdown preview. These lightweight previews do not offer IntelliSense; opening the file in the full file/diff editor uses the virtualized intelligent editor instead. There is no competing save path.

## Debugging

F5 opens a native launch confirmation; F9 or the gutter toggles a breakpoint. The command picker also offers attach to a Node inspector on the **server machine's loopback interface**. Launch first flushes native workspace buffers. The dialog explicitly states that starting a program executes trusted workspace code and downloads the checksum-pinned debugger on first use.

The contextual debug section provides continue/pause/stop, step into/over/out, call stack, scopes/variables, watches, console evaluation and output. It uses Microsoft's real standalone `vscode-js-debug` DAP server, including its child-target handshake. Debug sessions belong to the owner RPC connection and expire after disconnected inactivity. Synara's existing shared process boundary owns spawn/teardown. An attached external process is detached, not killed. Debug console/watch evaluation runs code in the debuggee and must be treated accordingly.

Process teardown captures descendant identities before DAP disconnect and retains them across a failed cleanup retry. Only verified process-tree exit marks a session stopped or allows its slot to be reused. Windows observer startup has a separate bounded cold-start allowance. An adapter crash before identity capture reports unproven cleanup rather than pretending an empty, reparented process tree is safe; automatic recovery from such a crash is not claimed.

The initial configuration supports a workspace JS/TS entry point, literal argument array, pause-on-entry, or a loopback inspector port. It does not read/execute `.vscode/launch.json`, run pre-launch tasks, invent a second terminal backend, or support every debug adapter. TypeScript entry points depend on the selected Node runtime's native TypeScript support; no hidden transpiler is installed. Browser debugging, TSX, remote inspector hosts, interactive terminal stdin, advanced launch recipes and extension-provided debug adapters are not claimed here.

Packaged desktop builds retain TypeScript’s `lib*.d.ts` standard libraries as runtime compiler input, overriding electron-builder’s default declaration-file exclusion. These files are required for editor intelligence even when dependency diagnostics are omitted.

## Upstream versions and licenses

- `monaco-editor` **0.57.0**, MIT: the standalone Code-OSS editor engine, not the workbench. The dependency and workers are lazy-loaded by editing surfaces. Existing Pierre read-only diff rendering remains intact.
- `typescript`: the repository's existing catalog range and lockfile resolution (**5.9.3** in this candidate), Apache-2.0. Promoted from server development-only to a server runtime dependency; no compiler upgrade.
- `microsoft/vscode-js-debug` **1.140.0**, MIT, standalone `js-debug-dap-v1.140.0.tar.gz`; SHA-256 `27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968`. Downloaded only on explicit debugging into the current Stable/Beta data directory. License files are retained from the verified archive.

Pierre 1.3.5 exposes edit/history and marker APIs but not the public folding, semantic-token and inlay-hint integration required here. Reimplementing those against private renderer internals would be less maintainable than using the standalone editor. Only the internal editable engine changes; there is no imported application chrome. Monaco's version-specific package paths are isolated in `codeEditor`.

## Verification and evidence

Focused tests cover real TypeScript projects and a real compiler worker; existing native document/session tests cover the save/conflict ownership. Opt-in debugger tests use the actual upstream adapter and an actual Node process, including launch/breakpoints/steps/variables/watch/pause/cleanup and separately owned attach/detach.

```sh
bun run --cwd apps/server test src/editor/typescriptService.test.ts src/editor/dapConnection.test.ts
SYNARA_TEST_JS_DEBUG=1 bun run --cwd apps/server test src/editor/debugService.test.ts
bun run --cwd apps/web test src/lib/workspaceEditorSession.test.ts src/lib/workspaceFileEditor.test.ts
bun run --cwd apps/web test:browser src/components/codeEditor/CodeEditorPane.browser.tsx src/components/codeEditor/editorModels.browser.tsx
bun run --cwd apps/web test:editor:e2e
```

The real-app Playwright journey starts isolated server/web processes and creates an idle project/thread through real RPCs. It never submits an agent turn or substitutes mocked service responses. Screenshots are captured only after assertions on actual completion, diagnostics, navigation and debugger state. The component tests separately exercise buffer, undo/redo, reload, CRLF, virtualization, and shared-model transaction behavior. Opt-in `VITE_EDITOR_BENCHMARK=1` runs the editable-surface benchmark; it measures Monaco command execution plus display frames, not physical keyboard latency.

At initial publication, local Linux compiler tests, session tests, DAP transport tests, actual debugger tests, focused typechecks, and the built compiler-worker smoke had passed. Browser acceptance and screenshots were pending because the local Chromium is managed with an all-URL block policy; that policy was not changed. The PR's CI artifacts/status are the source of truth for subsequent browser/platform results. macOS/Windows packaged Electron behavior, signed builds, installed-size deltas and before/after performance comparisons are not established by the local checks.
