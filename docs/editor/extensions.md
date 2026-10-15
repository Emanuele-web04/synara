# Optional Code-OSS extensions

This is the extension layer stacked on [the native editor](./intelligence.md). The native editor remains independently usable without building, installing or starting an extension host. Synara retains its existing Files, Changes, chat, terminal, navigation and debugger panels. There is no embedded VS Code workbench.

## Current execution boundary

The production launcher currently supports Linux with Node.js 24 and bubblewrap. Real execution is verified on Ubuntu 22.04. macOS and Windows extension execution is deliberately disabled until equivalent OS-enforced launchers are available. Package-management support is separate from execution support.

Ubuntu 24.04 policies can deny the required network/user namespace operations. Synara fails closed in that case; it does not switch to an unsandboxed child or disable AppArmor. Remote servers use the server operating system for this decision, not the browser's operating system.

The host has no host-network access, inherits no provider/GitHub/Synara credentials and sees read-only workspace, package and runtime mounts. Only assigned extension storage is writable. Extensions needing network downloads, cloud authentication, external debug attachment, another terminal or a graphical webview are not supported by this launcher.

## Use the native interface

1. Build the optional runtime below and start an isolated Synara development instance using the repository's normal development commands.
2. Open **Settings → Extensions**. Search Open VSX by keyword or exact `publisher.name`, or choose **Install VSIX**.
3. Installation never authorizes execution. Choose **Enable**, review the exact package digest and dependencies, then explicitly trust the intended workspace.
4. Open an editable workspace file, press **F1**, and choose **Start approved extensions**. The host starts lazily, only after this action and the server's approval/trust checks.
5. Use **Format with extension…**, **Run extension command…**, **Open extension view…** or **Start extension debugger…**. Language providers use the existing editor. Tree data uses native list pickers; progress, status, input and notifications use Synara components.
6. **Stop extensions** shuts down the owned host/process tree. Disabling an extension, changing configuration or revoking workspace trust stops affected hosts. Updating a package resets execution approval.

For a contributed debugger, provide a compatible launch configuration in `.vscode/launch.json`. Native Debug/GDB is verified with a compiled program and `stopAtEntry`. The normal Node.js debugger from the editor PR remains the default path. Stopping an extension debugger currently stops that workspace's complete extension host so descendant ownership can be captured before adapter disconnect.

## Build the optional runtime

The source pin is Code-OSS commit `7debcd0e2acdea1c52de81bf9ee1620444407dda`, API version `1.138.0`. The source archive SHA-256 is `75b125b51f7258dbbd4cafb25ae658ea0edac4f2f5ad2ff9f61aeb8e1f99ee5e`. esbuild is pinned to `0.25.12`.

The permanent [build action](../../.github/actions/build-code-oss/action.yml) downloads and verifies this exact archive, installs the upstream lockfile with lifecycle scripts disabled and builds only the headless host. It does not depend on short-lived recovery artifacts. The acceptance workflow builds Synara first, then the optional host because the server build cleans `dist`.

For a local Linux build, use a new temporary directory for the verified upstream source and builder. Do not run dependency installation in a user workspace or reuse production Synara state:

```sh
# Run from the Synara repository root with the required Node/Bun toolchain.
repo_root="$PWD"
work="$(mktemp -d -t synara-code-oss-build-XXXXXX)"
cd "$work"
curl --fail --location --max-time 90 \
  'https://codeload.github.com/microsoft/vscode/tar.gz/7debcd0e2acdea1c52de81bf9ee1620444407dda' -o source.tar.gz
echo '75b125b51f7258dbbd4cafb25ae658ea0edac4f2f5ad2ff9f61aeb8e1f99ee5e  source.tar.gz' | sha256sum -c -
tar -xzf source.tar.gz
cd vscode-7debcd0e2acdea1c52de81bf9ee1620444407dda
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
mkdir "$work/builder"
cd "$work/builder"
printf '%s\n' '{"private":true,"dependencies":{"esbuild":"0.25.12"}}' > package.json
npm install --ignore-scripts --no-audit --no-fund
cd "$repo_root"
SYNARA_CODE_OSS_SOURCE="$work/vscode-7debcd0e2acdea1c52de81bf9ee1620444407dda" \
SYNARA_ESBUILD_MODULE="$work/builder/node_modules/esbuild/lib/main.js" \
node scripts/build-code-oss-host.mjs
```

The default output is `apps/server/dist/code-oss/extension-host.mjs`, alongside a runtime checksum manifest and license notices. A server operator can instead set `SYNARA_CODE_OSS_RUNTIME` to the absolute runtime entry path. This is trusted operator configuration, not an extension-controlled setting. No runtime is fetched or executed by opening Settings alone.

Only build from the verified source archive: the bundler's API-version check is not a substitute for verifying its checksum. Distributing the generated runtime requires retaining its Code-OSS and bundled dependency notices. No signed desktop installer, automatic platform-specific runtime download or universal extension package is claimed by this change.

## Verified extension matrix

[Acceptance run 38811642786](https://github.com/Emanuele-web04/synara/actions/runs/38811642786) tested the following actual Open VSX packages in the production sandbox, with no mock extension host:

| Category        | Extension                        | Version | Verified behavior                                                                                                                                                                                            |
| --------------- | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formatter       | `esbenp.prettier-vscode`         | 12.4.0  | Actual activation and formatting, unmodified disk in provider tests, owner/trust enforcement and cleanup. The real Synara UI also installs, approves, formats, saves, undoes/redoes and stops the extension. |
| Linter          | `davidanson.vscode-markdownlint` | 0.62.1  | Real MD018 diagnostic and removal of that diagnostic after an unsaved native document update; unchanged disk and cleanup.                                                                                    |
| Language server | `redhat.vscode-yaml`             | 1.25.0  | Actual language-server process, local-schema diagnostics and completions, unsaved snapshots, unchanged disk and cleanup.                                                                                     |
| Debugger        | `webfreak.debug`                 | 0.27.0  | Real upstream descriptor, GDB launch, stop event, stack frames, scopes, expression evaluation and owned-process cleanup using Synara's debugger contracts.                                                   |

Package digests are recorded in the `REAL_*` evidence lines in the workflow log. These results are not universal compatibility promises. In particular, Native Debug 0.27.0 sends a spaced expression such as `6 * 7` to GDB/MI without the quoting it requires; the supported `6*7` form is verified. Synara does not silently rewrite arbitrary expressions to hide that upstream limitation.

## API and presentation matrix

“Verified” means the named behavior has deciding execution evidence. “Partial” means an implementation or narrower test exists but important behavior remains unsupported or unverified.

| Surface                                                                    | Status             | Boundary                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open VSX installation and native Settings                                  | Verified           | Real application journey; exact identifiers use validated registry metadata instead of relying on search indexing.                                                                                                                                                               |
| Local VSIX extraction                                                      | Verified           | Real ZIP entries, CRC, size bounds, links/traversal/case collisions and staging cleanup tests. The local file-picker/upload journey is not yet a separate end-to-end scenario.                                                                                                   |
| Dependencies, updates and configuration                                    | Partial            | Bounded dependency graph, enable/disable and digest approval, compatible stable selection, native JSON settings and atomic package state. Not every marketplace/dependency upgrade path has a real-package test.                                                                 |
| Host lifecycle, trust and isolation                                        | Verified / partial | Normal start/stop, revocation, ownership and sandbox files/processes verified. Crash recovery and hostile resource exhaustion need additional coverage.                                                                                                                          |
| Documents and formatting                                                   | Verified           | Native model/session writer, version and content checks, dirty-buffer preservation, undo/redo and autosave exercised.                                                                                                                                                            |
| Completion and diagnostics                                                 | Verified / partial | Actual YAML and markdownlint results; native adapters are integrated. Not all completion features or languages are covered. Deferred completion resolution and acceptance commands are not advertised.                                                                           |
| Hover, signature, navigation, symbols, folding                             | Partial            | Native providers and bounded DTO validation implemented; no real-package end-to-end assertion for every provider kind.                                                                                                                                                           |
| Rename and code actions                                                    | Partial            | Snapshot-guarded text workspace edits use the existing native writer. Every target must already be open/synchronized. Resource create/delete/rename and command-only actions are not supported.                                                                                  |
| Tree Views                                                                 | Partial            | Actual upstream provider bridge plus native list/back navigation and contribution tests. No custom webview, drag-and-drop, checkbox or custom context-menu rendering.                                                                                                            |
| Quick Pick and Input Box                                                   | Partial            | Native single-selection and text/password prompts; multi-selection and extension validation callbacks are unsupported.                                                                                                                                                           |
| Notifications, progress and status                                         | Partial            | Native toasts, interactive dialogs, cancellable progress and bounded contextual status. Contribution adapter tests do not prove every external extension's UI behavior.                                                                                                          |
| Debug adapters                                                             | Verified / partial | Native Debug/GDB descriptor and standard DAP operations verified. Launch only, no reverse terminal requests, external debug servers, compound sessions or memory/disassembly webviews.                                                                                           |
| Filesystem APIs                                                            | Partial            | Bounded reads and brokered native text writes. External create/change/delete events use sandbox-local, non-recursive directory watches with explicit traversal; symlinks are skipped. Out-of-workspace roots and network-filesystem guarantees are unsupported.                  |
| Semantic tokens and inlay hints from extensions                            | Partial            | Full semantic snapshots and legends are validated before native rendering. Display-only hints, provider invalidation and upstream cache release are implemented. Deferred hint resolution, clickable hint commands, hint edits and RelativePattern selectors remain unsupported. |
| Arbitrary webviews, notebooks, alternate SCM/terminal, VS Code agent tools | Unsupported        | No second workbench or parallel provider/control-plane authority is exposed.                                                                                                                                                                                                     |
| macOS/Windows extension execution                                          | Unsupported        | Package management is separate; execution fails closed until native OS sandbox support exists.                                                                                                                                                                                   |
| Packaged Electron runtime and signed release                               | Not verified       | Source/browser and server checks are not equivalent to a signed desktop installation.                                                                                                                                                                                            |

## Ownership and safety

`ExtensionRuntime` owns authenticated connection/workspace lifetimes and uses the existing shared process launcher and capture-before-disconnect teardown. Extensions cannot authorize their own installation, approval or workspace trust. Package code runs only in the child, never in Synara's renderer or server process.

VSIX limits include 128 MiB compressed input, 512 MiB total extraction, 25,000 entries, canonical path/collision checks, CRC verification and rejection of symlinks, special/encrypted entries and traversal. Installed packages are read-only to the host. Package manifests are revalidated before execution.

Only the native session writer saves workspace documents. Extension API text changes are prepared against exact document snapshots and rejected if a buffer changed. Direct `node:fs` writes to workspace/package mounts are blocked by the OS. Extension-owned storage I/O stays in the sandbox; broker-owned mementos live outside child-writable mounts. Multi-file buffers are prevalidated, but disk persistence remains per-file rather than a filesystem transaction.

All persisted paths descend from the running server's state directory. Stable and Beta therefore retain separate extension packages, approvals, trust and mementos. Revocation stops hosts before state changes. No cross-channel migration or shared credential store is introduced.

The host has bounded frames, pending requests, event buffers, output, idle lifetime and a Node heap limit. These limits are not a claim of complete protection against every CPU/process/disk exhaustion attack.

## Evidence and review

The [authentic application artifact](https://github.com/Emanuele-web04/synara/actions/runs/38811642786/artifacts/12008722519) contains native Settings, search, disabled installation, explicit approval, workspace trust, formatter selection, before/after formatting and cleanup captures. The before/after pair shows an actual document transformation in Synara, not an image-generation mockup or a VS Code screenshot. Artifact retention is finite; the permanent acceptance workflow regenerates the evidence.

The integrated candidate passed `fmt:check`, `lint`, `typecheck`, `windows-runtime:check`, package safety tests, native bridge/contribution browser tests, all four real extension categories and the actual application journey. Additional screenshots for the contributed debugger and platform package checks belong to their corresponding later workflow results; do not infer them from the earlier run.

The optional headless bundle measured 5,947,397 bytes in the cited candidate build. This excludes installed extension packages, source/build dependencies and the rest of Synara. No before/after startup, RSS, responsiveness or total installer-size improvement is claimed.

Remaining release gates include macOS/Windows execution, packaged Electron acceptance, expanded compatibility/negative tests, extended watcher coverage, deferred extension hint resolution and edits and platform-specific resource confinement. The PR stays draft while these required gaps remain.

## Native language snapshots and external file events

`extensionRichLanguage.browser.tsx` protects legend/tuple bounds, UTF-16 positions, hint rendering, untrusted Markdown and workspace-scoped registrations. `realLanguageFeatures.test.ts` installs an executable test VSIX through the actual upload/approval path and runs it in the real Code-OSS host and production sandbox. This fixture checks full semantic snapshots, inlay hints, provider invalidation, external file events and preservation of unsaved document snapshots; it is a purpose-built API-contract extension, not another marketplace compatibility claim. Read the corresponding CI result before treating any new check as passed.

File watching is event-driven rather than a whole-workspace polling loop. The shared default watch excludes `.git` and `node_modules`, plus configured `files.watcherExclude` patterns. Explicit in-workspace watches can cover otherwise excluded directories. A host permits at most 16 watch groups, 512 watched directories and 20,000 retained entries. Exceeding a limit or losing OS watch support reports a visible error instead of falling back to unrestricted watching. Extension editing remains available if the default watch cannot start. No watcher writes files, reloads a native editor buffer, traverses symlinks or opens the Synara control-plane directory.
