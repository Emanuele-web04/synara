# Changelog

## [0.9.0] — 2026-09-21

**Computer Use arrives in beta, available on macOS only at the moment. Linux is coming soon.** Ask Synara to operate Mac apps and browsers with `/computer-use`, follow the targeted window in a preview, and stop the task from chat. The rest of this release brings project import, richer provider controls, clearer review workflows and many reliability fixes.

### Added

#### Computer Use beta

- Native Mac app inspection and actions, including window targeting, text entry, clicks, scrolling, keyboard shortcuts, menus and text selection, through the bundled Cua driver. App compatibility varies during beta. (#1090, #1227, #1286)
- `/computer-use <task>` activates Computer for one request. Settings → Computer control is a separate opt-in for ordinary turns; an AppSnap attachment does not enable control.
- Shared setup guide for Accessibility, Input Monitoring and Screen Recording, with fresh permission checks, exact-app identity checks and stale-grant recovery guidance. Permission setup leaves the task unsent until the user sends it.
- Background-first native work and isolated headless browser profiles. Bringing an app visibly forward requires explicit user intent; using the same browser executable does not import personal cookies or profile data.
- Task-owned, draggable preview of the addressed window or browser tab, compact/expanded sizing, bounded still fallback and last-frame retention through short gaps. Closing the preview hides it; chat Stop ends the task. Preview frames are local UI feedback, separate from model screenshots.
- Human-readable Computer action chips/cards, scoped task approvals, protected security surfaces, bounded action audit records, fresh-observation checks and physical Escape interruption when Input Monitoring is granted. Escape interrupts current input without disabling future tasks.
- Batches of up to 25 known native steps and on-demand help keep routine workflows compact. Native task targeting permits independent app/window work where the backend can prove isolation; input transactions remain serialized.
- External MCP integrations can request Computer-enabled tasks with the explicit `computer:control` scope; task approval still applies.
- Computer integration across the provider adapters, with explicit readiness checks and task-scoped connections. This is not a claim of live certification of every provider/model/app combination. Linux groundwork and experiments are not advertised as released Linux Computer support.

#### Projects, models and provider features

- Discover and import local Codex and Claude Code projects and conversations: source picker, search, automatic initial selection, archived-session option, per-project destination, progress, stop and retry. Landing-page and first-run entry points make imports discoverable. (#1259, #1271)
- Import frozen provider-session copies while preserving original histories, completed legacy turns and source identity. Relocate missing/moved project folders without losing task context or rewriting the source session. (#1266; 948b3d136)
- Tabbed model picker with starred model-and-effort presets; refreshed Codex model discovery and normalized provider-supported options. (#1252, #1256)
- Claude prompt-cache observations in the UI and local transcript diagnostics: reads, creation, uncached input and persisted evidence, without inventing missing usage or guaranteeing future cache hits. (#1240, #1241)
- Durable review before expensive Claude cache resumptions: continue with full context, compact then send, or cancel. Native compaction completes before releasing the held message; progress and failures remain visible. (#1242, #1243, #1244)
- Optional Claude Artifacts, `/design` and `/slides`, with account/version readiness explanations. Enable in Claude provider settings and start a new session. (#1271)
- Non-blocking Codex question cards, plus cancellation for blocking multiple-choice questions. (#1213, #1285)
- Banked Codex reset display and confirm-gated redemption, with fresh account/usage checks and idempotent retries for uncertain outcomes. (#1246)
- Chat drag-and-drop for composer mentions and pane splits. (#1255)
- Passive completion delivery for eligible Agent Gateway delegated runs, tied to the originating request and durable settled output. (#1276)
- GitHub-style Markdown alerts in chat. (#1273)

### Changed

- Claude context-budget changes safely respect the active session and report the actual runtime budget. (#1260)
- Activity lists follow the latest human message, rather than being reordered by background assistant work. (#1261)
- PR controls expose status-specific actions and pending toasts; PR links appear in chat hover cards. Cached GitHub lookups and reduced badge polling cut repeated requests. (#1257, #1262; 35fe7e31d, b99c9e4c4)
- Tool activity collapses into one live accordion line, keeping the latest human-readable status visible and removing redundant settled PR status rows. (#1274; b58f27381, d715a9164)
- Markdown files default to Preview in the editor. Command palette and recent-view switcher match the file-picker presentation. (#1218, #1248)
- Shared UI font tokens extend user-selected typography across more surfaces; effort controls stay stable during adjustments, import glyph transparency is retained, and browser sizing/composer spacing are refined. (948875954, 3f11b1124, d684f2de4, 33333439c)
- Liquid Glass Mac app icons, updated alternate icons, persistent icon selection and a redesigned Dmgly installer. Default removes custom-icon metadata; pristine release signature verification remains distinct from a customized installed app. (#1247; 6db82819b, e7cd15281)
- Provider settings show setup health and clarify theme activation. Shortcut labels are human-readable, and the keyboard-reference defaults are corrected. (#1249, #1253, #1254)
- Production packaging prunes unused icons/assets and excludes unnecessary source material while retaining required resources and vendored licenses. No universal download-size percentage is claimed. (#1234)
- Hidden presentations avoid unnecessary ticks; streaming reveal avoids stalls; editor updates do less repeated work. Development skips React Compiler in the normal reload path. (#1258, #1208, #1225)
- CI setup/test lanes are streamlined and an Electron energy-proxy benchmark is available. The earlier #1197 optimization was reverted; benchmark infrastructure is not a battery-life claim. (#1202, #1263)
- Native-driver source/provenance and Rust toolchain are pinned in release builds; Canary bootstraps an isolated Rust toolchain and preserves the rustup installer filename. (0567d829c, 92ac55986, 8e873b0d7)
- Repository licensing is explicitly MIT. (9a0d71fe7)

### Fixed

- Editor rows redraw after repeated line insertion, subsequent typing, undo and redo. (#1208)
- Codex resumes without returning duplicate history; mixed MCP transports are configured correctly. (#1066, #1203)
- Stuck provider startup can be stopped and recovered; side chats retain runtime permission choices when created and sent. (#1230, #1205)
- OpenCode uses current server/model metadata; managed Computer sessions require their scoped tool connection to be ready. (#1228; fbb3a5881)
- BetterWright 2.7.3 browser lease migration and lifecycle behavior are completed. (#1233)
- Invalid process signals and captured process identities are guarded during cleanup. Source checks do not by themselves prove packaged Windows teardown. (#1270)
- Profiles include providers with real turns but no token telemetry, preserving unknown usage rather than inventing zero. (#1215)
- Unlinked commit authors remain visible in PR details; PR dedup separators are represented safely. (#1214, #1188)
- Linux desktop zoom shortcuts are handled in the main process. (#1229)
- AppSnap/toast development warnings and temporary-chat hover accent precedence are corrected. (#1226, #1190)
- Computer text is inserted atomically, falls back to the focused field when appropriate, and targets same-process windows more reliably. Background Enter can use the observed field reference. (#1286; 503b97108)
- Computer preview expansion actually enlarges the card; stale native observations, ambiguous focus, driver failures and interrupted input receive bounded recovery instead of silent action replay. (f26bed6ea, 71b29aeae, fbb3a5881)
- Computer permission refresh, driver provisioning, cancellation, ownership and task isolation are hardened. Session startup and teardown preserve failure visibility; no broad live-provider certification is inferred from unit tests. (#1090 and follow-up commits)

### Verification

- Node 24.13.1 and Bun 1.4.2: formatting, lint, typecheck, release smoke, production build, brand identity, Windows runtime-boundary and migration-lineage checks passed. Lint retains existing warnings; it reported no errors.
- Final uncached full suite after frozen-lockfile installation: **1,125 files and 14,686 tests passed; 12 files / 30 tests skipped**. Skipped live-provider and benchmark tests are not claimed as validated.
- The first full run failed `apps/desktop/src/computerShield.test.ts` → `ComputerShield > engages on first use and confirms before resolving`. Its isolated rerun passed. The fixture imposed 400 ms on real child startup; successful/refusal cases now use the existing 5-second production limit, while the deliberate wedged-helper case keeps its short timeout. All 10 shield tests and the final full suite passed; production behavior was not relaxed.
- A subsequent full run exposed eight `apps/server/src/platform/effectProcessSignals.test.ts` cases named `never turns invalid child PID %s into a group signal` (undefined, 0, 1, -1, 1.5, NaN, Infinity and 4294967297). The local dependency installation lacked the already-committed Effect patch. `bun install --frozen-lockfile` refreshed that one package; all 10 process-signal tests and the final full suite passed. No runtime source patch was added for this installation issue.
- Initial release smoke was blocked by sandbox temp-directory access (`EPERM`); it passed with the required access. The initial build was stopped to use pinned Node. These preliminary attempts are not counted as passing checks.
- Both documentation trees passed their 57-test documentation contract/integrity suites. The paired website passed lint and production build. Release copy is identical across the in-app entry and both marketing changelogs; no external documentation links were added or changed.
- The first native release attempt failed macOS icon staging: the macOS 14 runner's older `actool` returned success without creating `Assets.car`. A second attempt exposed an Apple AssetRuntime framework crash when Xcode 26.3 compiled icons on macOS 15. Release CI now compiles the shared icon catalog on macOS 26 with Xcode 26.3 and keeps native code on macOS 15 with Xcode 16.4. The catalog remains required; no icon fallback or signing gate was weakened.
- The first Linux artifact attempt failed because `x11.pc` was unavailable while compiling the bundled driver. Release setup now installs the same native development-library prerequisites as the dedicated Linux Cua check. Linux Computer Use remains outside the 0.9.0 support announcement.
- Packaging follow-ups passed formatting, lint, typecheck, release smoke and all 231 release-script tests. A real local Icon Composer compile with Xcode 27 produced `Assets.car`; the separate Xcode 26.3/macOS 26 CI job remains the artifact qualification gate.
- Native packaging, macOS signing/notarization, unsigned Windows startup/provenance checks and public asset publication are enforced by the tag workflow. Local source checks do not certify current packaged Computer behavior across every provider, application, display or Space. Computer remains a macOS beta; Linux Computer support is coming soon.

### Merge and direct-commit audit

Audited all 450 commits in the complete `v0.8.4..f3cffcb66` ancestry, including merged branch commits and direct pushes. **51 merged pull requests** have merge commits in this range. #1197 is included in that historical count but was reverted. Intermediate Computer recording/replay and durable always-allow grants were removed before this release and are not shipped features.

- [#1066](https://github.com/Emanuele-web04/synara/pull/1066) — fix(codex): avoid returning history on resume
- [#1090](https://github.com/Emanuele-web04/synara/pull/1090) — Add scoped Computer Use with background browser control and native macOS support
- [#1188](https://github.com/Emanuele-web04/synara/pull/1188) — fix(web): spell pull-request dedup separators as \^@ escapes
- [#1190](https://github.com/Emanuele-web04/synara/pull/1190) — Keep temporary chat accent visible while hovered
- [#1197](https://github.com/Emanuele-web04/synara/pull/1197) — Optimize cross-platform CI setup and cut the measured critical path (reverted)
- [#1202](https://github.com/Emanuele-web04/synara/pull/1202) — Reduce CI setup work and shorten test lanes
- [#1203](https://github.com/Emanuele-web04/synara/pull/1203) — Repair mixed Codex MCP transport configuration
- [#1205](https://github.com/Emanuele-web04/synara/pull/1205) — Preserve runtime permissions for sidechats
- [#1208](https://github.com/Emanuele-web04/synara/pull/1208) — Fix Pierre editor row rendering after line insertion
- [#1213](https://github.com/Emanuele-web04/synara/pull/1213) — feat(codex): support non-blocking user question cards
- [#1214](https://github.com/Emanuele-web04/synara/pull/1214) — fix(github): preserve unlinked commit authors in PR details (repair for #1067)
- [#1215](https://github.com/Emanuele-web04/synara/pull/1215) — fix(profile): surface providers with turns but no token telemetry (repair for #1075)
- [#1218](https://github.com/Emanuele-web04/synara/pull/1218) — feat(web): default editor markdown to Preview
- [#1225](https://github.com/Emanuele-web04/synara/pull/1225) — fix(web): remove React Compiler delay from development loading and reloads
- [#1226](https://github.com/Emanuele-web04/synara/pull/1226) — fix(web): clean up AppSnap and toast development warnings
- [#1227](https://github.com/Emanuele-web04/synara/pull/1227) — Ambient in-chat computer preview plus foreground focus restore
- [#1228](https://github.com/Emanuele-web04/synara/pull/1228) — fix(opencode): support current server and model metadata
- [#1229](https://github.com/Emanuele-web04/synara/pull/1229) — fix(desktop): handle Linux zoom shortcuts in the main process
- [#1230](https://github.com/Emanuele-web04/synara/pull/1230) — fix(session): recover stop for stuck provider starts
- [#1233](https://github.com/Emanuele-web04/synara/pull/1233) — fix(browser): complete BetterWright 2.7.3 lease migration and regression coverage
- [#1234](https://github.com/Emanuele-web04/synara/pull/1234) — perf: reduce shipped desktop size without runtime or visual changes
- [#1239](https://github.com/Emanuele-web04/synara/pull/1239) — test(web): allow cold imports to finish
- [#1240](https://github.com/Emanuele-web04/synara/pull/1240) — feat(diagnostics): report Claude cache usage from local transcripts
- [#1241](https://github.com/Emanuele-web04/synara/pull/1241) — Preserve and display native Claude prompt-cache observations
- [#1242](https://github.com/Emanuele-web04/synara/pull/1242) — Persist pending Claude cache-resume reviews
- [#1243](https://github.com/Emanuele-web04/synara/pull/1243) — Confirm expensive Claude cache resumptions before dispatch
- [#1244](https://github.com/Emanuele-web04/synara/pull/1244) — Compact Claude context natively before releasing held messages
- [#1246](https://github.com/Emanuele-web04/synara/pull/1246) — feat: show and consume Codex banked resets
- [#1247](https://github.com/Emanuele-web04/synara/pull/1247) — [codex] Apply Dmgly design to macOS installer
- [#1248](https://github.com/Emanuele-web04/synara/pull/1248) — Restyle the command palette and recent-view switcher to match ⌘P
- [#1249](https://github.com/Emanuele-web04/synara/pull/1249) — fix(settings): show provider setup health and clarify theme activation
- [#1252](https://github.com/Emanuele-web04/synara/pull/1252) — feat(composer): tabbed model picker with starred model + effort presets
- [#1253](https://github.com/Emanuele-web04/synara/pull/1253) — docs(shortcuts): list missing defaults and correct workspace tab combo
- [#1254](https://github.com/Emanuele-web04/synara/pull/1254) — fix(web): show friendly labels for terminal and usage keybindings
- [#1255](https://github.com/Emanuele-web04/synara/pull/1255) — Support chat drag-and-drop mentions and pane splits
- [#1256](https://github.com/Emanuele-web04/synara/pull/1256) — Refresh Codex model discovery and preserve starred preset behavior
- [#1257](https://github.com/Emanuele-web04/synara/pull/1257) — Enrich pull request controls with status actions
- [#1258](https://github.com/Emanuele-web04/synara/pull/1258) — perf(web): eliminate stalled reveal frames and hidden presentation ticks
- [#1259](https://github.com/Emanuele-web04/synara/pull/1259) — Add Codex and Claude project import flow
- [#1260](https://github.com/Emanuele-web04/synara/pull/1260) — fix(claude): safely apply context budget changes and show runtime budget
- [#1261](https://github.com/Emanuele-web04/synara/pull/1261) — Order activity by the latest human message
- [#1262](https://github.com/Emanuele-web04/synara/pull/1262) — Show pull request links in chat hover cards
- [#1263](https://github.com/Emanuele-web04/synara/pull/1263) — bench: cloud Electron energy proxy
- [#1266](https://github.com/Emanuele-web04/synara/pull/1266) — fix: relocate imported projects without losing thread context
- [#1270](https://github.com/Emanuele-web04/synara/pull/1270) — fix(process): guard invalid signals and captured process identities
- [#1271](https://github.com/Emanuele-web04/synara/pull/1271) — Add Claude Artifacts support and project import onboarding
- [#1273](https://github.com/Emanuele-web04/synara/pull/1273) — Render GitHub-style alerts in chat markdown
- [#1274](https://github.com/Emanuele-web04/synara/pull/1274) — Fold the live tool run into one accordion line
- [#1276](https://github.com/Emanuele-web04/synara/pull/1276) — feat: passively return delegated gateway task results
- [#1285](https://github.com/Emanuele-web04/synara/pull/1285) — fix: allow cancelling blocking questions with choices
- [#1286](https://github.com/Emanuele-web04/synara/pull/1286) — Improve computer typing and same-process window targeting

[Complete commit comparison](https://github.com/Emanuele-web04/synara/compare/v0.8.4...v0.9.0) includes direct pushes, follow-up repairs, native-driver iterations and test/documentation changes.

## 0.8.4 - 2026-09-14

108 development commits since v0.8.3, plus release preparation and validation fixes, bring a new browser automation foundation, saved browser sessions, guided setup, workspace editing and autosave, richer Git review, selected-context conversations, provider recovery, and measured reductions in CPU work, temporary memory and streaming write amplification. This inventory describes the final shipped behavior, consolidating intermediate visual revisions.

### Added

#### Workspace editing, diffs and documents

- Edit workspace text files directly from Explorer and the full editor; edit the working side directly from supported Git diff views. The editors use the same Pierre/Shiki stack as Synara's diff rendering, including app fonts, theme and syntax highlighting. Explorer uses a numbered plain-text fallback for larger files; the full file and diff editors continue to use Pierre. ([#561](https://github.com/Emanuele-web04/synara/pull/561), [#1123](https://github.com/Emanuele-web04/synara/pull/1123))
- Undo, redo and undoable revert-all header controls, an immediate Save action and configurable Cmd/Ctrl+S binding. ([#561](https://github.com/Emanuele-web04/synara/pull/561))
- Shared file drafts and writer across Explorer, file editor and diff editor. Autosave follows a 400 ms typing pause; switching files/pages and sending prompts wait for pending writes. Successful edits refresh Unstaged changes without staging files. ([#1186](https://github.com/Emanuele-web04/synara/pull/1186))
- Conflict-aware saves preserve original encoding and line endings; failed/conflicting saves retain the draft, expose errors, stop automatic retries and offer explicit recovery. In-flight saves finish before leaving; new typing during a disk reload is protected. Reload/discard and explicit full-editor Overwrite are distinct recovery choices. ([#561](https://github.com/Emanuele-web04/synara/pull/561), [#1186](https://github.com/Emanuele-web04/synara/pull/1186))
- Compare the working tree against another branch or commit, with compare scopes remembered per repository and correct branch merge-base or index comparison where appropriate. ([#561](https://github.com/Emanuele-web04/synara/pull/561))
- Click supported diff lines to view Git blame; new/untracked files and empty repositories receive uncommitted attribution. Deleted lines are attributed against the displayed base, including old rename paths. Blame is intentionally scoped away from staged/unstaged and turn diff line numbering. ([#561](https://github.com/Emanuele-web04/synara/pull/561))
- Navigate changed files with next/previous actions, scrollbar change markers and Alt+Up/Down shortcuts; file-tree and jump-menu selection follow the visible file as you scroll. ([#561](https://github.com/Emanuele-web04/synara/pull/561))
- Word-level highlighting within modified lines and change gutters in file previews. ([#561](https://github.com/Emanuele-web04/synara/pull/561))
- File and document preview panes can maximize across the chat area and restore their split layout; closing the last maximized pane returns to chat. ([#1023](https://github.com/Emanuele-web04/synara/pull/1023))
- Basic workspace Wiki links in Markdown: `[[notes/design]]`, `[[notes/design|Design notes]]`, and explicitly extended file links such as `[[guide.pdf]]`. Wiki paths start at the workspace root; normal Markdown links remain relative to their document. ([#1023](https://github.com/Emanuele-web04/synara/pull/1023))

#### Browser sessions and application capture

- Replace the former desktop browser automation implementation with BetterWright; agents retain navigation, snapshots, screenshots, scripting and related browser actions through Synara's browser tools. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Import existing site login cookies into the current embedded browser site and restore eligible imported sessions across restarts using protected local storage. Current-site import is scoped to the visible destination and guarded against navigation during the operation. All sites in this profile is also available with an explicit consent checkbox. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Browser cookies and sign-ins are shared across tasks. Saved Logins interface with save/update prompts, optional autosaving of accepted logins, account list, deletion, lock/unlock and password reveal protected by a master password. Agent access is optional account metadata discovery only. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Popups open as tabs inside Synara, supporting in-app sign-in flows without losing the browser context. Popup navigation and downloads retain their existing guards. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Floating browser previews expand into the interactive browser panel. Collapsed previews are deliberately noninteractive; automation still operates against its own target and hidden browser execution remains responsive. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Refreshed Safari import setup with app icon, Finder flow and macOS Full Disk Access explanation, preserving previous onboarding choices and providing a way to reopen setup. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114), commit 3b16d6d00)
- AppSnap window picker: attach a chosen open application window, with app icons/titles, capture readiness, bounded retries and target validation. ([#1141](https://github.com/Emanuele-web04/synara/pull/1141))
- Composer + menu can capture the frontmost application document window in one click; a trailing arrow/ArrowRight opens the full window list. It prefers a titled document over an untitled auxiliary window from the same app. ([#1177](https://github.com/Emanuele-web04/synara/pull/1177))

#### Onboarding, composer and selected context

- Interactive first-run setup covering provider discovery/enablement and sign-in terminal, appearance/theme selection, feature tour and project creation. Project setup accepts dropped folders. ([#1031](https://github.com/Emanuele-web04/synara/pull/1031))
- Replay setup from Settings; completion is installation-specific, persisted locally first and reconciled to the server. Existing installs do not unexpectedly reopen onboarding after removing their final project or restoring defaults. ([#1031](https://github.com/Emanuele-web04/synara/pull/1031))
- Assistant selection toolbar provides Add to Chat, Add to Side and Add to new Chat. A shared mini composer creates a new task with selected context, with queued-send failures retained for recovery and retry bounds. ([#1130](https://github.com/Emanuele-web04/synara/pull/1130))
- Side chats can select provider/model before their first real turn even when they contain imported fork history; `/side <provider>` works with the provider argument still present in the composer. ([#1055](https://github.com/Emanuele-web04/synara/pull/1055))
- Model effort uses a stepped slider by default, with supported effort levels, Fast toggle and reset. A composer setting controls the new layout. Magnetic snapping, drag cursor feedback, corrected minimum fill and a flush thumb make the interaction clearer. ([#1120](https://github.com/Emanuele-web04/synara/pull/1120), 3b16d6d00, abb797240, a311a844a)
- Model selection closes the nested model menu but leaves the effort slider open for the next adjustment. (31ed6b9ae)
- Composer + menu becomes a shared flat command panel above the composer, with file attachments, AppSnap, Goal insertion and toggleable Plan, Debug and supported Fast modes. Literal goal text is preserved. ([#1146](https://github.com/Emanuele-web04/synara/pull/1146), [#1177](https://github.com/Emanuele-web04/synara/pull/1177))
- Agent-authored standalone and dedicated automations can specify exact provider/model/options, validated against executable provider availability and the target workspace. They may be created disabled for staged review. Lists and create responses expose the chosen model; updates preserve omitted selections. ([#1167](https://github.com/Emanuele-web04/synara/pull/1167))

### Changed

#### Pull requests and project organization

- Pull request context cards can be added to a draft from PR Repair/Add to Chat actions and expanded in sent user messages. Context survives drafts, queues, sends and retries. ([#1071](https://github.com/Emanuele-web04/synara/pull/1071))
- Thread pull request chips open the right-hand dock; modifier-click retains navigation to GitHub. (2e98e50b5)
- Merge actions remain disabled until capabilities/details load and are rechecked at confirmation. PR popup submenu placement and trailing-value alignment are corrected. ([#1071](https://github.com/Emanuele-web04/synara/pull/1071))
- Environment PR status updates immediately after a successful action; late/in-flight fetches cannot roll back the confirmed result. ([#1126](https://github.com/Emanuele-web04/synara/pull/1126))
- Merged and closed PR status remains visible for the branch in Environment. ([#1103](https://github.com/Emanuele-web04/synara/pull/1103))
- Each project remembers its Local or Worktree choice for subsequent new chats. ([#1105](https://github.com/Emanuele-web04/synara/pull/1105))
- Configured project display names remain visible in narrow sidebar rows; the redundant muted folder suffix was removed. ([#1086](https://github.com/Emanuele-web04/synara/pull/1086), fixes [#1000](https://github.com/Emanuele-web04/synara/issues/1000))
- Project/environment/branch pickers share compact menu styling, width behavior and typography. Environment menu is labeled Work in; landing composer tray spans the composer without background tint. ([#1108](https://github.com/Emanuele-web04/synara/pull/1108) plus 03368a072, 7aa0ecb1a)
- Sidebar PR badges become consistent square icon controls, retaining PR numbers in accessible labels. (348a1dfb9)

#### Visual polish

- Refined sidebar glass/translucency, background blur, selected-row colors and neutral surface washes in light and dark themes. Final selected rows reuse the secondary/user-message surface. ([#1089](https://github.com/Emanuele-web04/synara/pull/1089) plus 690a9ac4e, a08a0c854, d8bbe9086, 77a09d6f7, c6328f62f, f4d1ee81f, 4a62652ee, 71862f9b2)
- Refined user message bubble corner smoothing, seam contrast, compact final spacing and notification surfaces. (4362f6ea4, 49d24f4c0, 3b18b8fa3, e307d251d, b335765c4)
- Raised-surface borders are softer. (79bd48963)
- Picker controls, autocomplete labels and branch-create actions follow configured UI font size/family. (cfa32ece5)
- Toast actions use consistent font-matched ghost buttons. ([#1176](https://github.com/Emanuele-web04/synara/pull/1176))
- Native context menus render properly sized rasterized icons on macOS; icon metadata survives IPC and web fallback rendering. ([#1183](https://github.com/Emanuele-web04/synara/pull/1183))
- Compact text-selection controls and mini composer, with action labels no longer clipped at supported font sizes. (abb797240, ac68cd0f5)
- Shared PanelLeft sidebar trigger icon. (6ae3a6937)

#### Providers, accounting and process lifetime

- GPT-6 Astra is added and becomes the default Codex model, with Low, Medium(default), High, Extra High, Max and Ultra effort options; `astra`, `6`, `gpt-6` aliases resolve to it. (5a25d5c81)
- Model display names normalize consistently across providers without changing executable model IDs: canonical brand casing/version punctuation and provider-discovered labels are retained. Devin alias discovery keeps SWE-1.6 Fast distinct. ([#1016](https://github.com/Emanuele-web04/synara/pull/1016), [#1139](https://github.com/Emanuele-web04/synara/pull/1139))
- Codex Fast mode can be reset correctly and selected skill input is no longer duplicated. ([#1125](https://github.com/Emanuele-web04/synara/pull/1125))
- Codex startup can be retried after a confirmed failed process teardown; uncertain native liveness is not falsely certified as clean. ([#1074](https://github.com/Emanuele-web04/synara/pull/1074))
- Codex uses a single actual SQLite home rather than symlinking databases/WAL sidecars through the overlay, preventing divergent WAL paths and resume database corruption, particularly on Windows. Old overlay symlinks are cleaned while regular files and explicit CODEX_SQLITE_HOME overrides are preserved. ([#1062](https://github.com/Emanuele-web04/synara/pull/1062))
- Claude pending questions recover after server restarts and expired sessions, including duplicate submission handling. ([#1113](https://github.com/Emanuele-web04/synara/pull/1113))
- Claude request tokens count once per response rather than once per repeated SDK content block; per-result model totals distinguish cumulative usage, caches and subagents. Context usage, processed totals and Profile Stats have distinct, corrected scopes. ([#1127](https://github.com/Emanuele-web04/synara/pull/1127))
- Verified Claude usage is versioned; Profile Stats excludes unverifiable historical totals and explains that old history can be incomplete. Retained legacy main-loop evidence is preserved by migration, but purged totals are not invented or retroactively halved. ([#1127](https://github.com/Emanuele-web04/synara/pull/1127))
- Claude overage telemetry is mapped to the Fable weekly sublimit. ([#1104](https://github.com/Emanuele-web04/synara/pull/1104))
- Per-turn provider usage/cache baselines survive session changes correctly; successful native fork resumes avoid redundantly prepending transcript recaps. Antigravity usage projection remains deferred where unverifiable. ([#1024](https://github.com/Emanuele-web04/synara/pull/1024))
- Cursor ACP Task calls appear as active subagent work with description/prompt, and quiet subagents remain Working rather than falsely Idle. ([#1119](https://github.com/Emanuele-web04/synara/pull/1119))
- Pi mid-turn sends queue as follow-ups instead of raw Agent is already processing errors. Dispatch is serialized per task; cancellation during prompt preflight is retained and dispatched/stopping/aborted races settle correctly. ([#1135](https://github.com/Emanuele-web04/synara/pull/1135))
- Pi transient auto-retry errors display inline warnings, retaining the active turn and autonomous goal; End task cancels retry backoff instead of freezing. ([#1061](https://github.com/Emanuele-web04/synara/pull/1061))
- Pi extension terminal status is excluded from the tool timeline while meaningful notifications and plain text remain. ([#1093](https://github.com/Emanuele-web04/synara/pull/1093))
- Antigravity final print output/completion and terminal outcomes are preserved and duplicate tool events reconciled, including recovered first turns. ([#1021](https://github.com/Emanuele-web04/synara/pull/1021))
- Antigravity transcript-discovered background commands stay alive after the model's Stop hook; completion/kill, delayed hooks, anonymous and qualified IDs, concurrent commands and turn changes are reconciled without resurrecting settled work. ([#1170](https://github.com/Emanuele-web04/synara/pull/1170))
- OpenCode pools normalize executable/workspace identity without destroying parent-directory traversal semantics. ([#1169](https://github.com/Emanuele-web04/synara/pull/1169))
- Desktop backend lifetime follows the owning Electron parent through stdin EOF, invokes normal cleanup on parent loss and terminates only the backend if cleanup hangs; CLI stdin behavior is preserved. ([#1154](https://github.com/Emanuele-web04/synara/pull/1154))
- Provider teardown and callback ownership are tightened: failed idle teardown can retry; Claude keeps ownership during failed installation; ACP callback buffers are bounded; copied snapshots avoid mutation leaks; OpenCode/Pi drop redundant retained state; dock/terminal runtimes dispose with their hosts. ([#1097](https://github.com/Emanuele-web04/synara/pull/1097))
- Orchestration command dispatch stays responsive when subscribers are slow. ([#1115](https://github.com/Emanuele-web04/synara/pull/1115))

### Fixed

#### Transcript, turn ordering and recovery

- Preserve embedded NUL characters and the following Unicode text through completion, segments, restart and resume on Node 24 SQLite. The full release suite exposed this truncation; the existing JSON fallback now covers NULs as well as unmatched surrogate code units.
- Invisible Codex provider events no longer split adjacent Markdown text into broken chunks; saved adjacent segments coalesce while real work/turn boundaries remain intact. ([#1155](https://github.com/Emanuele-web04/synara/pull/1155))
- Tool calls remain visible and correctly attached after steering. Effective native versus emulated-steer boundaries persist across reloads; providers without native steering create their separate queued turn correctly. ([#1124](https://github.com/Emanuele-web04/synara/pull/1124))
- Tool/work activity ordering remains stable between live events and snapshots, including late background updates retaining their original chronological position instead of moving underneath later user prompts. ([#1019](https://github.com/Emanuele-web04/synara/pull/1019) and [#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Real message changes and geometry changes are separated in tail anchoring so tool-only work does not prolong live-output follow/quiet holds. Streaming preserves partially visible rows and deferred layout settles correctly. ([#1077](https://github.com/Emanuele-web04/synara/pull/1077), [#1064](https://github.com/Emanuele-web04/synara/pull/1064), [#1155](https://github.com/Emanuele-web04/synara/pull/1155))
- Context compaction appears as a transcript progress row with an icon. ([#1129](https://github.com/Emanuele-web04/synara/pull/1129))
- Session restart/context-loss rail markers use plain language and explain when interruption escalation caused a restart; recovery acceptance preserves the relevant cause until the provider accepts it. ([#1058](https://github.com/Emanuele-web04/synara/pull/1058))
- First task startup no longer flickers while the initial turn/session is being established. ([#1084](https://github.com/Emanuele-web04/synara/pull/1084))
- Bracketed display math, numeric inline formulas and literal dollar signs before Markdown links render correctly. ([#1020](https://github.com/Emanuele-web04/synara/pull/1020))
- Inspected input images are no longer mislabeled as newly generated outputs. ([#1100](https://github.com/Emanuele-web04/synara/pull/1100))
- Existing simulator screenshot previews outside standard allowed roots can recover via authenticated per-file grants; expansion/download renews grants and transient transports can retry without background polling. ([#1153](https://github.com/Emanuele-web04/synara/pull/1153))
- Simulator attachment keeps the canvas mounted for the first frame, preventing an idle screen from leaving the pane stuck Connecting; UDID device identity and decoder error reporting are preserved. ([#1164](https://github.com/Emanuele-web04/synara/pull/1164))
- Windows directory links, including workspace paths in Markdown, navigate through Explorer correctly. ([#1085](https://github.com/Emanuele-web04/synara/pull/1085))
- Malformed percent encoding in pasted theme share strings reports the normal readable validation error instead of a raw URIError. ([#1168](https://github.com/Emanuele-web04/synara/pull/1168))
- Duplicate/racing approval responses reconcile without stale undo callbacks or orphaned interaction handlers. ([#1102](https://github.com/Emanuele-web04/synara/pull/1102))
- Runtime journal acknowledgement retries do not duplicate buffered assistant output; cached completion text survives missing projected detail. ([#1097](https://github.com/Emanuele-web04/synara/pull/1097)/[#1098](https://github.com/Emanuele-web04/synara/pull/1098) and 95b3101c2, 12706a9aa)

#### Browser automation integration

- Empty browser vaults and session stores defer OS key creation until first use, avoiding unnecessary Keychain access during first launch. Existing encrypted data keeps its established decryption path; password-save consent and encryption remain required.
- Browser target input stays out of the chat composer, restoring prior focus without overriding subsequent human focus changes; concurrent targets and cancellation are isolated. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Hidden browser captures and Retina/zoom screenshot dimensions/input are corrected. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Clipboard copy preserves user operations, native keyboard safety policies cover additional aliases/accelerators, and workspace upload staging cleans up failed uploads. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Navigation waits follow client redirects; empty results and sign-in failures produce clearer feedback. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Browser runtimes survive panel mounting, recover stale CDP sessions only after confirmed teardown, and release canceled/failed target setup. Webview remount crashes and ASAR executable-resolution races are fixed. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))
- Agents receive screenshot-proof and on-demand browser E2E review guidance. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114))

#### Live diffs and large repositories

- Mounted Git views and blame/gutters refresh after editor saves, external watched file changes, Git operations and branch movement. ([#561](https://github.com/Emanuele-web04/synara/pull/561), [#1175](https://github.com/Emanuele-web04/synara/pull/1175))
- Oversized aggregate/untracked Git patches return bounded partial output and explicit truncation metadata rather than failing the entire Review panel at the size cap; partial-patch consumers handle incomplete content safely. ([#1138](https://github.com/Emanuele-web04/synara/pull/1138))
- Rename, binary, symlink, submodule, SHA-256 repository, empty repository and compare-ref added/untracked edge cases are corrected. Unsafe editor actions are hidden and unsupported file formats remain read-only. ([#561](https://github.com/Emanuele-web04/synara/pull/561))
- Compare refs use a temporary index to correctly represent recreated files and force-added ignored files against the chosen reference; unresolved revisions fail visibly rather than opening a false empty base. ([#561](https://github.com/Emanuele-web04/synara/pull/561))

### Removed and data migrations

- Saved transcript highlights and underlines are removed, including marker UI and obsolete docs. Migration 101 removes stored marker payloads and the projection marker column while preserving event IDs, sequence/replay continuity and timestamps. Stored highlight and underline data is deleted; message history, pins and notes remain. ([#1131](https://github.com/Emanuele-web04/synara/pull/1131))
- Migration 100 adds append-only streamed-text chunks while preserving existing history/cursors, without a completed-history backfill. ([#1097](https://github.com/Emanuele-web04/synara/pull/1097))
- Migration 102 stores effective user-message turn boundaries for stable steering replay. ([#1124](https://github.com/Emanuele-web04/synara/pull/1124))
- Migration 103 adds versioned Claude deleted-token snapshots and retained legacy main-loop evidence, leaving immutable history unchanged and acknowledging unrecoverable gaps. ([#1127](https://github.com/Emanuele-web04/synara/pull/1127))
- The old browser-automation implementation is replaced by BetterWright; the final workspace editor uses Pierre and the Explorer plain-text fallback. ([#1114](https://github.com/Emanuele-web04/synara/pull/1114), [#561](https://github.com/Emanuele-web04/synara/pull/561))

### Development and verification infrastructure

- CI test parallelism/partitioning, browser hydration pre-transform and Windows dependency restoration improve reliability/critical path. ([#1140](https://github.com/Emanuele-web04/synara/pull/1140))
- React ChatView structure and storage schema machinery are consolidated; structural refactoring is a maintainability improvement. ([#1144](https://github.com/Emanuele-web04/synara/pull/1144))
- Performance runner closes Electron when firstWindow fails. ([#1078](https://github.com/Emanuele-web04/synara/pull/1078))
- Typecheck benchmark docs now qualify contracts/shared full-check methodology. ([#1008](https://github.com/Emanuele-web04/synara/pull/1008))
- Docs-only CI classification excludes all .github images. ([#1014](https://github.com/Emanuele-web04/synara/pull/1014))
- Shared AGENTS/CLAUDE instructions refreshed; real-provider E2E guidance, isolated port/auth preflight clarified. ([#1171](https://github.com/Emanuele-web04/synara/pull/1171), f668f5be2)
- Stray Devin wedge investigation report removed; personal asset context document added. These are repository maintenance changes. ([#1149](https://github.com/Emanuele-web04/synara/pull/1149), 5e65a8871)

### Measured performance

These are recorded local before/after experiments for changes included in this release, **not a newly run v0.8.3-versus-v0.8.4 whole-app benchmark**. CPU, query-worker RSS, retained heap, SQLite WAL volume and browser route timings measure different things and must not be combined into one app-wide saving. No hardware GPU utilization or battery-energy reduction is established.

#### Status animations: CPU and GPU-process CPU

Three alternating paired samples on an Apple M5 Pro with 48 GiB RAM, macOS 26.5.1 and Electron 43.4.1. Each sample warms for two seconds, then measures eight seconds in an isolated Electron fixture using the production stylesheet, two status animations, macOS vibrancy and a blurred composer. It excludes React, the backend and real providers.

| Metric                                     |  Before |   After |              Reduction |
| ------------------------------------------ | ------: | ------: | ---------------------: |
| All Electron process CPU time              | 1.489 s | 0.956 s |                  35.8% |
| GPU-process CPU time                       | 0.894 s | 0.487 s |                  45.5% |
| Renderer CPU time                          | 0.577 s | 0.448 s |                  22.2% |
| All-process CPU utilization, 100% per core |  18.60% |  11.95% | 6.66 percentage points |

The spinner and shimmer share a 50 ms cadence and timeline origin, without adding a per-frame JavaScript timer. Their cycle lengths remain 1.3 and 2 seconds; shimmer steps decrease from 60 to 40, a modest smoothness tradeoff. Reduced Motion remains readable. GPU-process CPU is CPU used by Chromium's graphics helper, not GPU hardware utilization. No RAM saving was established by this experiment. [Report and raw samples](docs/performance/2026-09-07-status-animations/report.md).

#### History-query RAM and latency

Synthetic history with 6,000 messages and 6,000 tool activities, each with a 16 KiB body. Fresh Node/SQLite workers on the same M5 Pro/48 GiB host use a 128 MiB SQLite cache and 512 MiB mmap; three samples per query and version, one warmup and one measured read. Queries select retained identities before loading large bodies. Returned counts and digests match.

| Query                    | Worker peak RSS before → after | RSS reduction | Median query time before → after |
| ------------------------ | -----------------------------: | ------------: | -------------------------------: |
| Bulk messages            |            565.61 → 377.48 MiB |         33.3% |                 43.66 → 20.44 ms |
| Single-thread messages   |            565.83 → 377.22 MiB |         33.3% |                 46.25 → 21.17 ms |
| Bulk activities          |            255.92 → 115.16 MiB |         55.0% |                  19.15 → 7.21 ms |
| Single-thread activities |            379.66 → 275.58 MiB |         27.4% |                177.51 → 19.22 ms |

RSS includes the query worker and warmup; it is not the whole Synara footprint. Returned JavaScript heap is essentially unchanged. These short samples do not measure peak application RAM, crash frequency or leak freedom. [Historical report](https://github.com/Emanuele-web04/synara/blob/325779db29cad03a8da9e81f409fd211dc848357/docs/performance/2026-09-09-memory-crash/report.md), [baseline samples](https://github.com/Emanuele-web04/synara/blob/325779db29cad03a8da9e81f409fd211dc848357/docs/performance/2026-09-09-memory-crash/baseline.json), [optimized samples](https://github.com/Emanuele-web04/synara/blob/325779db29cad03a8da9e81f409fd211dc848357/docs/performance/2026-09-09-memory-crash/optimized.json).

#### Provider retained memory

- OpenCode comparison keys for 200 distinct 256 KiB outputs: **50.13 → 0.14 MiB**, removing **49.99 MiB** of duplicate heap; retained parts plus keys fall **100.19 → 50.20 MiB**. Three fresh-process forced-GC samples use the production hash helper. Creating keys takes **8.18 → 24.65 ms**, an explicit CPU-for-memory tradeoff.
- A separate 256-update cumulative-output fixture: **32.50 → 0.59 MiB** extra heap, retaining the latest part while dropping obsolete snapshots. This is a different mechanism and sample; do not add its saving to the preceding result.
- ACP callback buffers are bounded, Pi keeps current tool snapshots, failed startup retains process ownership, idle teardown retries, and host/dock terminals dispose their xterm runtimes. These fixes have correctness coverage but no universal MiB saving.

These experiments exclude complete SDK sessions, providers and Electron. A proposed history-eviction policy was rejected and is not part of this release. [Retention evidence](https://github.com/Emanuele-web04/synara/blob/325779db29cad03a8da9e81f409fd211dc848357/docs/performance/2026-09-09-memory-crash/implementation-2026-09-10.md).

#### Streaming persistence and write amplification

Production engine, Effect SQL and real migrations in fresh file databases and fresh processes; 40-byte ASCII deltas, WAL truncated after setup, auto-checkpoint disabled. Node 26.8.1 / SQLite 3.53.4 on the M5 Pro/48 GiB host. These are historical benchmark runtimes; release validation uses the repository-pinned Node version.

| Workload                                   | WAL before append-only chunks | WAL after chunks | Reduction |
| ------------------------------------------ | ----------------------------: | ---------------: | --------: |
| 8 KB answer, one sample                    |                     15.27 MiB |        14.90 MiB |     2.44% |
| 50 KB answer, one sample                   |                    155.01 MiB |        99.42 MiB |    35.86% |
| 200 KB answer, three samples               |                  1,346.27 MiB |       402.48 MiB |    70.10% |
| Four interleaved 50 KB answers, one sample |                    633.79 MiB |       420.95 MiB |    33.58% |

- In the paired 200 KB fixture, median streaming time improves **2,651.2 → 1,738.1 ms (34.44%)**. Completion changes **3.26 → 11.97 ms**, because durable text is assembled once at the end.
- A separate stacked follow-up reduces 200 KB engine WAL from **about 402 → 316.36 MiB**, and the 8 KB workload from **14.75 → 11.61 MiB**. Engine commits per delta fall from two to one; journal page acknowledgement amortizes another fixed cost when events queue.
- A 1,000-event journal fixture falls **26.3 → 21.9 KB/event** with 128-row pages; with no backlog it remains 26.3 KB/event. A notification-drain regression checks at most four cursor transactions for 32 queued notifications, previously 32.
- Engine WAL excludes the runtime journal and provider processes and does not equal physical SSD writes. The two stages are separate experiments, so their arithmetic is not presented as one paired 76% end-to-end gain. Small single-sample cases are directional. Engine sampled RSS/heap did not establish a RAM reduction.

[Append-only measurements](https://github.com/Emanuele-web04/synara/blob/325779db29cad03a8da9e81f409fd211dc848357/docs/performance/2026-09-09-memory-crash/implementation-2026-09-10.md), [raw summary](https://github.com/Emanuele-web04/synara/blob/325779db29cad03a8da9e81f409fd211dc848357/docs/performance/2026-09-09-memory-crash/implementation-summary.json), [write-floor follow-up](https://github.com/Emanuele-web04/synara/blob/93fb8975b0ec47f09f6f23ea8bc0b6c1af895e39/docs/performance/2026-09-09-memory-crash/write-floor-2026-09-10.md). The investigation documents were intentionally removed before merge; these links point to their immutable historical versions.

#### Warm chat opening and latest-turn lookup

| Warm route fixture            | Before median | After median | Reduction |
| ----------------------------- | ------------: | -----------: | --------: |
| 10 messages, 20 activities    |      570.5 ms |     374.5 ms |     34.4% |
| 81 messages, 1,609 activities |      595.3 ms |     326.3 ms |     45.2% |

Six samples per variant and fixture, alternating batches, warm modules and fresh router, real CSS, mocked RPC, Chromium development build on one unthrottled Mac. This measures storage-schema reuse inside the refactored route, including frame waits; it is not original-monolith-to-final, cold startup, model latency or a mounted-shell chat switch. Workflow timer ticks additionally cause zero parent transcript renders instead of ten over ten seconds. [Benchmark and tradeoffs](https://github.com/Emanuele-web04/synara/pull/1144).

A retained synthetic Node SQLite result for **600 chats / 300,000 historical turns** records latest-turn query medians **253.79 → 21.03 ms (91.7%)**, returning **300,000 → 600 rows**. The release archives the [original result](docs/performance/2026-09-14-release/latest-turn-query.json) with its [limited provenance](docs/performance/2026-09-14-release/README.md): hardware, repetition counts and dispersion were not retained, and this has not been rerun for the release. It is operation-level evidence, not whole startup.

#### CI and maintainability

- Local ChatView test critical path: **214.01 → 161.30 seconds (24.6%)** after separating the streaming matrix from the remaining cases; the complementary partition takes 96.22 seconds. Server files also split into two serial shards, and a redundant frontend build prerequisite is removed.
- Total workflow jobs fall **17 → 16** by grouping small suites while retaining aggregate gates, independent desktop build, all test coverage and serial execution within each shard. Windows uses the Bun cache and a fresh frozen installation rather than reusing a broken installed tree.
- A **26–35% hosted-CI reduction remains a projection**, not a measured release claim. [CI methodology](docs/ci-performance.md).
- ChatView shrinks **12,932 → 5,868 lines**, with responsibilities extracted into focused modules. This is maintainability work; extraction alone does not prove better performance, and bundle-size warnings remain.
- Native TypeScript speedups already shipped before v0.8.3. This release only clarifies that contracts/shared perform full checks in the earlier cold/incremental comparison; those compiler gains are not counted again.

### Compatibility and scope

- AppSnap window picking is macOS-specific. Imported browser-session restoration depends on secure local storage. Optional browser account discovery exposes metadata only, without agent password filling or generation.
- Basic Wiki links do not add embeds, heading or block navigation. Large/unsupported file formats retain safe read-only or lightweight editor fallbacks. In-session failed editor drafts are not crash backups.
- Saved transcript highlight/underline payloads are removed by migration 101. Unverifiable historical Claude token totals remain incomplete rather than being reconstructed speculatively.

### Verification

- Final release validation used the repository-pinned **Node 24.13.1 and Bun 1.4.2**. All four package versions and lockfile workspace versions match 0.8.4; the 29 release highlights match exactly across app, marketing and public website.
- `bun run fmt:check`, `bun run lint`, `bun run typecheck`, `bun run release:smoke`, `bun run brand:check`, `bun run windows-runtime:check` and `bun run migrations:check` passed. Lint reports 560 existing warnings and zero errors; typecheck passes all seven workspaces. The platform-boundary check covers 238 application source files; released migration names/IDs remain unchanged across 87 existing tags.
- `bun run build` passed all five tasks on the final reviewed copy. Existing large-chunk, Browserslist data and marketing output-cache warnings remain. An earlier sandboxed build stalled in Next.js and was stopped; the permitted rerun completed.
- **Final `bun run test`: 949 files and 11,406 tests passed; 12 files and 30 tests skipped. All seven Turbo tasks succeeded.** The cached task is the contracts build prerequisite; test tasks ran. Browser-only checks run separately in CI; native/device/provider opt-in cases retain their configured exclusions.
- The first permitted full run failed `apps/server/src/orchestration/Layers/messageTextChunks.test.ts` → `preserves split Unicode across segments, restart and completion in every reader`: Node 24 SQLite TEXT reads truncated after an embedded NUL. The existing JSON fallback now preserves NULs as well as unmatched surrogate code units. The original failure was reproduced, four related suites passed 87 tests after the fix, and the entire suite then passed as reported above. This was a real release-validation fix, not a targeted-only pass or a flaky-test dismissal.
- An initial attempt used the shell's Node 26 and a restricted sandbox, producing local-socket/process failures and an aborted suite. It is not counted as passing. Validation was restarted with the pinned runtime and required local socket permissions; no duplicate test process was left running.
- Both documentation copies passed **56 documentation tests**, integrity checks and lint; both production builds passed. The public website first needed its ignored Fumadocs index regenerated and its already-declared dependencies restored with `npm ci`; no dependency manifest/lockfile change was required. Two focused guides, navigation, source evidence and regression contracts cover the release. No documentation external links were added or changed, so `test:links` was not required.
- The public website content is prepared and verified locally; its separate commit/push is optional and has not been performed by this release preparation. The pre-existing local installer-count commit is preserved.
- The first hosted release preflight stopped on `apps/desktop/src/browserAutomation/browserVault.test.ts` → `preserves saved passwords when provenance persistence fails (update=false)` exceeding 5 seconds. The provenance cases perform five production scrypt derivations and durable writes; neighboring hosted cases took 4.49 and 4.36 seconds. The real-crypto suite now has a scoped 15-second timeout, with cryptographic parameters and assertions preserved. Both related suites passed all 14 tests locally; a fresh full run after this test-only change again passed all 11,400 tests in 949 files, with the same configured skips.
- Marketing CI passed functional, accessibility and production-performance checks but rejected the docs screenshot because the new guide section changed the page from 1,908 to 2,054 pixels high. The Linux actual image was identical across all three attempts and was visually reviewed before updating the expected snapshot. The refreshed macOS snapshot passed a fresh focused comparison in marketing and an independent zero-difference comparison in the public website. This is an intentional content-baseline update, with screenshot tolerances unchanged.
- Native packaging, provenance, platform startup smoke and uploaded artifacts are checked by the tag's release workflow. Windows publication uses `SYNARA_ALLOW_UNSIGNED_WINDOWS_RELEASE=0.8.4`; macOS signing/notarization remains required. Local source tests and historical performance fixtures do not certify live provider sessions, macOS permission flows, hardware GPU savings or every installed-platform interaction.
- The next hosted attempt passed preflight, Linux and Windows packaging/startup, but both signed/notarized macOS artifacts timed out waiting for startup proof after 60 seconds. Code inspection found eager OS-key creation in the new empty vault/session stores before backend startup. Initialization is now deferred until needed, with focused first-use, concurrency, disposal and corrupt-store coverage. The startup verifier also prints bounded process/log tails before cleanup on failure; its timeout and proof requirements remain unchanged. The full post-fix suite passed all 11,406 tests in 949 files; formatting, lint, all seven workspace typechecks, release smoke and all five build tasks passed. Native confirmation is supplied by the subsequent release run.
- Main CI passed after rerunning the unchanged-head Studio browser job: its first attempt timed out in `coalesces repeated Studio new-chat clicks and stays in Studio after navigation settles`. No assertion or production code was changed for that rerun. Marketing CI passed with the reviewed documentation snapshots.

### Complete change index

[All development and release-preparation commits and the complete diff](https://github.com/Emanuele-web04/synara/compare/v0.8.3...v0.8.4). The following first-parent index includes merged pull requests and direct changes, newest first; intermediate commits inside merged branches are available in the comparison.

<details>
<summary>Expand the complete mainline change list</summary>

- [0eaf3831e](https://github.com/Emanuele-web04/synara/commit/0eaf3831e) Improve workspace editor autosave and dirty-state handling (#1186)
- [91ad50f9c](https://github.com/Emanuele-web04/synara/commit/91ad50f9c) Update verify skill with real-provider E2E guidance (#1171)
- [eb34fc538](https://github.com/Emanuele-web04/synara/commit/eb34fc538) docs(perf): qualify cold/incremental methodology for contracts and shared (#1008)
- [3b021c681](https://github.com/Emanuele-web04/synara/commit/3b021c681) fix(web): separate message and geometry signals in tail anchor scroll (#1077)
- [2f93cd4c1](https://github.com/Emanuele-web04/synara/commit/2f93cd4c1) fix(perf): close Electron app when firstWindow fails in status runner (#1078)
- [c0f999df1](https://github.com/Emanuele-web04/synara/commit/c0f999df1) Add correctly sized icons to native context menus (#1183)
- [2e9819ea2](https://github.com/Emanuele-web04/synara/commit/2e9819ea2) Refine composer extras menu (#1177)
- [4db0e34bd](https://github.com/Emanuele-web04/synara/commit/4db0e34bd) Standardize toast actions as font-matched ghost buttons (#1176)
- [12ee8f937](https://github.com/Emanuele-web04/synara/commit/12ee8f937) Refresh Git diff views after editor saves and file changes (#1175)
- [c9c09b0a8](https://github.com/Emanuele-web04/synara/commit/c9c09b0a8) fix(antigravity): register background tasks from transcript before the stop hook (#1170)
- [3a0d491df](https://github.com/Emanuele-web04/synara/commit/3a0d491df) Allow exact provider targets for agent-authored automations (#1167)
- [478b38660](https://github.com/Emanuele-web04/synara/commit/478b38660) fix: normalize OpenCode server pool identity (#1169)
- [99d7dd117](https://github.com/Emanuele-web04/synara/commit/99d7dd117) fix(web): reject malformed percent-encoding in theme share strings (#1168)
- [6ae3a6937](https://github.com/Emanuele-web04/synara/commit/6ae3a6937) Use shared PanelLeft icon for sidebar trigger
- [c21645a25](https://github.com/Emanuele-web04/synara/commit/c21645a25) Redesign composer extras as a shared command panel (#1146)
- [939d93c35](https://github.com/Emanuele-web04/synara/commit/939d93c35) Fix simulator pane stuck connecting after its first frame (#1164)
- [889eb4212](https://github.com/Emanuele-web04/synara/commit/889eb4212) Fix simulator screenshot previews and downloads in chat (#1153)
- [5d068e088](https://github.com/Emanuele-web04/synara/commit/5d068e088) Fix desktop backend lifetime after parent exit (#1154)
- [2d05ebf0a](https://github.com/Emanuele-web04/synara/commit/2d05ebf0a) Keep Codex Markdown together across text segments (#1155)
- [f668f5be2](https://github.com/Emanuele-web04/synara/commit/f668f5be2) docs: refresh shared agent guidance and remove conflicting policies
- [5a25d5c81](https://github.com/Emanuele-web04/synara/commit/5a25d5c81) Add GPT-6 Astra as the default Codex model
- [7126c9803](https://github.com/Emanuele-web04/synara/commit/7126c9803) Merge pull request #1149 from kartikkabadi/chore/remove-devin-cli-wedge-report
- [5e65a8871](https://github.com/Emanuele-web04/synara/commit/5e65a8871) Add personal asset context document
- [a355cf200](https://github.com/Emanuele-web04/synara/commit/a355cf200) Refactor ChatView and reuse storage schema machinery (#1144)
- [31ed6b9ae](https://github.com/Emanuele-web04/synara/commit/31ed6b9ae) Keep effort slider open after model selection
- [ac68cd0f5](https://github.com/Emanuele-web04/synara/commit/ac68cd0f5) Prevent transcript action labels from clipping
- [abb797240](https://github.com/Emanuele-web04/synara/commit/abb797240) Compact selection controls and fix empty slider fill
- [79bd48963](https://github.com/Emanuele-web04/synara/commit/79bd48963) Soften raised surface borders
- [a311a844a](https://github.com/Emanuele-web04/synara/commit/a311a844a) Keep effort slider thumb flush and soften its shadow
- [48699c1e7](https://github.com/Emanuele-web04/synara/commit/48699c1e7) fix(pi): queue mid-turn sends as follow-ups instead of erroring (#1135)
- [c72b2cf4e](https://github.com/Emanuele-web04/synara/commit/c72b2cf4e) Optimize CI test parallelism and reduce critical-path runtime (#1140)
- [c317f5949](https://github.com/Emanuele-web04/synara/commit/c317f5949) [codex] Fix Claude token accounting and verified usage stats (#1127)
- [65309b9e2](https://github.com/Emanuele-web04/synara/commit/65309b9e2) [codex] Fix immediate PR status updates in Environment (#1126)
- [98783f7f8](https://github.com/Emanuele-web04/synara/commit/98783f7f8) feat(desktop): add safe AppSnap window picker (#1141)
- [bf5efc58f](https://github.com/Emanuele-web04/synara/commit/bf5efc58f) truncate oversized working-tree patches instead of hard-failing (#1138)
- [0e44fd59d](https://github.com/Emanuele-web04/synara/commit/0e44fd59d) Canonicalize model display names through one shared humanizer (#1139)
- [53668e185](https://github.com/Emanuele-web04/synara/commit/53668e185) [codex] Fix missing tool calls after steering (#1124)
- [f65f34260](https://github.com/Emanuele-web04/synara/commit/f65f34260) Remove saved transcript highlights and underlines (#1131)
- [df9c90577](https://github.com/Emanuele-web04/synara/commit/df9c90577) Add selection actions and a shared mini chat composer (#1130)
- [870c9d2e9](https://github.com/Emanuele-web04/synara/commit/870c9d2e9) [codex] Show context compaction progress with an icon (#1129)
- [4457f5f40](https://github.com/Emanuele-web04/synara/commit/4457f5f40) [codex] Fix Fast mode reset and duplicate skill input (#1125)
- [ad8db6fdb](https://github.com/Emanuele-web04/synara/commit/ad8db6fdb) Remove effort level description from composer slider
- [b335765c4](https://github.com/Emanuele-web04/synara/commit/b335765c4) Tighten user message bubble spacing
- [3b16d6d00](https://github.com/Emanuele-web04/synara/commit/3b16d6d00) Refresh Safari onboarding and add magnetic effort slider
- [021090808](https://github.com/Emanuele-web04/synara/commit/021090808) feat(browser): BetterWright browser automation with saved logins and embedded popups (#1114)
- [0b82e2196](https://github.com/Emanuele-web04/synara/commit/0b82e2196) feat(web): combine highlighted Explorer editing with a fast numbered fallback (#1123)
- [3b531ad0d](https://github.com/Emanuele-web04/synara/commit/3b531ad0d) Add slider-based composer effort control (#1120)
- [1de0ab31a](https://github.com/Emanuele-web04/synara/commit/1de0ab31a) Render Cursor ACP Task calls as active subagent runs (#1119)
- [e307d251d](https://github.com/Emanuele-web04/synara/commit/e307d251d) Increase user message bubble horizontal padding
- [3b18b8fa3](https://github.com/Emanuele-web04/synara/commit/3b18b8fa3) Reduce user message bubble horizontal padding
- [49d24f4c0](https://github.com/Emanuele-web04/synara/commit/49d24f4c0) Refine chat bubbles and notification surfaces
- [4362f6ea4](https://github.com/Emanuele-web04/synara/commit/4362f6ea4) Refine chat bubble corners and seam contrast
- [cfa32ece5](https://github.com/Emanuele-web04/synara/commit/cfa32ece5) Align picker controls with app typography settings
- [df82e80a7](https://github.com/Emanuele-web04/synara/commit/df82e80a7) Merge pull request #1108 from Emanuele-web04/synara/refine-project-picker-menus
- [2e98e50b5](https://github.com/Emanuele-web04/synara/commit/2e98e50b5) Open thread pull requests in the right dock
- [7aa0ecb1a](https://github.com/Emanuele-web04/synara/commit/7aa0ecb1a) Unfill composer landing tray in both themes
- [738a3ce71](https://github.com/Emanuele-web04/synara/commit/738a3ce71) Keep orchestration dispatch responsive under slow subscribers (#1115)
- [c680c24b2](https://github.com/Emanuele-web04/synara/commit/c680c24b2) Recover pending Claude questions across restarts and expired sessions (#1113)
- [3d71dcee8](https://github.com/Emanuele-web04/synara/commit/3d71dcee8) fix(approvals): reconcile duplicate response races (#1102)
- [16f63051c](https://github.com/Emanuele-web04/synara/commit/16f63051c) fix(pi): keep extension status out of tool timeline (#1093)
- [a30dc14ff](https://github.com/Emanuele-web04/synara/commit/a30dc14ff) Merge pull request #1098 from Emanuele-web04/perf/streaming-write-floor
- [d724d3ccc](https://github.com/Emanuele-web04/synara/commit/d724d3ccc) Merge pull request #1097 from Emanuele-web04/perf/streaming-chunks-memory-cleanup
- [dd028735a](https://github.com/Emanuele-web04/synara/commit/dd028735a) fix(images): keep inspected images out of generated outputs (#1100)
- [d9e0b0ba3](https://github.com/Emanuele-web04/synara/commit/d9e0b0ba3) Keep branch PR status visible after merge or close (#1103)
- [becd74977](https://github.com/Emanuele-web04/synara/commit/becd74977) Remember each project's Local or Worktree chat preference (#1105)
- [0036f6afc](https://github.com/Emanuele-web04/synara/commit/0036f6afc) Map Claude overage telemetry to the Fable weekly sublimit (#1104)
- [348a1dfb9](https://github.com/Emanuele-web04/synara/commit/348a1dfb9) Render pull request badges as icon-only sidebar controls
- [71862f9b2](https://github.com/Emanuele-web04/synara/commit/71862f9b2) Lighten translucent sidebar surfaces
- [4a62652ee](https://github.com/Emanuele-web04/synara/commit/4a62652ee) Increase translucent sidebar blur to 4px
- [f4d1ee81f](https://github.com/Emanuele-web04/synara/commit/f4d1ee81f) Deepen dark translucent sidebar surface
- [c6328f62f](https://github.com/Emanuele-web04/synara/commit/c6328f62f) Make dark translucent sidebar surfaces sheerer
- [77a09d6f7](https://github.com/Emanuele-web04/synara/commit/77a09d6f7) Neutralize theme washes and lighten dark sidebar glass
- [d8bbe9086](https://github.com/Emanuele-web04/synara/commit/d8bbe9086) Match selected sidebar rows to the secondary surface
- [a08a0c854](https://github.com/Emanuele-web04/synara/commit/a08a0c854) Align sidebar selection with themed ink washes
- [690a9ac4e](https://github.com/Emanuele-web04/synara/commit/690a9ac4e) Reduce sidebar translucency and backdrop blur
- [1e94e7a65](https://github.com/Emanuele-web04/synara/commit/1e94e7a65) Fix Windows workspace directory links (#1085)
- [699de4f5d](https://github.com/Emanuele-web04/synara/commit/699de4f5d) Refine sidebar translucency and accent-tinted selection (#1089)
- [3b21b4c97](https://github.com/Emanuele-web04/synara/commit/3b21b4c97) fix(web): show configured project name in sidebar (#1000) (#1086)
- [59db80a17](https://github.com/Emanuele-web04/synara/commit/59db80a17) feat: maximize document previews and resolve workspace wiki links (#1023)
- [65eb5b90c](https://github.com/Emanuele-web04/synara/commit/65eb5b90c) feat: polish session restart / context-loss rail markers (#1058)
- [3aff699f8](https://github.com/Emanuele-web04/synara/commit/3aff699f8) fix: preserve bracketed math and numeric inline formulas (#1020)
- [428f07e5e](https://github.com/Emanuele-web04/synara/commit/428f07e5e) Diff view upgrades: live updates, blame, compare-with-ref, change navigation, and in-app editing (#561)
- [5651de17d](https://github.com/Emanuele-web04/synara/commit/5651de17d) [codex] Fix first-thread startup flicker (#1084)
- [4bb3dccfa](https://github.com/Emanuele-web04/synara/commit/4bb3dccfa) Allow retries after confirmed Codex startup failures (#1074)
- [bdfa181c8](https://github.com/Emanuele-web04/synara/commit/bdfa181c8) Add interactive first-run onboarding flow (#1031)
- [7fe2a9032](https://github.com/Emanuele-web04/synara/commit/7fe2a9032) Add pull request context cards to composer and transcript (#1071)
- [91e454b62](https://github.com/Emanuele-web04/synara/commit/91e454b62) fix(server): preserve Antigravity print output and terminal states (#1021)
- [bbfcd9387](https://github.com/Emanuele-web04/synara/commit/bbfcd9387) fix(server): correct provider usage and native fork resumes (#1024)
- [ede5961c5](https://github.com/Emanuele-web04/synara/commit/ede5961c5) fix: preserve activity ordering across live updates and snapshots (#1019)
- [fd309cb8d](https://github.com/Emanuele-web04/synara/commit/fd309cb8d) fix(server): handle Pi auto-retry as inline warnings, keep End task responsive (#1061)
- [d3f6b1b67](https://github.com/Emanuele-web04/synara/commit/d3f6b1b67) Optimize status animations and timeline resource usage (#1064)
- [bbae09b75](https://github.com/Emanuele-web04/synara/commit/bbae09b75) fix(models): normalize provider model display names (#1016)
- [c3685a487](https://github.com/Emanuele-web04/synara/commit/c3685a487) feat(web): let Side chats pick provider/model before first turn (#1055)
- [28ae187d1](https://github.com/Emanuele-web04/synara/commit/28ae187d1) ci: exclude all .github images from the docs-only filter (#1014)
- [e6b1aef22](https://github.com/Emanuele-web04/synara/commit/e6b1aef22) fix(server): stop mirroring Codex SQLite state into the home overlay (#1062)

</details>

## 0.8.3 - 2026-09-06

Hotfix for the missing packaged dependency reported immediately after 0.8.2.

### Added

- Added a packaged runtime dependency smoke check before release startup verification and artifact upload.

### Changed

- Remember the selected Split or Stacked diff layout across panel remounts and app restarts.
- Build the server as ESM only; remove the unused CommonJS output that could not load import-only dependencies.

### Fixed

- Ship zod as a production dependency, fixing the packaged app's Cannot find package 'zod' error when loading the ACP SDK.

### Verification

- Validated with Node 24.13.1 and Bun 1.4.2; frozen-lockfile installation passed.
- `bun run fmt:check`, `bun run lint`, `bun run typecheck`, and `bun run release:smoke` passed. Lint reported 520 warnings and no errors; all seven workspaces passed typechecking.
- `bun run build` passed all five tasks. Existing large-chunk and marketing build-output cache warnings remain.
- `bun run test` passed all eight tasks: 903 test files and 10,530 tests passed, with 11 files and 30 tests skipped. No failing tests or targeted reruns were needed.
- Focused packaged-runtime regression checks verified missing zod fails and the repaired archive passes using the installed macOS Electron runtime; the diff-layout browser regression also passed.
- Both documentation copies passed 53 documentation tests and lint; the public website build passed. Documented packaged dependency recovery and persistent diff layout.

## 0.8.2 - 2026-09-06

This release includes 43 commits since v0.8.1, covering measured performance improvements, model discovery, provider recovery, file previews, and everyday task controls.

### Added

- Added app-owned `/rename <title>` for a direct title change and bare `/rename` for conversation-based title generation. Empty drafts need a message before generation; newer title changes win over stale generated results.
- Added **Add to chat** for selections in rendered Markdown previews.
- Added **Automatically open simulator** so users can keep working in Simulator.app without automatically reopening Synara's mirrored pane. Manual opening remains available.
- Added startup phase-duration diagnostics and benchmark fixtures with raw measurements for streaming, file sorting, tool output, browser diagnostics, and native typechecking.

### Changed

- Stabilized Markdown render components so unchanged code blocks keep their DOM, soft-wrap state, and highlighting lifecycle during streaming. The automation dialog subscribes to other transcripts only while open, and the branch toolbar uses the focused usage selector.
- Coalesced streaming deltas while preserving message, completion, structural-event, and project boundaries. Running-thread synchronization and animation timing avoid redundant work without changing animation appearance.
- Replaced repeated locale-option setup with a lazy shared natural-order collator for diff lists and trees.
- Consolidated tool-output suffix parsing to avoid pathological whitespace backtracking, and count read-summary lines without allocating split arrays.
- Bounded browser diagnostics with one-pass exact JSON byte accounting instead of repeatedly serializing and discarding old entries.
- Selected prior transcript messages without normalizing each body, preserving original text and object identity.
- Wake queued turn work when a blocking claim settles instead of waiting only for the polling interval.
- Cache provider model discovery per project/runtime, deduplicate concurrent requests, bound discovery time and retry cooldowns, prioritize the selected provider, and surface degraded or failed discovery.
- Updated Pi model discovery for native OpenRouter authentication and OpenCode Zen protocols/capabilities, and upgraded its SDK for GLM 5.3 Flash and GPT-6 Astra.
- Made Claude compaction **Auto (Claude Code)** by default, separate from explicit 200k and 1M overrides. Auto leaves window resolution to Claude Code; explicit overrides remain pinned. SDK summary context usage avoids per-turn token-count requests, and gateway metadata exposes Claude context windows.
- Reduced shared harness and browser-tool schema overhead while retaining tool-specific guidance and accepted inputs.
- Restore the last-used model and options in new chats, and persist sidebar project expansion state, including legacy project aliases.
- Filter routine Codex startup noise while preserving actual errors, use a dedicated compaction icon, and soften chat card seams.
- Import the public website into `apps/marketing` with Cloudflare Workers preparation, and stop its redundant theme-class MutationObserver feedback loop.
- Upgrade the pinned Bun toolchain to 1.4.2 and make TypeScript 7 the default seven-workspace checker. Keep `typecheck:legacy` for the documented Effect diagnostic gap and compiler comparisons.
- Split CI into static, unit, browser, and build lanes; shard unit/browser tests, cache installs, and add a documentation-only fast path. Correct PR-size label synchronization ordering.
- Remove confirmed unused code and consolidate shared logic while retaining independent regression coverage.
- Bump server, desktop, web, contracts, and lockfile workspace versions to 0.8.2.

### Measured performance

These are recorded before/after experiments for the merged changes, not a new v0.8.1-versus-v0.8.2 end-to-end benchmark. The reports include workloads, controls, raw samples, and limits.

**Concurrent streaming component benchmark** — Apple M5, 32 GiB RAM, production Vite/Chromium build, one visible fenced-code message, 200 settled messages per task, 36 alternating samples across variants/workloads. Each sample used six seconds of synthetic input plus settling; providers, transport, sidebar, and Electron integration were excluded.

| Metric                     | Five streams: before → after        | Ten streams: before → after         |
| -------------------------- | ----------------------------------- | ----------------------------------- |
| Total Chromium CPU time    | 3.597 → 2.858 s (20.5% lower)       | 3.440 → 3.136 s (8.8% lower)        |
| Renderer CPU time          | 3.196 → 2.187 s (31.6% lower)       | 3.048 → 2.417 s (20.7% lower)       |
| Frame-interval p95         | 25.0 → 9.6 ms                       | 25.0 → 9.7 ms                       |
| Renderer RSS at sample end | 428.516 → 352.828 MiB (17.7% lower) | 435.562 → 350.891 MiB (19.4% lower) |

- Unchanged code-block remounts fell from 60 to zero; the closed automation hook fell from 120 renders to zero during 60 hidden-thread flushes.
- End-of-sample RSS is not peak RAM or evidence of a fixed leak. Hidden-stream RSS changed by under 0.5%, and browser-process CPU increased in the visible case even while total Chromium CPU decreased. These results do not establish whole-app, real-provider, hardware GPU, or energy savings.
- Evidence: [concurrent-thread report](docs/performance/2026-09-05-concurrent-threads/report.md).

**Isolated production-function benchmarks** — three fresh processes per variant, warmups, alternating order, matching output hashes, Apple M5, Node 24.13.0 and Bun 1.3.12:

| Operation                                         |       Before |     After | Reduction |
| ------------------------------------------------- | -----------: | --------: | --------: |
| Sort 2,048 diff paths                             |    36.452 ms |  2.593 ms |     92.9% |
| Build a 2,048-path tree                           |    18.889 ms |  1.912 ms |     89.9% |
| Derive a normal 24 KB multiline work log          |     0.742 ms |  0.460 ms |     38.0% |
| Derive an adversarial whitespace-heavy work log   | 2,287.290 ms | 0.0527 ms |   >99.99% |
| Count a 2,000-line read summary                   |    0.0355 ms | 0.0149 ms |     57.9% |
| Read 200 browser logs with large URLs             |    80.060 ms |  0.964 ms |     98.8% |
| Select prior messages from 2,000 × 2 KiB messages |     1.833 ms | 0.0195 ms |     98.9% |

- Large diagnostic reads returned the same 40 entries and 326,893-byte payload. Ordinary small diagnostic reads and the unchanged transcript control were within noise and are not counted as wins.
- The isolated website theme probe reduced 427–430 observer callbacks per 1.1 seconds to zero across light/dark/system behavior; this is not a full-site CPU or first-paint measurement.
- Evidence: [operation report](docs/performance/2026-09-06/report.md).

**Developer checks** — seven workspaces, Bun 1.4.2, three alternating samples per command/cache state, Turbo result caching disabled:

- Cold compiler-cache median: 56.339 → 12.528 seconds, 77.8% lower (4.50×).
- Unchanged incremental median: 12.451 → 3.170 seconds, 74.5% lower (3.93×).
- These compare legacy and native typechecking, not app runtime. The native checker has a verified Effect `importFromBarrel` diagnostic gap, so the timings do not imply equivalent diagnostic coverage.
- Evidence: [native-typecheck qualification](docs/performance/2026-09-06/native-typecheck.md).

### Fixed

- Preserve user scroll ownership during streaming; tool-only activity, buffering, and reconnects do not count as live assistant text.
- Avoid the empty-home flash while the first message is being dispatched; keep provider status and turn durations truthful and stable.
- Keep read tasks from reappearing as unread after restart, and restore orchestrator approval cards.
- Revalidate open text, image, PDF, and diff views after file changes without overwriting dirty text edits.
- Prevent background simulator events from stealing focus, preserve task ownership and deferred requests, and respect manual pane closure.
- Recover stale Devin sessions before prompt dispatch and restart wedged child runtimes instead of waiting for the full idle budget.
- Correct Pi/OpenCode agent-gateway tool schemas and provider-event whitespace sanitization.
- Preserve Unicode character boundaries in handoff bootstrap text, and deduplicate stale-recovery refinements.
- Read Factory Droid usage from available Factory credentials, including supported secure storage.
- Fix native Windows Cursor/Devin detection, hide Effect child-process windows, and accept PID zero in process snapshots.
- Back off repeated failing Git remote refreshes and reset the failure count after success.
- Avoid false checkpoint-baseline failure when a task starts in a plain directory and initializes Git during the turn; an absent historical baseline remains absent.
- Fix the KeybindingsToast cold-shard test race and Antigravity adapter teardown race.

### Verification

- Verified with Node 24.13.1 and Bun 1.4.2; frozen-lockfile installation passed. The release lockfile changes only the four workspace versions.
- `bun run fmt:check` passed; `bun run lint` passed with 520 warnings and no errors.
- `bun run typecheck` and the additional `bun run typecheck:legacy` both passed all seven workspaces.
- `bun run release:smoke` passed.
- The first `bun run build` failed during Next prerendering with `Expected workStore to be initialized`; after dependency installation settled, the full rerun passed all five tasks in 1m54.184s. No application code change was needed. Existing large-chunk and Browserslist advisories remain.
- Full `bun run test` passed all eight Turbo tasks in 6m7.704s: 903 test files and 10,528 tests passed; 11 files and 30 tests were skipped. No targeted test rerun was needed.
- Public documentation was audited against all 43 source commits and updated in both website copies. Both copies passed documentation checks (52 tests plus integrity validation), lint, and build. The first external-site build exposed a release-copy syntax error, which was corrected before the successful rerun. Stale local Astro/OpenNext generated artifacts were moved out of the monorepo website before its lint pass.
- The compiled website changelog was checked in the browser, and release versions plus the in-app/monorepo website highlights were verified to match.

## 0.8.1 - 2026-09-02

### Added

- Added Claude Fable 5.1 as the leading Claude Agent model, with the exact `claude-fable-5-1` slug, a one-million-token context window, always-on thinking, Low through Max effort, no fast-mode lane, and no legacy ultrathink prompt mode.
- Added Fable 5.1 to Pi's repaired Anthropic catalog so authenticated Pi installations whose upstream model list predates the release can still select it alongside Fable 5 and Opus 4.8.
- Added Fable 5.1 aliases for `fable`, `fable-5.1`, `claude-fable-5.1`, `claude-fable-5-1`, and bracketed context-window descriptors while preserving explicit Fable 5 selections.
- Added Fable 5.1 to Cursor's compatible one-million-token Claude variant fallback.
- Added Claude's model-scoped Fable weekly allowance to usage surfaces, parsed from Anthropic's current `weekly_scoped` limits array and ordered directly after the general Weekly window.
- Added shared platform process, environment, filesystem, WSL, lifecycle, and process-tree teardown boundaries for provider, Git, updater, voice, terminal, and server execution.
- Added typed provider startup phases and failure reasons so executable lookup, spawn, handshake, authentication, protocol, timeout, cancellation, and unproven-exit failures remain distinguishable.
- Added a Windows runtime boundary check to CI and internal architecture documentation for executable resolution, process launch, WSL routing, teardown proof, filesystem durability, and provider integration.

### Changed

- Reduced large-database startup work by accepting the live shell-stream snapshot as authoritative and issuing a deferred query only when that subscription generation still lacks a snapshot, including reconnect recovery.
- Pruned open-turn journal rows for purged, deleted, or archived threads without a live projected turn, and stopped replaying a turn after its first failure instead of repeating hundreds of warnings on every boot.
- Scaled SQLite page-cache and mmap budgets to physical memory: 64 MB / 256 MB below 12 GB, 128 MB / 512 MB below 24 GB, and the existing larger defaults on higher-memory systems.
- Preloaded the Google Fonts stylesheet so a slow or unavailable network cannot hold back the application module during startup.
- Gave active Devin tool calls a separate one-hour inactivity budget while retaining the ordinary 30-minute idle budget for turns without an active tool; both remain environment-configurable.
- Centralized native Windows, POSIX, and WSL launch planning, including PATH/PATHEXT lookup, qualified relative commands, `.cmd` and `.bat` shims, PowerShell scripts, argument serialization, working directories, and command-not-found mapping.
- Centralized supervised process-tree teardown and made success require proof that the owned root and captured descendants exited; Windows escalation revalidates creation identity before signalling.
- Changed the Git text-generation picker to include only dedicated one-shot backends: Codex, Cursor, OpenCode, and Factory Droid.
- Tightened composer vertical spacing and aligned picker capsules, project reset highlighting, and folder/reset icon treatment.
- Bumped Synara release package versions to `0.8.1` across server, desktop, web, and contracts packages and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed the plain Claude `fable` alias continuing to select Fable 5 instead of Fable 5.1, while keeping `fable-5` and `claude-fable-5` backward compatible.
- Fixed older Pi Anthropic catalogs omitting Fable 5.1 and fixed Cursor fallback matching not recognizing its one-million-token context variant.
- Fixed Claude's per-model weekly limits disappearing after Anthropic moved them from nullable legacy top-level fields into scoped rows under `limits[]`.
- Fixed startup fetching and transferring the large shell snapshot up to three times even when the live stream had already supplied it.
- Fixed deleted or unrecoverable turns being replayed on every boot and producing repeated stack-trace warnings before the server began listening.
- Fixed low-memory machines using SQLite cache and mmap defaults large enough to increase swap pressure.
- Fixed Devin's watchdog terminating healthy turns whose current tool produced no events for longer than the ordinary idle window.
- Fixed stale Devin events from older turns refreshing the active watchdog clock.
- Fixed Devin's boolean `get_output.block` field being rejected by strict ACP decoding before the tool could complete; the normalization is restricted to that provider, method, and field.
- Fixed project and project-task creation reporting success before a real task ID existed, and fixed superseded navigation replacing a newer route.
- Fixed Git-writing settings exposing chat-only providers without a dedicated one-shot text-generation backend and omitting Cursor despite its supported backend.
- Fixed qualified relative executables resolving against the server directory instead of the requested child working directory.
- Fixed Windows and WSL process launches duplicating provider-specific command lookup, shell, quoting, and working-directory rules.
- Fixed provider startup deadline expiry being reported as cancellation instead of a handshake timeout.
- Fixed process teardown reporting success without proving root and descendant exit, targeting a reused Windows PID, or losing proof state across bounded snapshot retries.
- Fixed new task creation being allowed before project hydration completed.

### Verification

- `bun run fmt:check` passed across 18,823 files.
- `bun run lint` passed with 489 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; two existing Effect Schema suggestions and Astro/Vite deprecation notices remained informational.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful; existing deprecation, plugin-timing, stale Browserslist, and large-chunk advisories remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 3m47.485s: 890 test files and 10,247 tests passed, with 4 files and 22 tests skipped by platform or integration gates. No targeted rerun was needed.

## 0.8.0 - 2026-09-01

### Added

- Added Devin CLI as a first-class ACP provider, including fresh-session startup, native resume, model and command discovery, Plan mode, conversation compaction, file and image attachments, MCP server configuration, account usage, authentication guidance, and capability-aware UI behavior.
- Added provider-neutral WebMCP browser tools so every compatible runtime can discover and operate the task-owned browser through the same bounded tool surface, timeout policy, result shaping, tab ownership, and cleanup lifecycle.
- Added in-thread transcript search through a floating Cmd/Ctrl+F panel with live result counts, previous and next navigation, keyboard controls, match highlighting, and focused scrolling across real conversation messages.
- Added server-backed provider enablement so disabling a provider stops its lifecycle execution rather than only hiding it in the client.
- Added provider-originated context-change events to the conversation so compaction and other runtime context transitions remain visible and attributable.
- Added usage coverage for every enabled provider whose account state Synara can verify, with shared refresh, caching, and presentation behavior.
- Added customizable ordering for the primary sidebar navigation, including drag-and-drop controls, durable local persistence, cross-window synchronization, forward-compatible defaults, and invalid-state recovery.
- Added durable parent-linked side-chat panes with persisted leases, restoration after refresh, safe expiry, and lease preservation across archive and unarchive operations.
- Added macOS Reveal in Finder for changed files and split the edited-file actions into explicit Open, Reveal, and Copy Path operations.
- Added absolute workspace-path badges while refusing to turn missing relative references into misleading file chips.
- Added Factory Droid support to the shared Git text-generation flow for commit messages and pull-request descriptions.
- Added explicit acceptance of dot-prefixed attachment, preview, plugin, favicon, and generated-image filenames.
- Added numeric PDF destination resolution so document links can open the intended page instead of treating the destination as an unresolved label.
- Added migration recovery consent and repair surfaces for failed database upgrades, including runtime identity checks, recoverable backups, deliberate restore or retry choices, and durable recovery state.

### Changed

- Removed the retired Kilo Code provider and migrated existing Kilo provider sessions, tasks, favorite-provider preferences, and saved editor-tab state to OpenCode.
- Isolated source desktop launches from installed Stable and Canary data by default while preserving explicit home-directory behavior and existing installed-app identities.
- Improved live-conversation performance by loading model options sooner, reducing repeated sidebar projections, limiting visibility-driven updates, and keeping the common transcript path free of unnecessary virtualization churn.
- Restricted auto-scroll re-arming to real transcript messages and active assistant text; buffering, reconnecting, approvals, tool-only activity, and generic working state no longer masquerade as new streamed content.
- Strengthened queued follow-up dispatch so a follow-up waits until the previous turn actually starts, backgrounded tasks promote queued work, constrained-capacity previews retain their contents, and idle-stop recovery resumes from the durable cursor.
- Consolidated WebMCP discovery and invocation behind provider-neutral server and web contracts instead of runtime-specific browser plumbing.
- Moved provider visibility policy into shared server state so Settings, runtime startup, provider discovery, usage, and client presentation agree on the enabled set.
- Hid routine provider lifecycle hooks from the transcript while retaining user-relevant context transitions, errors, tools, and recovery evidence.
- Refined the What’s New popout, chat picker pills, composer rail, folded segmented assistant messages, environment usage display, and release-history layout.
- Preserved one self-contained final assistant response after segmented text, tools, folded output, and terminal settlement instead of leaving the visible conclusion dependent on earlier fragments.
- Improved edited-file actions, path copying, preview retention, and platform-native file management without combining unrelated operations behind one ambiguous control.
- Upgraded Electron from 40.10.6 to 43.4.1 to include the fix for CVE-2026-70608 and the corresponding Chromium security updates.
- Changed POSIX desktop update shutdown to ask the backend to exit gracefully before replacement, while retaining a bounded fallback for unresponsive processes.
- Abbreviated Windows home-directory paths consistently in the interface and preserved valid Windows drive roots during path normalization.
- Tightened provider runtime identity handling: source validation consults the cwd only when no launcher digest exists, prerelease versions preserve every identifier segment, and native resume is gated by the provider's actual capability.
- Made Claude Auto context variants match their exact advertised context limits and fail closed when a model descriptor is ambiguous.
- Made long-thread pagination lossless across message boundaries, bound continuations to the original message version and offset, and count Unicode-safe character offsets instead of byte slicing.
- Refreshed provider usage from the post-compaction boundary so stale pre-compaction accounting is not presented as current state.
- Bumped Synara release package versions to `0.8.0` across server, desktop, web, and contracts packages and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed queued follow-ups racing the turn ahead of them, dispatching only in the foreground, losing preview content under capacity pressure, or failing to resume after an idle provider stop.
- Fixed streamed assistant replies being duplicated when reconnect, replay, settlement, and live projection overlapped.
- Fixed sidebar and transcript streaming paths doing repeated scans and measurement work that could cause visible toggle lag or scroll-follow feedback loops.
- Fixed transcript search and auto-follow treating tool rows or non-message runtime activity as newly arrived conversation text.
- Fixed provider disablement being cosmetic: hidden providers can no longer continue to start sessions or execute lifecycle work on the server.
- Fixed provider context changes and meaningful update notices disappearing when lifecycle events were filtered or availability checks overlapped.
- Fixed source builds silently sharing installed-app state, and fixed migration recovery proceeding without verifying the launcher, database identity, backup, and user-selected recovery path.
- Fixed Kilo removal leaving legacy provider kinds, favorite selections, or editor-tab state that could no longer be opened.
- Fixed ACP session-load replay being projected as fresh user-visible activity before the restored session was ready.
- Fixed native provider resume being attempted when the selected runtime could not safely support it.
- Fixed Claude Auto selection accepting near matches for the wrong context window and fixed provider usage remaining stale after a compaction boundary.
- Fixed long-message continuation losing or repeating text, accepting a stale message revision, or splitting Unicode content at an unsafe offset.
- Fixed side-chat panes losing their durable parent relationship or active lease after refresh, expiry reconciliation, archive, or unarchive.
- Fixed pull-request attribution using neighboring workspace state instead of the owning task's thread-specific Git context.
- Fixed task created-at ordering drifting after updates and reconciliations.
- Fixed numbered terminal shortcuts selecting the wrong terminal when multiple sessions were open.
- Fixed missing relative workspace references rendering as actionable chips and valid absolute paths losing their file-badge affordance.
- Fixed Copy Path operating through the wrong desktop action and added a platform-native Reveal in Finder path on macOS.
- Fixed dot-prefixed images, attachments, previews, plugins, favicons, and generated files being rejected as extensionless or unsafe despite having an intentional name.
- Fixed numeric PDF destinations being ignored or misclassified instead of resolving to a page.
- Fixed untrusted `__proto__`, `prototype`, and `constructor` keys being able to cross object-decoding boundaries and influence inherited state.
- Fixed Windows drive-relative paths being treated like safe absolute paths while preserving legitimate drive roots and UNC behavior.
- Fixed payload and stream limits counting JavaScript characters instead of UTF-8 bytes, including split multibyte characters at a boundary.
- Fixed IPv4-mapped IPv6 addresses bypassing local-network and destination policy checks.
- Fixed empty agent-mention payloads and empty terminal chunks at a size limit producing ambiguous lifecycle behavior.
- Fixed Bun close-listener handling conflating distinct listener registrations during process settlement.
- Fixed delivery-block boundaries accepting one event beyond the configured limit or dropping the event that established the boundary.
- Fixed malformed, negative, fractional, or unbounded `Retry-After` values controlling provider retry scheduling.
- Fixed provider credential temporary files sharing predictable locations instead of using isolated, lifecycle-owned temporary paths.
- Fixed legacy workspace fallback state and malformed shared local-storage preferences surviving after their owning state was cleared.
- Fixed Windows home paths displaying in expanded or inconsistent forms across provider and workspace surfaces.
- Fixed provider prerelease versions losing hyphenated identifier segments during comparison and update checks.
- Fixed POSIX updater shutdown terminating the backend too abruptly for ordinary cleanup and state settlement.
- Fixed Electron builds remaining on a release line affected by CVE-2026-70608.

### Contributors

- Thanks to Emanuele Di Pietro, Chara (`cmdr-chara`), NachoooLK, Leonardo Bassanello (`xFurti`), Kartik (`kartikkabadi`), Tasi Balázs (`balazstasi`), Keyur (`keyurbodar`), and `sanirudh17` for the commits and merged pull requests included in this release.

### Verification

- `bun run fmt:check` passed across 16,081 files.
- `bun run lint` passed with 489 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; two existing Effect Schema suggestions remained informational.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful; existing deprecation, plugin-timing, stale Browserslist, and large-chunk advisories remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 3m19.63s. Web passed 336 files / 4,216 tests. Server/CLI passed 378 files / 4,387 tests with 3 skipped files / 16 skipped tests. No targeted rerun or flaky product failure was needed.

## 0.7.3 - 2026-08-21

### Added

- Added a desktop quit confirmation that lists every running or connecting chat before Synara closes, with Cancel and Quit actions and a persisted "Resume chats automatically" choice.
- Added durable quit-resume records: confirmed quits snapshot exact in-flight turn identities before interruption, consume the record once at next startup, and dispatch one ordinary continuation only when the task and project are still eligible and unchanged.
- Added a draggable, eight-way resizable browser panel that floats over the owning conversation, shares its existing browser tabs and cookies, stays clamped to the visible chat surface, and can move back into the right sidebar without creating a second live guest.
- Added provider-usage adapters and UI coverage for Antigravity, Cursor, Grok, OpenCode, and locally authenticated providers, extending the existing Codex and Claude usage views to every signed-in provider Synara can verify.
- Added provider-specific usage explanations for runtimes that expose local authentication but no machine-readable personal quota, plus shared caching, cooldown, stale-snapshot, pacing, and learn-more behavior.
- Added first-class Windows WSL workspace launching: `\\\\wsl.localhost` and `\\\\wsl$` paths resolve to `wsl.exe --distribution <distro> --cd <linux-path> --exec ...`, and ACP session payloads receive the corresponding Linux cwd.
- Added a custom title-bar preference for Windows and Linux under Settings → Appearance, including native window controls, persisted boot-time frame selection, explicit restart-required state, and a one-click relaunch action.
- Added `synara-server-<version>.tar.gz` to GitHub releases, built from the staged server package and bundled web client alongside the desktop artifacts.
- Added `synara server status`, with persisted-runtime discovery, explicit `--url`, optional `--json`, runtime identity verification, `/health` projection readiness, a three-second bounded probe, and a non-zero exit when the server is not ready.
- Added cross-provider side chats through `/side <provider> <prompt>`, accepting provider kinds or display names, validating installed targets, and retaining the guarded source-thread relationship.
- Added shell-visible Windows ICO generation and refresh support so runtime app-icon changes propagate to the taskbar and revert cleanly to the default icon.

### Changed

- Reduced renderer and GPU work during live output by removing repeated array scans, narrowing runtime-event projections, avoiding redundant visual effects, and pausing sidebar spinner animation while hidden.
- Reduced Git-stat overhead by aggregating repository statistics in one pass and avoiding repeated work across unchanged inputs.
- Trimmed idle Codex discovery processes sooner while restarting their grace period after real catalogue requests, reducing process-tree memory without interrupting active discovery.
- Reworked workspace search presentation and ranking with fuzzy match emphasis, head-clipped parent paths, direct directory opening, stable memoized rows, a 30-result mount bound, 100 ms server-query debounce, and short-lived query reuse.
- Extended Antigravity activity handling so tool cards stream as the provider emits them, completed turns settle without a reload, subagent activity routes to child tasks, and background tasks keep the CLI alive until the real terminal outcome.
- Aligned Grok reasoning choices with each live CLI model ladder and kept Cursor's fast-mode/Grok-HIGH controls from remaining active after their toggles are turned off.
- Sorted Claude models by live catalogue order, widened provider picker menus, and made provider metadata exhaustive at compile time.
- Refined the empty landing surface, composer borders, muted task labels, disclosure contrast, translucent sidebar seams, and light/dark overlays around one consistent shell treatment.
- Restyled the running-chat quit dialog to match the command palette and refined its keyboard, disabled, overflow, and progress states.
- Extracted the browser tab strip into a focused component and made new-tab selection preserve the current tab context and ownership more predictably.
- Refreshed the README and internal architecture, provider, CI, packaging, quick-start, and workspace-layout documentation to match the shipped runtime.
- Bumped Synara release package versions to `0.7.3` across server, desktop, web, and contracts packages and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed desktop shutdown silently interrupting active work without naming the affected chats or offering a guarded continuation on next launch.
- Fixed quit-resume races by writing before the renderer allows shutdown, bounding the acknowledgement wait, expiring records when a quit is abandoned, atomically claiming records at startup, and rechecking each continuation precondition inside serialized dispatch.
- Fixed assistant replies that completed in the background remaining hidden until reload; terminal fences now remain attached until the final post-settle assistant reply is projected.
- Fixed floating browser resize, drag, tab, and dock transitions that could move the native guest outside its host, leave two surfaces competing for the live guest, or forget the requested task across route changes.
- Fixed Antigravity background tasks being interpreted as an immediate terminal CLI outcome and killed before their real completion event.
- Fixed OpenCode raw assistant deltas being dropped from streamed replies.
- Fixed Cursor fallback model options disappearing and fast/Grok-HIGH state staying active after the corresponding control was disabled.
- Fixed Grok drafts restoring an unsupported `Extra High` effort and custom models accepting efforts outside their advertised ladder.
- Fixed provider usage refreshes losing useful evidence during transient errors or rate limiting, and isolated provider-specific authentication and quota parsing from the rest of the catalogue.
- Fixed `cmd.exe`-style launches being used for WSL UNC workspaces; commands now execute inside the owning distribution and ACP receives a Linux path instead of a Windows UNC cwd.
- Fixed local-folder mentions rejecting UNC paths, the project browser misreading Windows home paths, and Windows workspace comparisons treating case-only differences as different roots.
- Fixed runtime Windows taskbar-icon changes updating Electron state without producing a shell-visible ICO or refreshing Explorer's cached icon.
- Fixed custom title-bar preferences drifting between renderer settings and the frame state read before `BrowserWindow` creation.
- Fixed permanent task deletion reclaiming unowned worktrees; cleanup now preserves paths Synara does not own while still removing eligible managed worktrees.
- Fixed duplicate approval responses being accepted after reconnect or retry by persisting idempotency at the orchestration decider.
- Fixed malformed feature-flag storage leaving stale values cached instead of returning to canonical defaults.
- Fixed diagnostic resume cursors being accepted beyond the current high-water mark.
- Fixed WebSocket authentication tokens being appended to off-origin URLs and duplicate HTTP Origin headers being accepted.
- Fixed quoted, wrapped, truncated, serialized, reordered, compact, URL-embedded, shell-composed, and unterminated secret values leaking through process or provider diagnostics.
- Fixed restricted provider children inheriting OpenAI credentials and private scratch workspaces being recovered or reused without revalidating ownership, location, and restrictive permissions.
- Fixed diagnostic sanitizers performing unbounded traversal, losing safe JSON number tokens, or ambiguously interpreting command substitutions and partial assignments.
- Fixed process output and bounded stream truncation breaking UTF-8 characters split across buffer boundaries.
- Fixed multi-dot attachment names losing their final extension during content-type normalization.
- Fixed normalized provider command-not-found errors being misclassified and malformed Claude authentication JSON being treated as usable state.
- Fixed Codex prerelease versions losing hyphenated suffix segments during compatibility checks.
- Fixed route restoration applying a stale snapshot after a newer refresh had already won, and fixed large-state projection repair repeatedly resnapshotting while an existing repair was in flight.
- Fixed workspace search opening stale or poorly ranked results, clipping the most useful part of long paths, and mounting more result rows than the palette can display.
- Fixed project script shortcuts disappearing from the empty landing tray before a first chat was created.
- Fixed the iOS Simulator helper failing to locate SimulatorKit after its Xcode 27 beta framework move.
- Fixed browser policy copy that incorrectly implied localhost and `file:` navigation were universally blocked.
- Fixed merged CI fixtures for Antigravity retention, scratch-workspace cleanup, platform-specific geometry, and release-smoke coverage after the server tarball job was added.
- Reverted the experimental DeepSeek Harness provider before release; v0.7.3 does not advertise or ship that provider.

### Contributors

- Thanks to `xFurti`, `cmdr-chara`, `diliprt`, `sebbonit`, `D3nnis72`, `rogalio`, `sanirudh17`, `kartikkabadi`, `aristotl-dylan`, and `HumanInTheLoopReal` for the provider, platform, browser, runtime, documentation, performance, and reliability work merged into this release.

### Verification

- `bun run fmt:check` passed across 15,979 files.
- `bun run lint` passed with 451 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing Effect informational messages were reported.
- `bun run release:smoke` passed across the 1,448-package dependency graph after rerunning with normal temporary-directory access.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecation, plugin-timing, and large-chunk advisories remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 3m9.669s. Web passed 320 files / 4,029 tests. Server/CLI passed 355 files / 4,060 tests with 3 skipped files / 16 skipped tests. No targeted rerun or flaky product failure was needed.

## 0.7.2 - 2026-08-15

### Added

- Added a live iOS Simulator pane to the right dock on macOS, with device selection, first-run setup guidance, live H.264 video, direct mouse and keyboard input, hardware controls, screenshot and recording actions, and automatic pane opening when an agent launches an app.
- Added provider-agnostic device tools for listing, booting, installing, launching, opening URLs, tapping, swiping, typing, pressing buttons, taking screenshots, reading the accessibility tree, and scrolling to named elements, with explicit approval boundaries for input and URL actions.
- Added persistent thread goals with a stacked composer panel, elapsed-time tracking, pause and resume controls, achievement history, message-footer badges, provider prompt injection, and MCP read/write support.
- Added autonomous goal continuation after clean turn completion, including startup recovery, user-queue priority, plan and interaction gates, pause-on-interrupt or failure behavior, terminal-session retries, and an explicit blocked state to prevent endless retries.
- Added an evidence-first Debug interaction mode built around observe, reproduce, investigate, fix, and verify, with `/debug` and `/default` commands, draft and fork persistence, provider-wide prompt budgeting, and structured reproduction questions where supported.
- Added workspace-wide file search with `Cmd/Ctrl+P` and grep-style content search with `Cmd/Ctrl+Shift+F`; results include paths, line numbers, matching snippets, keyboard navigation, and direct opening in the right-dock file pane.
- Added stacked pull-request support with stack position badges, ordered stack navigation, stack-aware readiness and merge confirmations, GitHub async-merge polling, fallback compatibility, and repository-wide cache refresh after stack mutations.
- Added message-level thread forking, visible fork-source dividers, source-aware fork titles, and native session forks across Claude, Cursor, Droid, Grok, and OpenCode in addition to Codex.
- Added configurable chat-width presets for focused, standard, and wide transcript layouts.
- Added file-link context actions for copying paths, opening files in Synara, and revealing supported references in the workspace.
- Added reproducible production-path streaming benchmarks covering reducer, store, selector, derivation, layout, frame, and flush behavior.
- Added a dark-mode macOS dock icon that follows system appearance automatically.

### Changed

- Reworked the iOS Simulator integration around a source-shipped Swift/Objective-C helper compiled with the user's selected Xcode, source-digest cache invalidation, a deny-by-default Seatbelt profile, bounded binary WebSocket framing, slow-client frame dropping, and persisted ownership recovery after crashes.
- Changed thread goals from passive labels into durable objectives that remain intact across turns, provider retries, subagent steering, restarts, and user edits while giving queued user work precedence over automatic continuation.
- Replaced automation's single stop-on-error switch with a durable consecutive-failure threshold that defaults to three, can be disabled, records failure counts and disable reasons, resets after success, and requires deliberate re-enabling after failure shutdown.
- Reworked automation creation and editing with inline schedule and policy fields, risk confirmation, clearer disabled-state explanations, optimistic concurrency retries, and preservation of user edits when scheduler updates race the form.
- Improved large-database startup by preserving the SQLite primary-key range scan during projector replay and tuning bounded cache and memory-map settings; measured replay on the documented 2.9 GB fixture dropped from minutes to about 24 seconds.
- Reduced visible streaming work by batching text commits, stabilizing transcript tail keys, coalescing highlight scroll work, skipping irrelevant overlap measurements, caching message-trail projections, narrowing Zustand selectors, and backing off idle reconciliation polls.
- Reordered assistant message presentation so text segments and tool rows follow provider event order, compacted reasoning anchors to its first update, task-list progress collapses into one evolving row, and the turn changes card appears before assistant footer actions.
- Centralized native fork behavior and provider-input composition, added capability and in-flight-turn checks, preserved resumability metadata and turn counts, and retained transcript reconstruction as the safe fallback when a provider cannot fork natively.
- Consolidated commit, push, and pull-request dialogs around shared Git action chrome, made primary actions more direct, preserved disabled reasons, and aligned action glyphs and message controls.
- Changed provider selection to show installed providers, warm each available provider's model catalogue for new threads, and resolve prefetch paths from explicit worktree intent and real availability.
- Improved model and usage discovery by isolating malformed descriptors, exposing Pi's maximum thinking level, bounding Codex archive reads to 64 KiB tail chunks, and humanizing unknown rate-limit windows.
- Improved cross-platform presentation with runtime Windows taskbar-icon refresh, simpler sidebar control icons, refined fork and message-action glyphs, and day-aware message timestamps.
- Hardened release automation with least-privilege token permissions, explicit clean-lane policy checks, deterministic Windows dependency installation, and version-scoped unsigned-Windows publication support.
- Bumped Synara release package versions to `0.7.2` across server, desktop, web, and contracts packages and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed stale-generation terminal events being dropped instead of settling the owning turn, including terminal-session retry behavior for paused goal continuations.
- Fixed oversized Pi and other provider runtime payloads being quarantined wholesale; payloads are now bounded and truncated while preserving the event and its diagnostic meaning.
- Fixed previously unmapped provider events disappearing from the transcript by surfacing a bounded fallback row with captured diagnostic context.
- Fixed OpenCode running-tool titles persisting leading or trailing whitespace and lifecycle-detail parsing rejecting otherwise valid untrimmed tool output.
- Fixed assistant text being grouped apart from intervening tool activity, compacted reasoning attaching to its final update, and repeated task-list progress producing a noisy stack of rows.
- Fixed streamed text repeatedly re-arming bottom-stick behavior, trail highlights scheduling redundant scroll work, and overlap checks reading layout when only the live tail grew.
- Fixed projection cursors entering a permanent resnapshot loop when a page made no progress, and preserved retry backoff when a newer snapshot superseded an older projection.
- Fixed large projector replays falling into an event-type index scan and temporary sort for every page instead of using the integer primary-key range.
- Fixed queued-turn promotion losing durability across replay and restart, and fixed goal continuation races that could resurrect paused work, outrank queued user input, or loop after failures and timeouts.
- Fixed automation failures being double-counted during duplicate reconciliation, concurrent scheduler writes overwriting edits, manual reruns clearing failure evidence, and legacy run threads or max-iteration stops lacking durable source and reason metadata.
- Fixed new-chat drafts being lost across thread switches, saved-draft races during automation setup, and new-thread model prefetch using the wrong cwd or warming unavailable providers.
- Fixed branch context being lost when switching or resuming threads, sends continuing against a transient branch mismatch, and the chat header hiding Pull when the current branch is behind upstream.
- Fixed the Git diff preview retaining the previous file after selection changed, commit/push controls losing their disabled explanation, and worktree cancellation losing its durable UI state.
- Fixed Windows Bun PTY startup, taskbar icons not refreshing after runtime icon changes, macOS quit intent being lost when updater shutdown failed, and valid empty desktop snapshots triggering a repair loop.
- Fixed malformed provider model descriptors invalidating otherwise healthy catalogues, warm model discovery covering only one provider, and Pi's highest supported thinking level being omitted.
- Fixed Codex usage polling loading entire archives and risking backend heap growth; archive scans now read backward in bounded chunks, split CRLF records correctly, and skip oversized trailing records without retaining them.
- Fixed file and snippet search escaping the active workspace scope, stale queries opening the wrong result set, and search palette presentation retaining unnecessary surrounding UI.
- Fixed iOS Simulator helper first-run deadlocks, stale attachments acknowledging input against dead boots, silent undelivered HID events, out-of-bounds taps being clamped, helper cache staleness, and Synara-owned simulators being orphaned after crashes.
- Fixed source-control and transcript polish issues including footer ordering, misleading rate-limit labels, day-ambiguous timestamps, and inconsistent action-icon alignment.
- Fixed a release-blocking TypeScript mismatch in the Codex usage tail-read test by explicitly typing the positional `FileHandle.read` spy calls without weakening runtime assertions.

### Verification

- `bun run fmt:check` passed across 15,903 files.
- `bun run lint` passed with 426 warnings and 0 errors.
- The first `bun run typecheck` identified one release-blocking tuple-overload error in `apps/server/src/providerUsageSnapshot.test.ts`; the test typing was corrected, its focused suite passed 3/3, and the full rerun passed all 7 packages.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecation, plugin-timing, and large-chunk advisories remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 2m56.443s. Web passed 311 files / 3,944 tests. Server passed 334 files / 3,826 tests with 3 skipped files / 16 skipped tests. No targeted rerun or flaky product failure was needed.

## 0.7.1 - 2026-08-09

### Added

- Added editable Explorer previews with dirty-state tracking, guarded saves, path validation, and clearer file breadcrumbs for focused code and text edits inside Synara.
- Added a complete commit-push-create-PR workflow with draft or ready-for-review actions, progress-aware controls, safer upstream handling, and post-action refresh that cannot hold the successful Git action open.
- Added live thread Git metadata propagation so branch, worktree, push, and pull-request changes made during a turn update task state without waiting for a later manual refresh.
- Added worktree setup progress, cancellation before dispatch, and a local-checkout action, while restoring automatic branch creation and attachment for worktree tasks.
- Added Codex thread forks for imported history while preserving source-thread provenance.
- Added server-side provider usage caching and one shared batch query for sidebar and Settings usage surfaces, including refresh joining, identity fencing, throttling, and retention of the latest healthy snapshot.
- Added customizable desktop app icons with persisted renderer-startup selection and native-style macOS artwork, plus a compact visual theme picker in Settings.
- Added in-app release history to the sidebar Help menu and a shortcut for copying the active task ID.
- Added reproducible performance harnesses for provider-runtime journal appends, orchestration replay, and the web transcript hot path.

### Changed

- Changed desktop backend readiness from a fixed deadline to a cancellable uncapped wait, so large histories and slow migration or replay work do not become false startup failures.
- Reworked WebSocket reconnects with cancellable bounded backoff and strengthened late-event reconciliation after the backend becomes available.
- Prefiltered orchestration replay in SQL before payload decoding and scoped runtime event persistence to avoid duplicate or irrelevant replay work.
- Reduced steady-state runtime and transcript work with adaptive polling, selective thread-detail subscriptions, reference-counted keyed locks, and more focused event ingestion.
- Serialized and coalesced Git refreshes per checkout, detached terminal Git action success from metadata refresh, and added bounded retry handling when expensive WebSocket read capacity is saturated.
- Improved branch, worktree, and pull-request recognition, including configured-model branch naming, mid-turn VCS propagation, merged-PR badge repair, and more reliable comment metadata parsing.
- Consolidated provider usage around server-owned credential and snapshot lifecycle handling for Claude, Codex, and Cursor, with safer keychain fallback and refresh-token behavior.
- Improved provider session startup, cancellation, resume, and settlement across Codex, Claude, OpenCode, Grok, Kilo, Antigravity, and ACP adapters.
- Refined live transcript status so Loading covers only unacknowledged sends, Working remains visible through the first-send gap, and takeover or lost acknowledgements cannot leave the composer spinner stuck.
- Guarded streaming timeline rows against painted overlap while preserving the simpler non-virtualized path for ordinary conversations.
- Improved project-picker search focus, shared picker composition, conditional keybinding edits, terminal exit shortcuts, and shortcut Settings layout.
- Refined translucent sidebar and floating-composer surfaces, strengthened production backdrop-filter preservation and fallbacks, and aligned icon and theme preview presentation.
- Changed the shared toast default to 10 seconds while retaining explicit persistent notices, and moved thread errors from inline banners to the common error-toast path.
- Bumped Synara release package versions to `0.7.1` across server, desktop, web, and contracts packages and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed desktop startup failing after a fixed wait even though backend migration, replay, or readiness work was still making progress.
- Fixed late renderer reconnects exhausting a short retry window and missing a backend that became healthy afterward.
- Fixed orchestration replay decoding and projecting large volumes of events that could not affect the requested snapshot, and duplicate runtime events being persisted during reconciliation.
- Fixed commit, push, and PR actions appearing stuck after Git succeeded because post-action refresh competed for expensive read capacity.
- Fixed stale Git refresh coalescing, upstream refresh bursts, task branch and PR recognition, and merged pull requests retaining an open badge.
- Fixed Explorer previews being read-only, ambiguous save failures, unsafe path assumptions, and file headers losing useful breadcrumb context.
- Fixed transient Grok fresh-session storage failures and Kilo credential startup failures without broad retries that could duplicate an already-started turn.
- Fixed OpenCode host policy being lost after resume, Windows `.cmd` shims failing to spawn, inline API keys not counting as credentials, and Antigravity model TSV parsing regressions.
- Fixed Antigravity cancellation and clean-stop settlement, Grok ACP authentication and permission handling, AskUserQuestion response recovery, and provider handoff eligibility.
- Fixed Expo and Metro local servers being title-probed as web pages unless the project actually runs Expo with `--web`.
- Fixed Windows terminal activity polling, side-chat terminal keybinding exits, and natural process-tree changes being misclassified.
- Fixed send spinners and Loading labels surviving lost stream acknowledgements, live-turn takeover, or post-ack lifecycle gaps.
- Fixed streaming timeline rows overlapping after layout changes and reduced feedback between measurement, follow-scroll, and non-message tool activity.
- Fixed malformed GitHub-flavored Markdown table delimiter rows, image overlays rendering below the native browser, and pull-request comment metadata parsing inconsistencies.
- Fixed production CSS stripping `backdrop-filter`, composer transparency fallbacks overriding native window behavior, and several icon-preview sizing and inset-artwork inconsistencies.
- Fixed conditional keybinding edits replacing unrelated bindings, terminal exits being routed through the wrong shortcut path, and project search failing to focus when opened.

### Verification

- `bun run fmt:check` passed across 15,761 files.
- `bun run lint` passed with 405 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing Effect Schema informational messages and Astro/Vite deprecation notices remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph. Its first restricted-sandbox attempt could not write Bun's temporary lockfile workspace; the required rerun with normal temporary-directory access passed.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecation, plugin-timing, and large-bundle advisories remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 3m8.811s. Server/CLI passed 304 files / 3,408 tests with 2 skipped files / 7 skipped tests. No targeted reruns or flaky failures were needed.

## 0.7.0 - 2026-08-05

**A review of the Synara codebase found an analytics configuration that came from the original T3 Code codebase when Synara was created as a clone in March. We did not add it, and we have no access to the PostHog project receiving the events.**

**The configuration has been removed. Synara no longer sends remote product analytics. The events did not include prompts, source code, filenames, or file contents.**

**We're sorry this wasn't caught earlier**

## 0.6.7 - 2026-08-05

### Added

- Added GitHub project import to the create-project dialog so a repository URL or `owner/repo` name can be cloned and registered through the user's GitHub CLI access, with validated destination names, progress reporting, compatible-checkout reuse, cancellation, and interruption-safe recovery.
- Added scoped terminal-to-composer registration so Add to chat actions from the terminal drawer or right dock deliver selected output to the adjacent conversation instead of whichever composer was most recently active.
- Added safe relocation for image, PDF, and workspace-file references that resolve outside the current project after a workspace or checkout path changes.

### Changed

- Consolidated side-chat creation into one tested workflow with prompt deduplication, snapshot retention, activation recovery, simpler dock navigation, and a clearer side-chat tab experience.
- Hardened provider runtime ingestion, command reconciliation, pending-interaction projection, and session recovery so delayed or replayed lifecycle events converge on durable turn state.
- Reduced background transcript work by narrowing thread-detail subscriptions and snapshot queries to the conversations that need live detail while retaining visible and docked task state through refresh races.
- Improved terminal lifecycle handling so a natural shell exit clears activity and closes only the exited tab without a destructive-close confirmation, placeholder cleanup, or duplicate fallback exit command.
- Gave temporary-thread user messages a distinct dashed outline while preserving the final message-bubble geometry.
- Bumped Synara release package versions to `0.6.7` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed unreplayable runtime commands being reconsidered after restart; terminal or otherwise non-replayable work is now quarantined and reconciled explicitly.
- Fixed side-chat creation races that could duplicate the seed prompt, lose retained detail, activate the wrong route, or leave dock state out of sync with the created task.
- Fixed terminal Add to chat actions routing to the wrong composer and naturally exited terminals retaining activity, showing destructive-close prompts, or issuing a second exit command.
- Fixed foreground completion notifications appearing while Synara or its native browser pane already had the user's attention, and aligned toast visibility with side-chat split and dock routes.
- Fixed stale provider update notices by retrying refreshes on focus, strengthening refresh scheduling, and preserving verified provider availability while checks overlap.
- Fixed delayed runtime and pending-interaction events settling the wrong request, overwriting newer lifecycle state, or leaving task projections inconsistent after recovery.

### Verification

- `bun run fmt:check` passed across 15,714 files.
- `bun run lint` passed with 372 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing Effect Schema informational messages and Astro/Vite deprecation notices remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecation and plugin-timing notices remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 3m0.871s. Web passed 285 files / 3,541 tests; server/CLI passed 296 files / 3,271 tests with 2 skipped files / 7 skipped tests. No targeted reruns or flaky failures were needed.

## 0.6.6 - 2026-08-04

### Added

- Added visible-browser element inspection to the annotation workflow, with clearer geometry and presentation context for the exact page element a user wants changed.
- Added a dedicated voice-processing benchmark and a streamlined recording-encoding path to keep Mic mode work off the main interaction path.
- Added installed Claude plugin-skill discovery with deterministic install precedence and Windows-safe path containment.

### Changed

- Rebuilt browser annotations so markers survive hash navigation and compatible document-key transitions, collapsed targets are handled safely, invalid submissions are rejected, and overlay, inspector-radius, action-icon, and review-label presentation is more consistent.
- Improved Mic mode with earlier transcription prewarming, safer startup and shutdown sequencing, guarded authentication and upload admission, clearer stop/send presentation, reliable fallback transcription, and cancel behavior that discards the recording.
- Improved provider model discovery and selection by normalizing Pi extension metadata without losing resolvable identities, distinguishing favourite models by provider, and preserving accessible model-cost context.
- Bounded deferred chat mounting and changed sent-message anchoring from a teleport or asymptotic chase into a tested fixed-duration glide using one monotonic clock.
- Refreshed recent activity, browser-opening workflows, desktop chrome/zoom behavior, and sidebar state projection so application surfaces converge more predictably after delayed runtime updates.
- Bumped Synara release package versions to `0.6.6` across the server, desktop, web, and contracts packages.

### Fixed

- Fixed Claude and OpenCode human-interaction requests lingering, reappearing, settling across the wrong turn, or clearing before the provider acknowledged a permission reply.
- Fixed interrupted and errored turns being reported as successful completions, stale session snapshots settling active turns, and completion notifications duplicating when status or timestamps changed.
- Fixed annotations losing markers during hash navigation, accepting collapsed selections, mishandling compatible legacy document keys, rendering elliptical corner radii incorrectly, or using an inconsistent overlay surface.
- Fixed deferred conversations waiting indefinitely to mount and transcript anchor motion reversing, jumping, or completing without visible movement.
- Fixed similarly named favourite models from different providers collapsing into one choice and malformed Pi extension metadata making discovered model identities unresolvable.
- Fixed checkpoint capture using a stale index or replacing the preserved index timestamp during refresh.

### Verification

- `bun run fmt:check` passed across 15,692 files.
- `bun run lint` passed with 367 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing Effect Schema informational messages and Astro/Vite deprecation notices remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecation and plugin-timing notices remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 3m2.534s. Web passed 281 files / 3,489 tests; server/CLI passed 293 files / 3,221 tests with 2 skipped files / 7 skipped tests; desktop passed 57 files / 558 tests with 1 skipped file / 5 skipped tests; shared passed 49 files / 478 tests with 1 skipped test; contracts passed 17 files / 189 tests; scripts passed 13 files / 85 tests. No targeted reruns or flaky failures were needed.

## 0.6.5 - 2026-08-02

### Added

- Added a sidebar Activity view that acts as a compact task inbox for running work, input requests, failures, and recently settled tasks, with project grouping, project-scoped filters, pinned rows, urgency-aware ordering, and a persistent cross-tab view preference.
- Added focused transcript-scroll cancellation coverage so user input can stop both native smooth scrolling and virtual-list bookkeeping at the currently visible offset.

### Changed

- Refined Activity rows into a denser two-line presentation, renamed settled work to Done, kept urgent state visible on completed rows, and made new-chat creation use the latest project relevant to the current Activity scope.
- Improved session orchestration, runtime activity attribution, workspace-root resolution, and worktree handoff metadata so conversation and cwd-bound surfaces converge sooner after delayed lifecycle events or repository changes.
- Improved browser tool presentation, sidebar surface-picker styling, thread hover-card active states, and accessible Search targeting.
- Bumped Synara release package versions to `0.6.5` across the server, desktop, web, and contracts packages.

### Fixed

- Fixed transcript auto-scroll continuing after user takeover, late smooth-scroll completion snapping a replaced conversation, and tail settling fighting direct viewport input.
- Fixed Activity ordering and status indicators drifting as tasks settle, stale project scopes hiding available work, pinned rows ignoring the active project filter, and empty states retaining expired settle overrides.
- Fixed composer image preparation edge cases by bounding resize attempts, correcting worker message handling, and hardening unsupported or oversized attachment intake.
- Fixed worktree handoffs briefly leaving file preview, explorer, or terminal surfaces pointed at the previous checkout.
- Fixed thread hover cards losing their active treatment while hovered and improved dense sidebar state readability.

### Verification

- `bun run fmt:check` passed across 15,678 files after formatting three release-delta files.
- `bun run lint` passed with 364 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages after fixing two release-blocking exact-optional/narrowing errors; only existing informational and deprecation notices remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph. Its first sandboxed attempt was blocked from writing a temporary package workspace; the unrestricted rerun passed.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecations and plugin timing notices remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 3m4.522s. The first sandboxed run failed four `packages/shared/src/Net.test.ts` cases because loopback binding returned `EPERM` and then terminated sibling workers; the complete unrestricted rerun passed. Web passed 279 files / 3,442 tests; server/CLI passed 292 files / 3,193 tests with 2 skipped files / 7 skipped tests. No flaky product test was identified.

## 0.6.4 - 2026-08-01

### Added

- Added provider-agnostic browser automation backed by Synara's shared visible Electron WebView. Supported agents can inspect bounded semantic snapshots, capture screenshots and diagnostics, navigate tabs, click, hover, drag, type, select, press keys, scroll, wait for page conditions, evaluate bounded expressions, handle dialogs, upload workspace-relative files, and observe explicit popup, download, timeout, and host-boundary states without creating a hidden browser.
- Added DOM annotations for the visible browser so users can select one or more page elements, attach optional comments, and send precise, compact context through the composer. Annotation transport is versioned, count- and field-bounded, keeps exact-page affinity local, and strips document-only metadata before provider injection.
- Added provider-aware runtime modes and Auto/auto-approval support across the orchestration, automation, gateway, Codex, Claude, and ACP paths. Approval-required, Auto, and Full access selections now carry capability checks, privilege limits, and explicit pending-approval state.
- Added a right-dock launcher for opening Review, Terminal, Browser, Files, Side chat, and Source control panes from one place, with keep-mounted live panes and project/repository-aware availability.
- Added negotiated transport capabilities: a single connect handshake, authenticated WebSocket `permessage-deflate`, cursor-resumable delta subscriptions with safe snapshot fallback, and precompressed web assets with cache headers and identity fallback.
- Added repository PR-template discovery so generated pull-request bodies can follow the selected repository's `.github` template while retaining the existing fallback format when no applicable template exists.

### Changed

- Reworked transcript tail following around one shared anchor path for estimated and virtualized rows, sent-message reveals, native browser end-space, and fast streaming. Auto-follow is now driven by real transcript messages rather than tool rows, measurements, buffering, or reconnect-only activity.
- Added native turn steering for Codex and Claude while preserving queued follow-ups as an explicit alternative. Provider commands, lifecycle generations, runtime activity, child work, sent messages, live answers, and terminal events now retain the correct turn identity through late, replayed, interrupted, and restarted sessions.
- Changed thread hydration and reconnect behavior to use durable projections directly, resume detail from high-water cursors when safe, re-arm refreshes after snapshot races, retry missing snapshots after timed-out turn starts, and keep provider notification drains alive until a session settles.
- Improved runtime-mode and model pickers with capability-aware options, clearer effort labels, Claude model discovery on cold starts, and thread hover-card details for the active provider and model.
- Changed Environment and Git action presentation so branches behind upstream surface Pull before commit, push, or PR actions, using one consistent working-tree and upstream state model.
- Recovered missed draft promotions during event routing and capped stacked composer panels so large agent fleets cannot hide the composer.
- Bumped Synara release package versions to `0.6.4` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed tail-anchor overshoot, sent-message jumps, stale estimated-row offsets, and viewport loss while virtualized messages reveal or provider responses stream.
- Fixed native steering activity projection and turn settlement when provider updates arrive late, are replayed, or use an unknown self-update status.
- Fixed session startup and local dispatch acknowledgement races, hydration recovery that could render an empty visible task, and timed-out turn starts that failed to retry a missing snapshot.
- Fixed provider notification pumps that could be disposed too early, leaving later session events unobserved, and fixed Antigravity inactive `PreToolUse` hooks that did not receive a decision.
- Fixed runtime stalls that could kill active turns, including provider lifecycle and browser-host boundary cases; bounded browser input, navigation, semantic snapshot, file-transfer, and teardown paths so failures remain attributable to the correct tab and task.
- Fixed browser annotation metadata handling, stale annotation validators, contenteditable descendant redaction, id-less timeline estimates, draft promotion, and browser-to-composer contract gaps.
- Fixed Tailwind scanning for utility-class overrides and updated browser/desktop protocol boundaries so the visible browser cannot be mistaken for a separate or privileged host surface.
- Fixed right-dock activation and pane-state races that could lose a draft or unmount live terminal state when switching tools.

### Verification

- `bun run fmt:check` passed across 15,652 files.
- `bun run lint` passed with 350 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing TS44 informational schema messages and Astro/Vite deprecation notices remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecations, plugin-timing notices, and large-chunk warnings remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 2m48.35s. Web passed 274 files / 3,378 tests; server/CLI passed 290 files / 3,185 tests with 2 skipped files / 7 skipped tests; desktop passed 55 files / 525 tests with 1 skipped file / 5 skipped tests; shared passed 47 files / 467 tests with 1 skipped test; contracts passed 17 files / 189 tests; scripts passed 13 files / 84 tests. No targeted reruns or flaky failures were needed.

## 0.6.3 - 2026-07-27

### Added

- Added explicit control, user, and normal orchestration lanes so stop, interrupt, and settlement commands drain ahead of new turns and background projection work without weakening reserved-capacity or shutdown admission rules.
- Added a compensating checkpoint-revert saga that captures the pre-revert worktree in a managed rescue ref and restores it if provider conversation rollback fails.
- Added deterministic, retryable revert completion and user-visible failure activities that identify retained rescue refs when manual recovery may be needed.
- Added bounded provider-command attempts and urgent lifecycle control so one unresponsive adapter or per-thread lock cannot stall every task.

### Changed

- Reworked provider lifecycle coordination and runtime reconciliation across Codex, Claude, Cursor, and ACP sessions so durable commands, terminal events, ownership, generations, and restart recovery converge on one session state.
- Unified checkpoint cwd resolution, validation, ref encoding, cleanup, and recovery behavior across file-only undo, conversation rollback, and edit-and-resend.
- Improved thread snapshot projection, visible-detail retention, store normalization, and refresh re-arming across lease, subscription, eviction, and reconnect races.
- Improved provider runtime activity attribution so late or replayed terminal events settle the intended turn without duplicating work-log output.
- Changed grouped file-change undo to revert every represented turn newest-first and stop on the first failure rather than silently leaving the card partially applied.
- Bumped Synara release package versions to `0.6.3` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed stop and interrupt actions being starved behind a saturated queue, rejected during overload, or blocked indefinitely by a wedged provider start.
- Fixed new turns being admitted while the orchestration engine was quiescing, which could orphan work during shutdown.
- Fixed Claude terminal results without live turn state leaving a thread permanently marked as running, and bounded Claude interrupt acknowledgements that could otherwise hang their caller.
- Fixed provider delivery timeouts holding the process-wide delivery lock forever; uncertain outcomes now settle explicitly for later reconciliation.
- Fixed checkpoint revert requiring a live provider session, diffing the wrong checkout, mutating before checkpoint validation, or trimming a provider conversation twice after a half-applied retry.
- Fixed invalid rescue-ref names for subagent thread identifiers, ineffective rescue-ref leak assertions, and unnecessary full-tree snapshots for no-op conversation rollbacks.
- Fixed stale Claude resumes leaving task chips stranded or retrying a native conversation that the provider had already reported missing.
- Fixed queued follow-ups being accepted while no real active turn existed, which could swallow the message instead of dispatching it.
- Fixed the newest live answer collapsing into a completed disclosure while provider terminal state was still converging.
- Fixed failed stop controls producing no visible explanation in the composer or keyboard shortcut path.
- Fixed visible thread details being evicted or losing a refresh race and temporarily rendering as an empty conversation.
- Fixed profile-stat cleanup purging soft-deleted threads without evidence of a manual delete, and retention sweeping archived or newly created fork and handoff threads because of inherited message timestamps.

### Verification

- `bun run fmt:check` passed across 15,536 files.
- `bun run lint` passed with 300 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only the existing TS44 informational schema messages remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful.
- Full `bun run test` passed with all 8 Turbo tasks successful in 11m14.547s. Web passed 264 files / 3,255 tests; server/CLI passed 279 files / 2,988 tests with 2 skipped files / 7 skipped tests. No targeted reruns or flaky failures were needed.

## 0.6.2 - 2026-07-27

### Added

- Added universal live tool activity across supported providers, with normalized running and settled states, consistent labels, expandable details, and transcript interactions.
- Added a configurable follow-up dispatch mode so messages sent during active work can either queue for the next turn or steer the current turn.
- Added an `Unblock thread` recovery action for provider-delivery quarantines; blockers are abandoned oldest-first and skipped turn starts are replayed without resending an ambiguous command.
- Added local customization for the Void space name and icon, including validation, reset behavior, and consistent presentation across the sidebar, Space switcher, project pickers, and project creation.
- Added dedicated automation-run handling, explicit completion policies, and authorized automation self-cancellation.
- Added bounded Electron renderer-crash recovery with reload limits and actionable recovery prompts.
- Added server-side working-tree diff statistics and shared unified-patch parsing so large diff totals no longer require transferring complete patches to the client.
- Added React Compiler parity coverage for chat, picker, hook, and shared UI hot paths.

### Changed

- Reworked reconnect reconciliation so provider status, active turns, work logs, and terminal thread projections converge to the server snapshot without stale refreshes winning races or settled tasks polling indefinitely.
- Batched stale thread-detail eviction and reconciled ownership across lease, reconnect, snapshot, and subscription-retention boundaries.
- Reduced startup and steady-state work by lazily loading provider and diff-parser dependencies, caching login-shell environment probes, reusing in-memory orchestration state, selectively preloading route chunks, and throttling supervised-process descendant scans.
- Hardened automation scheduling, projection, persistence, completion, and cancellation lifecycles for unattended work.
- Hardened desktop and server process management across executable discovery, shell-environment hydration, backend supervision, terminal wrappers, managed worktrees, Git status broadcasting, and replacement of stale processes.
- Enforced exclusive SQLite ownership and expanded verified retention, reclamation, and cleanup behavior for migration backups and interrupted update artifacts.
- Simplified subagent activity in the transcript and consolidated live and settled tool presentation around the shared work log.
- Reorganized Settings by user intent and consolidated shared settings cards, empty states, elevated surfaces, and hover styles.
- Improved completion notifications so bounded Markdown summaries preserve fenced and nested code, technical context, references, delimiters, and turn-scoped copy while remaining safe to render.
- Improved composer command-menu loading and empty states, shared picker styling, and React Compiler-friendly code paths.
- Bumped Synara release package versions to `0.6.2` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed universal tool rows that could duplicate, lose interactions, regress after settlement, or remain visually active after a tool or turn reached a terminal state.
- Fixed stale live thread projections after reconnect, including delayed refresh races, mismatched repair identity, stale terminal turns, and polling that continued after convergence.
- Fixed provider status disappearing or being replaced by stale data while a reconnect refresh was in flight.
- Fixed unowned thread details surviving lease, reconnect, and snapshot races.
- Fixed permanently quarantined threads that previously exposed the delivery blocker but offered no client recovery path.
- Fixed desktop renderer crashes that could leave Synara blank instead of recovering within a bounded retry policy.
- Fixed competing SQLite access that could proceed without proving exclusive database ownership.
- Fixed startup overhead from repeated shell probes, eagerly loaded provider SDKs and diff parsers, redundant orchestration reads, and over-frequent process-tree inspection.
- Fixed orphaned or interrupted migration artifacts not being reclaimed under the expanded retention policy.
- Fixed Windows `Ctrl+-` zoom behavior while preserving native menu shortcuts, browser-guest shortcuts help, and cross-platform shortcut boundaries.
- Fixed completion notifications that could flatten or truncate fenced code, nested inline code, Markdown references, technical detail, or delimiter-sensitive text.
- Fixed composer command-menu state transitions and exact-optional browser fixture typing when no empty-state label is supplied.
- Fixed completion-summary parsing when a closing inline-code run is absent.
- Fixed a default-parameter call in `ChatView` that caused React Compiler to bail out of a protected hot path.
- Fixed macOS release artifact builds exhausting Node's default heap while bundling the production web client.
- Fixed the landing project heading inheriting the wrong text color.

### Verification

- Final `bun run fmt:check` passed across 15,535 files.
- Final `bun run lint` passed with 296 warnings and 0 errors.
- Final `bun run typecheck` passed across all 7 packages after fixing two release-blocking exactness checks; only existing TS44 informational messages and Astro deprecation notices remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecations, plugin timing notices, and large-chunk warnings remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 10m58.197s after fixing one React Compiler bailout. Web passed 264 files / 3,250 tests; server/CLI passed 278 files / 2,951 tests with 2 skipped files / 7 skipped tests; desktop passed 39 files / 362 tests with 1 skipped file / 5 skipped tests; shared passed 41 files / 424 tests with 1 skipped test; contracts passed 13 files / 135 tests; scripts passed 13 files / 83 tests.
- Focused reruns passed for completion-notification logic (48 tests), the composer command menu (4 browser tests), and React Compiler hot-path parity (12 tests). No flaky test was identified.

## 0.6.1 - 2026-07-25

### Added

- Added guarded desktop recovery for the interrupted or partially applied migration state that could leave some 0.6.0 databases unable to start.
- Added migration-lineage validation and replay coverage, including a Windows CI gate for the recovery path.
- Added dynamic, state-specific icons to automation rows.
- Added a project picker directly to the new-task heading.

### Changed

- Simplified project, Space, and Studio navigation and normalized restored Studio workspace metadata so tasks reopen in the correct location.
- Refactored desktop backend supervision, shutdown, and process-tree teardown so replacement and restart only proceed after the previous runtime is proven stopped.
- Reduced redundant projection, thread-detail subscription, terminal-state, and sidebar work during active conversations.
- Aligned Pi model discovery with the current ModelRuntime SDK and tightened Claude, OpenCode, Codex, Cursor, Droid, Grok, and Antigravity session lifecycle handling.
- Bumped Synara release package versions to `0.6.1` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed 0.6.0 database recovery when a migration had committed schema changes without advancing the recorded lineage, while preserving verified backups and resumable recovery markers.
- Fixed migration replay across historically edited migration files and rejected unsafe lineage mismatches before application startup.
- Fixed desktop startup and shutdown races, including Windows backend termination, stale process replacement, and misleading startup-block diagnostics.
- Fixed diff view toggles, stale Git status refreshes, and Select All copying only the rendered portion of a virtualized diff.
- Fixed stale OpenCode plan-agent state, Pi model discovery, Claude resume and permission edge cases, and provider process teardown after interrupted sessions.
- Fixed project heading colors, empty-chat project selection, Space routing, and restored Studio task workspace paths.
- Fixed outbound HTTP pinning so Happy Eyeballs behavior remains available.

### Verification

- `bun run fmt:check` passed across 15,501 files.
- `bun run lint` passed with 290 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing TS44 informational JSON/schema-preference messages and Astro/Vite deprecation notices were reported.
- `bun run release:smoke` passed and retained the pinned dependency graph.
- `bun run build` passed with 5 successful Turbo tasks; existing Astro/Vite deprecations and tsdown/plugin timing warnings remain non-blocking.
- Full `bun run test` passed with 8 successful Turbo tasks in 16m15.769s. Web passed 256 files / 3,107 tests; server/CLI passed 274 files / 2,860 tests with 2 skipped files and 7 skipped tests; all remaining package suites passed. No targeted reruns were required.

## 0.6.0 - 2026-07-24

### Added

- Added the Synara Agent Gateway, a built-in MCP app-control surface automatically available to supported provider sessions so agents can understand and operate Synara itself.
- Added 23 internal Synara MCP tools for discovering context and capabilities; listing projects and tasks; reading transcripts; waiting for one or many tasks; creating one task or an exact parallel batch; continuing, steering, queuing, or interrupting work; renaming and archiving tasks; and inspecting activity, orchestration events, provider runtime events, and synthesized diagnostics.
- Added durable, idempotent multi-task creation across providers and models, with isolated worktrees, explicit target selection, privilege caps, crash recovery, operation ownership, compensation, result waiting, and visible provenance for agent-created work.
- Added agent-facing MCP tools for creating, suggesting, listing, viewing, replacing, pausing, deleting, remembering, and reporting results from Synara automations.
- Added guided External MCP integrations for Codex, Claude Code, and other agentic MCP clients, plus copy-ready manual configuration for Claude Desktop and clients that cannot complete the setup prompt.
- Added a one-prompt external setup flow for agentic clients with resumable pairing, automatic local stdio configuration, connection verification, and the exact executable and Synara data directory from the running installation.
- Added External MCP tools for one-call workspace overview, allowed-project discovery, provider/model capability discovery, idempotent task creation, bounded task waiting, and paginated task reading.
- Added all-or-selected project authorization, expiring and revocable credentials, capability-filtered tool catalogs, per-minute and active-task limits, durable request replay, and explicit advanced permissions for project-wide task reading, local-checkout execution, and full-access execution.
- Added Project Spaces with names, curated icons, persisted ordering, project assignment, drag-and-drop movement, bulk moves, activity indicators, and a Void view for unassigned projects.
- Added `Cmd/Ctrl+Alt+1–9` Space switching, shortcut labels in tooltips and the shortcuts sheet, and inline Space creation while adding a project.
- Added first-class Claude Task subagents as navigable child tasks with live status, recent tool traces, usage, model and effort information, steering, stop-all, and foreground/background controls.
- Added live workflow run cards with phases, agent metrics, saved run identity, pause and resume, optional phase filtering, and explicit background-state notices.
- Added cross-task composer mentions that attach bounded recent transcript context from another Synara task with its project and provider identity.
- Added a global Commit and Push shortcut that follows the active task's available Git action.
- Added configurable AppSnap global shortcuts with validation, persistence, and conflict detection.
- Added an isolated Synara Canary workflow for clean-checkout desktop testing and attachment uploads.
- Added a Studio folder row that opens the selected folder in the platform file manager.

### Changed

- Agents now receive explicit Synara operating guidance: when to delegate parallel work, wait for every requested result, prefer Synara diagnostics over raw database inspection, respect worktree and full-access boundaries, and suggest rather than silently enable automations.
- Agent-created and externally created work remains ordinary standalone Synara tasks with visible origin, independent lifecycle, and results that users and other agents can follow.
- External MCP setup defaults new work to managed worktrees and approval-required execution; higher-impact runtime modes remain separate explicit grants.
- External MCP credentials use a dedicated audience and never appear in client configuration. Pairing uses a short-lived code, stores the resulting credential privately, and verifies the live loopback runtime before forwarding authority.
- Automations now support standalone and heartbeat modes, persistent memory, heartbeat cooldowns, notification and completion policies, maximum runs, proposal review, run envelopes, and runtime reconciliation after interruptions or restarts.
- Automation lists now separate active and paused work, spell out cadence and next-run timing, and surface failed, cancelled, interrupted, approval-blocked, unread, and review-needed states directly in each row.
- Manual turns preserve their selected runtime and environment modes when they supersede automation work, and superseded heartbeat runs settle as interrupted.
- Project creation now uses a dedicated searchable dialog and shared picker surfaces across project, model, provider, and settings controls.
- Studio shows Git controls only when its selected folder is a repository; ordinary folders no longer imply that Git must be initialized.
- Live and attention-needing tasks receive clearer sidebar priority, while cross-task attribution is simplified to a single Synara label.
- Workflow and subagent chrome now uses one calmer stacked surface with state-driven color, compact phase pills, aligned rows, hover actions, and concise model labels.
- Chat Markdown headings now have visible hierarchy instead of rendering like body text.
- Provider and model picker popups retain a stable width and use more consistent spacing.
- Fast mode moved into the effort header.
- New-thread model discovery begins from sidebar intent so the composer more often opens with provider choices already available.
- New-chat navigation and persisted draft and terminal writes now defer non-critical work to improve first paint.
- Independent attachment reads and checkpoint resolution run concurrently at turn start.
- Streaming projection uses fewer SQL operations and avoids redundant nested savepoints.
- The React Compiler was upgraded and enabled across substantially more of the web app; redundant memoization and dead interface code were removed.
- The application architecture received a broad maintainability pass: the web store, composer drafts, chat, transcript, and sidebar controllers were decomposed; duplicated domain, protocol, browser, and runtime logic was consolidated; and obsolete modules and the retired internal ACP compatibility package were removed.
- Provider ACP handling now uses the official Agent Client Protocol SDK rather than the retired internal compatibility package.
- Provider callback and event ingress is now bounded, and restart reconciliation repairs provider and terminal activity that could otherwise drift during bursts or interrupted sessions.
- Provider updates install into the same npm prefix as the detected executable, preventing a successful update from landing in a different Node installation.
- The CLI publish flow now builds an isolated package stage and includes the migration-backup restore executable.
- The running-task spinner is slimmer and slower, dialog and input chrome is more consistent, composer picker rows are easier to scan, sidebar branding is quieter, and the retired World Cup playground has been removed.
- Bumped Synara release package versions to `0.6.0` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed Synara browser-control discovery and desktop browser RPC negotiation, session ownership, teardown, reconnect, and fixture readiness.
- Fixed blank provider `PATH` defaults being rejected or replaced incorrectly.
- Fixed MCP `serve` and `pair` ignoring `--home-dir`, which could connect an integration to the wrong Synara data directory.
- Fixed External MCP trust and lifecycle boundaries around credential selection, pairing retries, restart discovery, concurrent waits, cancellation, capacity compensation, revoked or expired credential checks, and loopback-only enforcement.
- Fixed External MCP documentation omitting the primary `synara_overview` discovery tool and describing a superseded client-picker setup flow.
- Fixed Agent Gateway privilege-escalation paths so approval-required or worktree-isolated callers cannot create or control higher-privilege tasks by proxy.
- Fixed gateway credentials leaking into spawned shell subprocesses and preserved that exclusion through Codex overlay rewrites.
- Fixed agent task creation recovery, cleanup ownership, shared-session queue reservations, wait behavior, deleted-caller authority, and interrupted worktree cleanup.
- Fixed `synara_list_projects` exposing system-managed Chat, Studio, and legacy Home containers as ordinary projects.
- Fixed task-list truncation counts and pinned parent/child sidebar behavior.
- Fixed active-turn checkpoint revert races; undo is rejected while provider work is genuinely in flight but remains available after terminal errors.
- Fixed queued sends and steers racing task settlement or provider-session ownership.
- Fixed manual turns inheriting stale automation or agent dispatch origin.
- Fixed Claude reroute pinning, excessive transcript replay, thinking and effort restarts, stale resume behavior, rate-limit blowups, and background-task process shutdown.
- Fixed Claude subagent stops being resurrected by late messages, parent interrupts being cleared by child events, background actions targeting already-backgrounded work, and final workflow snapshots being overwritten.
- Fixed OpenCode quiet-completion detection following stale rather than latest activity.
- Fixed OpenCode `/review` being forwarded as plain text instead of opening Synara's review flow.
- Fixed unmapped Codex child events contaminating the owning task.
- Fixed the Claude context meter ignoring `autoCompactWindow`, failing to refresh after live changes, or carrying stale values through handoffs.
- Fixed Pi discovery omitting authenticated Claude Fable 5 and Opus 4.8 models.
- Fixed namespaced Cursor and Grok ACP model identifiers and ACP permission-mode handling across Cursor, Droid, Grok, and OpenCode.
- Fixed Antigravity's global capture hook launching the Synara GUI outside active sessions.
- Fixed provider update success messages when a second Node or npm installation remained selected.
- Fixed file-icon lookup keys such as `constructor` or `__proto__` crashing a conversation.
- Fixed duplicate composer clearance and preserved transcript scroll position when stacked panels change.
- Fixed global new-task creation using stale rather than latest project state.
- Fixed Windows desktop shutdown so the backend and WebSocket clients stop reliably before quit.
- Fixed macOS DMG and update finalization and preserved the x64 update manifest in universal release metadata.
- Fixed durable secret writes and thread-deletion cleanup so interruption or restart cannot leave empty credentials, resurrect queued turns, or repeatedly retry deleted work.
- Fixed pull-request review badges briefly showing incomplete counts.
- Fixed macOS `Cmd+K` search while leaving native `Ctrl+K` line editing available.
- Fixed missing project directories being reported as "Codex not installed"; Synara now identifies the missing working directory and offers relocation guidance.
- Fixed automation heartbeat cooldown incorrectly throttling an automation's own next run.
- Fixed automation memory writes requiring redundant IDs or content fields when the active automation context already identifies the target.

### Verification

- `bun run fmt:check` passed across 15,490 files.
- `bun run lint` passed with 286 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing TS44 informational JSON/schema-preference messages and Astro/Vite deprecation notices were reported.
- `bun run release:smoke` passed with Bun temporary staging available and retained the pinned dependency graph.
- `bun run build` passed with 5 successful Turbo tasks in 47.361s. The build still reports existing Astro/Vite deprecations, tsdown/plugin timing, desktop typeless-module and unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed with 8 successful Turbo tasks in 4m50.382s. Web passed 255 files / 3,038 tests; CLI passed 272 files / 2,814 tests with 2 skipped files and 7 skipped tests; all remaining package suites passed. No targeted reruns were required.
- `bun install --frozen-lockfile` confirmed 1,448 pinned packages after the workspace-version update, with no dependency changes.

## 0.5.5 - 2026-07-17

### Added

- Added Antigravity CLI as a first-class provider, including installation and authentication guidance, runtime model and reasoning-effort discovery, session creation and resume, streaming text and reasoning, tool and plan events, approvals, usage reporting, cancellation, and restart recovery.
- Added dedicated Antigravity branding across provider setup and selection, with stable SVG filter identifiers for predictable rendering.
- Added shared parsing and normalization for desktop file and folder drops so paths containing spaces, parentheses, encoded characters, or multiple items become valid composer mentions.

### Changed

- Reworked live-turn settlement to follow the owning provider session, preventing transcript chrome from remaining active after a turn has already completed.
- Optimized chat reconciliation and event projection to reduce repeated scans and redundant updates during active conversations and sidebar-driven state changes.
- Coalesced pull-request entries through shared list logic and unified picker popup interactions across the workspace.
- Replaced Pierre-branded side-panel diff headers with Synara's shared visual chrome.
- Retired the legacy Gemini keybinding and updated provider documentation for Antigravity.
- Reset bundled theme seeds consistently so shipped theme changes apply predictably without disturbing user-created themes.
- Bumped Synara release package versions to `0.5.5` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed WebSocket RPC requests remaining unsettled after close, timeout, send failure, or reconnect boundaries.
- Fixed working indicators and live-turn UI becoming stuck when provider runtime events and session completion arrived in different orders.
- Fixed dropped paths with spaces or parentheses being split, escaped incorrectly, or omitted from chat and Kanban task composers.
- Fixed Cursor model-discovery failures taking down the picker or discarding usable cached and independently discovered model choices.
- Fixed pull-request list typing under `exactOptionalPropertyTypes` and reduced duplicate list state across project contexts.
- Fixed Antigravity SVG filter keys relying on floating-point geometry strings instead of the stable generated filter identifiers.

### Verification

- `bun run fmt:check` passed across 13,192 files.
- `bun run lint` passed with 202 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed and retained the pinned dependency set while noting `@pierre/diffs@1.2.12` is newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed: 10 Turbo tasks in 8m19s; web passed 219 files, CLI passed 169 files / 1,863 tests with 2 skipped files and 7 skipped tests, and all remaining package suites passed. No targeted reruns were required.

## 0.5.4 - 2026-07-15

### Added

- Added a native Pull Requests workspace backed by the GitHub CLI, with cross-project and project-scoped discovery, search, state filters, involvement groups, pinned pull requests, and explicit loading, empty, authentication, and partial-failure states.
- Added pull-request detail views for summary, code, and timeline context, including checks, reviewers, commits, changed files, diffs, comments, and repository metadata.
- Added in-place pull-request actions for comments, merge, close, reopen, and pinning, with confirmation and error handling around destructive or remote mutations.
- Added a global feedback dialog available from the command menu and `/feedback` command.
- Added durable desktop window-state restoration for position, size, and maximized state, with monitor-bound validation when the display layout changes.

### Changed

- Refactored transcript rendering and provider-session orchestration into clearer shared lifecycles, including temporary-thread cleanup and more predictable runtime state transitions.
- Added shared pull-request UI primitives and centralized query, cache, mutation, and refresh coordination so list and detail surfaces stay consistent under overlapping requests.
- Improved pull-request discovery under load with bounded concurrency, single-flight fetches, cached fallback data, project-aware invalidation, and per-repository partial results.
- Updated the Pi SDK integration and model discovery behavior, including support for custom-provider authentication through `auth.json` semantics.
- Aligned Grok reasoning-effort handling with provider capabilities, hid Cursor transport-only model variants from user-facing selection, and standardized more of the interface on the system UI font.
- Refined theme initialization, browser navigation, external-link handling, sidebar behavior, composer actions, and shared disclosure/component styling as part of the workspace integration.

### Fixed

- Fixed pull-request refreshes, mutations, and route changes racing each other into stale lists or mismatched detail state.
- Fixed unavailable or failing repositories preventing successful pull-request results from other projects from remaining usable.
- Fixed desktop windows losing their prior bounds or reopening off-screen after restart or monitor changes.
- Fixed Pi custom-provider models authenticated through local auth configuration being omitted from discoverable models.
- Fixed temporary thread, transcript, and session transitions leaving inconsistent UI state during creation, navigation, reconnect, or cleanup.
- Fixed provider model pickers exposing unsupported Cursor variants or inconsistent Grok effort choices.

### Verification

- `bun run fmt:check` passed across 13,187 files.
- `bun run lint` passed with 192 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed after rerunning with Bun temporary staging available; it retained the pinned dependency set and reported `@pierre/diffs@1.2.12` as newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- The first full `bun run test` exposed a stale local Pi SDK install (`0.74.0` instead of lockfile version `0.80.6`) in one custom-provider discovery test. A frozen dependency sync corrected the local graph, and the focused regression passed.
- Final full `bun run test` passed: 10 Turbo tasks in 18m46s; web passed 217 files / 2,670 tests, CLI passed 169 files / 1,852 tests with 2 skipped files and 7 skipped tests, and all remaining package suites passed.

## 0.5.3 - 2026-07-14

### Added

- Added AppSnap, an opt-in macOS capture workflow that attaches the active app window to the current task when both Option keys are pressed.
- Added a packaged native AppSnap helper with Screen Recording permission guidance, capture feedback, focus-safe window selection, parent-process monitoring, and app icon extraction.
- Added a dedicated AppSnap settings panel and first-run welcome dialog so supported desktop installs can discover, configure, and disable the shortcut.
- Added durable browser-side blob storage for pending image attachments so captures survive navigation and app restarts without inflating local-storage drafts.

### Changed

- Improved long user-message readability with overflow-aware collapsing, richer markdown attachment chips, and more predictable transcript measurement on the simple non-virtualized timeline path.
- Refactored session orchestration, composer attachment persistence, and transcript rendering to reduce duplicated state transitions and keep live work predictable.
- Included the native AppSnap helper and its Swift sources in macOS development and packaged desktop build paths.

### Fixed

- Fixed AppSnap recovery after permission changes, helper restarts, capture overlap, timeout, and transient probe failures.
- Fixed pending AppSnap blobs being omitted from manual attach-and-send flows or attachment-limit calculations.
- Fixed duplicate attachment persistence and duplicate feedback sounds during capture retries and already-handled capture events.
- Fixed ACP request failures dropping useful structured error detail before it reached the UI.
- Fixed rich user markdown, attachment chips, and long-message previews producing inconsistent layout or timeline height updates.

### Verification

- `bun run fmt:check` passed across 13,106 files.
- `bun run lint` passed with 189 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed and refreshed temporary install/lockfile state while retaining the pinned dependency set.
- `bun run build` passed with 6 successful tasks and the existing Astro, tsdown/plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed: 10 Turbo tasks in 8m43s; web passed 205 files / 2,544 tests, CLI passed 162 files / 1,772 tests with 2 skipped files and 7 skipped tests, and all remaining package suites passed. No targeted reruns were required.

## 0.5.2 - 2026-07-13

### Added

- Added Factory Droid as a first-class ACP provider, including runtime model discovery, session import, context-preserving forks and restarts, token multipliers, provider-aware model switching, and Factory branding.
- Added `Alt+]` / `Alt+[` shortcuts for cycling through available models without leaving the conversation.
- Kept unfinished task lists visible in the transcript after a turn completes, so follow-up work is easier to resume.

### Changed

- Changed file undo to restore turn-scoped workspace changes without trimming chat history or rolling back the conversation that explains them.
- Improved cross-platform agent workflows with runtime Codex reasoning options, more reliable Windows CLI launching, platform-aware project folder labels, and graceful Git status checks outside repositories.
- Softened the file-change header treatment so active diffs are easier to scan.
- Removed the Windows process regression job from CI.
- Stable 0.5.x releases now publish on GitHub Latest, while 0.4.x remains the historical compatibility line.
- Superseded the withdrawn 0.5.1 build after its activity-sequence migration could stall startup on large local histories.

### Fixed

- Fixed model cycling and runtime-discovered reasoning options so the active provider's available choices remain consistent while a conversation is open.
- Fixed task-list projection so unfinished work is not hidden when a turn settles.
- Fixed startup on large databases by replacing the quadratic activity-sequence backfill with an indexed linear migration; the recovered 1.1 GB production database retained all 21 projects, 70 threads, 14,683 messages, and 180,862 activities.
- Fixed stable updater feeds to publish both GitHub Latest metadata and the `synara-*` channel aliases expected by installed desktop builds.

### Verification

- `bun run fmt:check` passed across 13,087 files.
- `bun run lint` passed with 184 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed after rerunning outside the sandbox; it reported `@pierre/diffs@1.2.12` as newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, tsdown/plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed: 10 Turbo tasks; web passed 201 files / 2,481 tests, CLI passed 162 files / 1,771 tests with 2 skipped files and 7 skipped tests, and the remaining packages passed their suites with 1 skipped shared test.

## 0.5.0 - 2026-07-11

### Added

- Added live Claude context-usage controls, near-window warnings, in-session model/context switching, and resumable context state.
- Added Claude task tracking for TaskCreate, TaskUpdate, TaskGet, TaskList, and TodoWrite, normalized into the shared runtime task list.
- Added shared provider task progress and richer Codex reasoning summaries, compaction events, and runtime task updates for clearer long-running turns.

### Changed

- Completed the Synara identity cutover across desktop packaging, the renderer origin, workspace packages, the public CLI, runtime variables, storage, Git metadata, assets, documentation, and release automation.
- Set the production bundle ID and Windows AUMID to `com.emanueledipietro.synara`, with `.dev` used only for development.
- Published the CLI identity as `@synara/cli` with the `synara` executable and moved all first-party workspaces to `@synara/*`.
- Kept persisted renderer state available through the 0.4.2 origin bridge and retained brand-neutral structural access to existing checkpoint refs and migration lineage.
- Deferred secondary chat dock panels and added a repeatable LCP measurement script so the main conversation can become interactive sooner.
- Hardened the staged updater feed, compatibility-channel checks, and desktop startup around bundle swaps.

### Fixed

- Fixed Claude and Codex resume paths so task progress, context state, reasoning summaries, and streamed runtime events survive reconnects without unnecessary provider restarts.
- Fixed noisy Codex app-server stdout and incomplete reasoning ingestion from obscuring or dropping live transcript activity.
- Fixed deleted-project reconciliation and browser profile migration edge cases by preserving client tombstones and repairing database sidecars transactionally.

### Verification

- `bun run fmt:check` passed across 13,057 files.
- `bun run lint` passed with 178 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed with Bun temporary staging available; it reported `@pierre/diffs@1.2.12` as newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, tsdown/plugin-timing, desktop module-type, and large Vite chunk warnings.
- Final full `bun run test` passed: 10 Turbo tasks; `@synara/web` passed 200 files / 2,426 tests, and `@synara/cli` passed 152 files / 1,698 tests with 1 skipped file and 6 skipped tests. The initial run was interrupted while waiting on the serial server suite; the final rerun completed cleanly.

### Upgrade note

- Launch Synara 0.4.2 once before upgrading so renderer-local UI state is exported before 0.5.0 adopts the canonical `synara://app` origin.

## 0.4.2 - 2026-07-09

### Added

- Added the Synara identity bridge that exports canonical renderer storage before the packaged origin changes.
- Added per-thread 1M-token context window tracking for Claude sessions, with automatic compaction handling and context-usage warnings near the window limit.
- Added fallback model pinning for Claude after a safeguard reroute, cleared when the user explicitly selects a different model.
- Added a durable desktop update install marker that verifies installs across restarts, plus an install watchdog with recovery and macOS ShipIt/launchctl update diagnostics.
- Added a build-only native release validation mode and a team-bound macOS signing requirement for seamless future updates.
- Added a durable, bounded Codex-overlay suppression marker without modifying the user's source configuration.

### Changed

- Claude model and context-window switches now happen in-session instead of forcing a full session restart, sharply reducing restarts and runaway token usage.
- Canonicalized migration and checkpoint metadata while keeping existing persisted refs readable.
- Enforced the staged Synara update feed end to end, with fail-closed preflight checks in the release pipeline.
- Made Windows code signing optional in the release pipeline and finalized Synara license attribution.

### Fixed

- Fixed the new-chat keyboard shortcut routing inside Studio.
- Repaired incomplete legacy home imports and restored the legacy environment identity from the bridge marker.
- Ordered renderer storage migration before app hydration and guarded renderer bootstrap ordering.
- Preserved composer drafts more reliably through the storage-key migration.

### Verification

- `bun run fmt`, `bun run lint`, `bun run typecheck`, `bun run release:smoke`, `bun run build`, and the full `bun run test` suite (1688 passed, 6 skipped, 0 failed) all passed on the release commit.
- Build-only native validation succeeded for macOS arm64/x64, Linux x64, and Windows x64 prior to tagging; the tagged release pipeline completed with all four platform builds green.

### Upgrade note

- Launch Synara 0.4.2 at least once before installing the next release. This preserves drafts, pins, theme, browser state, and other local UI state through the identity cutover.
- Earlier command and environment aliases are accepted by 0.4.2 only and are removed by the following release.

## 0.4.1 - 2026-07-09

### Added

- Added Studio: a dedicated workspace for long-running, agent-led work, with its own projects, threads, routes, sidebar entries, and empty-state entry points.
- Added a Studio outputs surface in the Environment panel for agent-produced files, generated images, and related activity.
- Added visible project worktree setup steps so workspace preparation and setup failures are easier to understand.
- Added focused coverage for Studio routing, output projection, worktree setup, restore behavior, project metadata, and transcript/workspace handoffs.

### Changed

- Refined chat and Studio creation, routing, and restore flows to use canonical containers, wait for hydration when needed, and avoid overlapping fresh-chat creation.
- Refined session orchestration and transcript rendering so active work, sidebar visibility, and worktree setup remain predictable across streaming, reconnects, and segment switches.
- Refined Studio scaffolding and project ownership rules to preserve clear workspace boundaries during retries, restores, and partial creation states.
- Bumped Synara release package versions to `0.4.1` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed cross-kind project reuse so regular chats and Studio threads cannot accidentally share an incompatible container or workspace root.
- Fixed several restore and route edge cases involving archived threads, hidden segments, draft targets, startup hydration, and unclassifiable thread kinds.
- Fixed Codex startup ordering by preparing the authentication overlay before dependent paths, and fixed the Codex launcher path on Windows.
- Fixed Studio output display and projection edge cases so generated images and output activity remain discoverable in the Environment panel.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with existing warnings and no errors.
- `bun run typecheck` passed across all 8 packages (with existing TS44 informational JSON/schema-preference messages).
- `bun run release:smoke` passed.
- `bun run build` passed (with existing Astro, tsdown/plugin-timing, desktop module-type, and large Vite chunk warnings).
- `bun run test` passed.

## 0.4.0 - 2026-07-06

### Added

- Added richer pull request snapshot data in the Environment panel, including review/check preview handling and merged-state awareness.
- Added prompt-history navigation support that preserves the current draft's file/image attachments while browsing previous prompts.
- Added graceful Claude usage/rate-limit handling so provider usage limits show as a recoverable user-facing state instead of a generic failure.
- Added focused release coverage around PR snapshot edge cases, prompt-history navigation, provider usage parsing, and desktop restart stderr handling.

### Changed

- Bumped Synara release package versions to `0.4.0` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined prompt history navigation so stale navigation state resets cleanly and optimistic prompt-history entries do not duplicate after sends.
- Refined PR snapshot loading to dedupe GitHub field lists, format merge-head details more consistently, and keep long review previews readable.
- Refined provider usage type handling around Claude summaries and rate-limit responses.

### Fixed

- Fixed prompt-history browsing losing draft attachments while moving through previous prompts.
- Fixed duplicate optimistic prompt-history entries and stale prompt-history navigation state after related sends.
- Fixed desktop restart handling for broken stderr pipes, including the EPIPE path from restarted child processes.
- Fixed PR snapshot follow-up issues around merged PR state, truncated review previews, and merge-head formatting.
- Fixed automation migration lineage assertions and provider usage summary type narrowing uncovered by the recent release work.

### Verification

- `bun run fmt:check` passed across 1535 files.
- `bun run lint` passed with 168 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages in 18.277s with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 16.479s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Full `bun run test` passed: 10 tasks successful in 6m35.477s. `@synara/web` passed 194 files / 2352 tests, and `synara` passed 145 files with 1 skipped file, 1593 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.4.0`, and `npm run lint` passed.

## 0.3.9 - 2026-07-05

### Added

- Added the app-level `/export` slash command for saved, idle threads, producing a streamed ZIP archive with `thread.json` and `transcript.md`.
- Added full-history export hydration, shared export eligibility checks, blocked-export reasons, desktop CORS/error handling, and command-menu support for `/export`.
- Added profile stats archival for purged threads, including migration `050_ProfileStatsArchive`, retained command receipts, checkpoint ref cleanup safeguards, and retention cleanup coverage.
- Added a stable active-turn "Working for" transcript header while preserving the existing pending-setup shimmer row.
- Added a dedicated terminal process-tree killer with SIGTERM-to-SIGKILL escalation and disposal timing coverage.
- Added runtime-discovered OpenCode/Kilo model support for Git writing settings, plus contract/query coverage for selected text-generation backends.

### Changed

- Bumped Synara release package versions to `0.3.9` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined `/export` to stream archive entries incrementally, deflate large entries without buffering the whole ZIP, and avoid offering export while a turn is running or still streaming.
- Refined thread purge behavior so archived profile aggregates continue contributing to profile queries after thread rows are removed.
- Refined terminal shutdown so disposal waits for kill escalation instead of returning while stubborn process trees may still be alive.
- Refined Git action text-generation selection so commit messages, diff summaries, and PR text route through the configured Git-writing provider/model.

### Fixed

- Fixed `/export` menu selections falling through silently and local draft threads offering an export path that would 404.
- Fixed very large thread exports being capped by the UI thread-detail message limit.
- Fixed ACP resumed sessions reusing fallback assistant message IDs across runtime restarts, which could overwrite earlier assistant transcript segments.
- Fixed OpenCode/Kilo Git-writing model selections failing to reach Git actions and falling back to the wrong backend.
- Fixed archived profile stats being lost when thread cleanup purged the underlying messages and command receipts.
- Fixed terminal shutdown paths that could leave stubborn subprocess trees alive after disposal.

### Verification

- `bun run fmt:check` passed across 1528 files.
- `bun run lint` passed with 168 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 18.768s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Full `bun run test` passed: 10 tasks successful in 6m35.955s. `@synara/web` passed 193 files / 2316 tests, and `synara` passed 144 files with 1 skipped file, 1575 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.9`, and `npm run lint` passed.

## 0.3.8 - 2026-07-03

### Added

- Added ACP/Grok resume and compaction hardening so resumed sessions drop unsafe replay before consumers attach, seed quiet windows from response timing, and avoid memory-heavy replay loops.
- Added explicit worktree setup progress/failure state in local dispatch snapshots, transcript rows, and browser coverage.
- Added automation dispatch-origin persistence and a "Sent via Automation" transcript label for scheduled and heartbeat-triggered user turns.
- Added approval panel browser coverage for allow/deny decisions and shared choice-row presentation for pending approvals.
- Added focused tests for collapsed transcript work-duration grouping, failed worktree setup reset behavior, session lifecycle handling, provider/runtime ingestion, and profile/sidebar presentation helpers.

### Changed

- Bumped Synara release package versions to `0.3.8` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined ACP session runtime and Grok adapter handling around resume replay, compaction, JSON-RPC ordering, provider runtime ingestion, and provider service session state.
- Refined worktree setup timeline rendering so setup rows expose active/failed/done state more predictably and failed local dispatches clear on the next send.
- Reworked pending approval UI around the shared `ComposerChoiceRow` structure, trimming duplicate action styling and aligning it with pending input panels.
- Gated Claude credential keepalive/startup refresh behavior and refined provider usage/query invalidation paths so app startup does less surprise provider work.
- Refined transcript, sidebar, profile stats, share-card, and timeline-height logic around dispatch origins and folded work rows.

### Fixed

- Fixed Grok/ACP resume replay ordering that could attach replay before the event consumer and make resumed or compacted sessions unstable.
- Fixed failed worktree setup dispatch state lingering into a new local turn instead of resetting when the user sends again.
- Fixed collapsed turn "Worked for" timing so folded transcript segments report a duration spanning the whole folded section.
- Fixed automation-origin turns missing a durable transcript projection marker.
- Fixed a release-gate `exactOptionalPropertyTypes` error in `apps/web/src/components/ChatView.tsx` by omitting the optional dispatch `options` property when there is no worktree setup step.
- Fixed backend Node option handling around unsupported `--js-flags` forwarding while keeping covered desktop startup behavior.

### Verification

- `bun run fmt:check` passed across 1518 files.
- `bun run lint` passed with 162 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on `apps/web/src/components/ChatView.tsx` because `beginLocalDispatch` passed an explicit `options: undefined` into an exact-optional helper; after the targeted fix, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 23.921s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Initial full `bun run test` failed in `@synara/web` with one timeout: `apps/web/src/components/ChatMarkdown.test.tsx > ChatMarkdown > uses the theme foreground token for markdown text`. No stale duplicate test processes were present; the targeted rerun `bun run test src/components/ChatMarkdown.test.tsx -t "uses the theme foreground token for markdown text"` from `apps/web` passed in 1.01s.
- Final full `bun run test` passed: 10 tasks successful in 9m28.476s. `@synara/web` passed 193 files / 2308 tests, `synara` passed 140 files with 1 skipped file, 1547 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.8`, and `npm run lint` passed.

## 0.3.7 - 2026-07-02

### Added

- Added live desktop update download percentages on the sidebar update button, including clamped integer handling and focused edge-case coverage.
- Added single-flight checkpoint capture for matching repo/ref pairs, with a 180s aggregate timeout and first-writer-wins `skipIfExists` baselines.
- Added recovery coverage for missing message-start baselines before turn-start checkpoint aliasing.
- Added pure Claude auth-status parsing and generic provider CLI-output helpers, making provider health behavior easier to test in isolation.
- Added a shared in-process `claude auth status` lock so health probes and macOS credential keepalive ticks do not race the same rotating OAuth refresh token.
- Added CI timeouts and non-interactive browser-runtime install safeguards so hosted quality runs fail fast instead of hanging indefinitely.

### Changed

- Bumped Synara release package versions to `0.3.7` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Moved the sidebar Chats section into the scrollable sidebar content, added an accessible disclosure state, and reused the shared disclosure chevron.
- Refined the desktop update action styling to use the info color while active downloads show a compact percent pill.
- Refined Claude provider health to retry structured `loggedIn:false` false negatives once, read verified local credential metadata, and preserve subscription/auth labels more reliably.
- Forked the macOS Claude credential keepalive after server startup and passed the configured home dir into the Claude process environment so the best-effort keepalive cannot block boot.
- Moved the CI quality job onto GitHub-hosted runners and switched Playwright installation to the workspace-local binary after `bunx` installs stalled.

### Fixed

- Fixed Claude Agent health checks that could briefly report an authenticated account as logged out when concurrent `claude auth status` calls raced a refresh-token rotation.
- Fixed checkpoint baseline races that could overwrite or miss the original pre-turn snapshot used for transcript diffs and restore points.
- Fixed first-message sends from the empty chat landing opening the Environment panel unexpectedly after the transcript view appears.
- Fixed crowded sidebar footer behavior by keeping chat history rows with the main sidebar list and leaving the footer for account/update controls.
- Fixed release CI being blocked by the unavailable Blacksmith runner queue; Linux browser tests now continue for signal without blocking while geometry parity failures are tracked separately.

### Verification

- `bun run fmt:check` passed across 1508 files.
- `bun run lint` passed with 158 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 14.425s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, Rolldown/Babel plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m23.405s. `@synara/web` passed 191 files / 2274 tests. `effect-acp` passed 3 files / 24 tests. `synara` passed 140 files with 1 skipped file, 1532 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.7`, and `npm run lint` passed.

## 0.3.6 - 2026-06-30

### Added

- Added safer Cursor ACP command discovery and launcher fallback coverage for bundled sibling shims, legacy shims, and fallback ordering.
- Added Muxy Open In support through editor metadata, server open handling, and focused tests.
- Added live message trail rendering, shared trail logic, browser coverage, and timeline integration for active transcript updates.
- Added desktop clipboard image sharing for share-card/profile exports.
- Added Claude credential keepalive coverage to keep macOS OAuth credentials fresh across longer sessions.

### Changed

- Bumped Synara release package versions to `0.3.6` across the server, desktop, web, and contracts packages.
- Refined Cursor agent command resolution so fallback launchers prefer known-safe agent paths and reject unsafe editor fallbacks.
- Refined checkpoint and transcript handling around turn completion, live trail rendering, and message timeline integration.
- Refined Sonnet 5 model variant metadata, sidebar status icons, command-row branding, tool-call labels, chat bubble padding, and model effort picker copy.
- Refined task-completion notification logic and share-card export behavior around desktop clipboard support.

### Fixed

- Fixed Cursor ACP CLI path resolution for packaged/bundled Cursor layouts and legacy shim paths.
- Fixed unsafe Cursor editor fallback behavior by rejecting launch paths that do not match the expected agent command shape.
- Fixed Claude sessions becoming stale after long macOS OAuth credential idle periods.
- Fixed file-change checkpoint timing around completed turns so summaries attach after the relevant assistant message is known.
- Fixed formatting drift in ProviderHealth, Cursor ACP, and shared model test files caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/provider/Layers/ProviderHealth.test.ts`, `apps/server/src/provider/Layers/ProviderHealth.ts`, `apps/server/src/provider/acp/CursorAcpCommand.ts`, `apps/server/src/provider/acp/CursorAcpSupport.ts`, and `packages/shared/src/model.test.ts`; after targeted `bunx oxfmt` on those files, the final formatter check passed.
- `bun run lint` passed with 158 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m38.929s. `@synara/web` passed 191 files / 2273 tests. `synara` passed 138 files with 1 skipped file, 1517 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` and `npm run lint` passed.

## 0.3.5 - 2026-06-30

### Added

- Added temporary-thread promotion coverage and renamed disposable-thread helpers around the temporary-thread lifecycle.
- Added undo-toast archive behavior for sidebar thread archive actions, backed by shared thread archive helpers and toast coverage.
- Added macOS desktop icon-cache refresh logic with startup/update integration and focused platform-gated tests.
- Added focused coverage for queued composer headers, timeline work-row grouping, diff rendering, thread archive undo, and desktop update button presentation.

### Changed

- Bumped Synara release package versions to `0.3.5` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace package versions.
- Reworked temporary chat promotion so draft/temporary threads move into durable chat flow more predictably across ChatView, sidebar state, session logic, and route activation.
- Replaced archive confirmation friction with immediate archive plus undo toast, including sidebar row actions, settings primitives, and shared error messaging polish.
- Refined pending user-input panels, queued composer state, work rows, tool details, markdown spacing, composer picker styling, model/traits pickers, and chat timeline presentation.
- Cleaned up activity heatmap export, share cards, diff-rendering helpers, sidebar labels, and several compact toolbar/control labels.

### Fixed

- Fixed dark-mode composer input surface border styling after the recent composer picker polish.
- Fixed stale macOS Dock/Finder icon behavior after app icon changes by refreshing icon caches from the desktop process when needed.
- Fixed archive recovery ergonomics by replacing the blocking confirmation path with a reversible toast action.
- Fixed temporary-thread naming and lifecycle drift left over from disposable-thread terminology.
- Fixed small UI inconsistencies in pending approvals, pending inputs, PDF toolbar, terminal chrome, settings routes, and What's New popout sizing.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It reported a slow filesystem warning for the Bun install cache during the final pass.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 6m9.469s. `@synara/web` passed 190 files / 2229 tests. `synara` passed 137 files with 1 skipped file, 1492 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.5`, and `npm run lint` passed.

## 0.3.4 - 2026-06-29

### Added

- Added assistant streaming as the default for fresh app/server settings so new installs start with live assistant output enabled.
- Added smoother transcript auto-follow coverage for optimistic sends, streaming assistant text, message entry animations, and tool detail interactions.
- Added broader provider-health coverage for Claude local CLI credentials, Cursor ACP/headless probing, OpenCode model/runtime handling, and provider model-probe failures.
- Added focused OpenCode retry-warning ingestion and web session coverage so retry notices stay attached to work-log rows and collapse consistently across turns.
- Added tool-call label coverage and refined central icon usage for agent mentions, task rows, and file-change entries.

### Changed

- Bumped Synara release package versions to `0.3.4` across the server, desktop, web, and contracts packages.
- Refined transcript streaming and session-state handling so live assistant output, tool rows, and bottom-stick behavior stay separated more predictably.
- Made Claude provider health prefer usable local CLI credentials before inheriting direct credential env keys into subprocesses.
- Made Cursor provider probing use a safer headless environment for ACP commands.
- Improved chat card contrast, agent glyph consistency, file-change icon choices, and shared switch sizing/thumb animation.

### Fixed

- Fixed OpenCode retry warnings being projected into the wrong conversation surface or failing to collapse consistently across turns.
- Fixed provider-health status handling so model-probe failures can keep an authenticated provider available with a warning instead of degrading it too aggressively.
- Fixed transcript browser test type drift by normalizing `scrollTo` test-helper options without explicit `undefined` optional fields.
- Fixed Claude provider-health type drift by only passing `homeDir` to the Claude env builder when it exists.
- Fixed ProviderHealth test type drift by using the Effect platform `"Unknown"` system error tag supported by this workspace.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on `apps/web/src/components/ChatView.browser.tsx` because a browser `scrollTo` test helper produced explicit `undefined` optional fields; after that fix it failed in `synara` on `apps/server/src/provider/Layers/ProviderHealth.ts` and `ProviderHealth.test.ts` for the same exact-optional pattern and an unsupported Effect platform error tag; after targeted fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- Initial `bun run test` failed in `@synara/web` on `apps/web/src/appSettings.test.ts` because the persisted-settings decode-default fixture still expected `enableAssistantStreaming: false`; after updating the fixture to the new default, the targeted app settings test passed.
- Final `bun run test` passed: 10 tasks successful in 6m5.217s. `synara` passed 137 files with 1 skipped file, 1492 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.4`, and `npm run lint` passed.

## 0.3.3 - 2026-06-28

### Added

- Added Windows packaged-app editor discovery so VS Code and VS Code Insiders installed from the Microsoft Store can be launched from Synara.
- Added Windows editor URI fallback handling when the normal editor command is unavailable or unsuitable.
- Added a provider update-check preference across server settings, web app settings, settings search, provider health, and update notification filtering.
- Added shared workspace explorer keyboard navigation coverage and a dedicated keyboard shortcuts settings panel.
- Added focused release-gate coverage updates for server settings push payloads and Windows editor launch behavior.

### Changed

- Bumped Synara release package versions to `0.3.3` across the server, desktop, web, and contracts packages.
- Refreshed Synara icon and logo assets across desktop resources, marketing assets, web favicons, app icons, and shared brand assets.
- Corrected macOS app icon packaging after the Ventura rounded-icon pass and removed the temporary literal Dock icon workaround.
- Unified workspace explorer presentation, file row styling, diff stat labels, DockExplorerPane behavior, and shortcut settings navigation.
- Reduced idle local server polling by giving server React Query a calmer idle refresh cadence while preserving active-session refresh behavior.
- Aligned menu checkbox switch styling with the shared switch primitive track/thumb classes so compact switch-shaped controls stay visually consistent.

### Fixed

- Fixed VS Code Store editor launch on Windows by resolving packaged app identities and falling back to URI activation when needed.
- Fixed provider update notification behavior so disabled update checks suppress background notices instead of continuing to surface provider updates.
- Fixed release-blocking server typecheck drift in `apps/server/src/open.ts` by using the Effect error handler API available in this workspace.
- Fixed release-blocking web typecheck drift in `apps/web/src/wsNativeApi.test.ts` by including `enableProviderUpdateChecks` in the mocked server settings payload.
- Fixed formatting drift in `apps/server/src/editorAppDiscovery.ts`, `apps/server/src/open.test.ts`, and `scripts/build-desktop-artifact.ts` caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/editorAppDiscovery.ts`, `apps/server/src/open.test.ts`, and `scripts/build-desktop-artifact.ts`; after targeted `bunx oxfmt` on those files, `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` because `wsNativeApi.test.ts` missed the new `enableProviderUpdateChecks` setting; after that fix it failed in `synara` because `apps/server/src/open.ts` used unavailable `Effect.catchAll`; after both fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m8.962s. `@synara/web` passed 188 files / 2212 tests. `synara` passed 136 files with 1 skipped file, 1475 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.3`, and `npm run lint` passed.

## 0.3.2 - 2026-06-27

### Added

- Added project selection to the branch toolbar so project, branch, and worktree context can be managed from the active chat surface.
- Added preview grants for absolute local files, including local image route coverage, trusted-origin checks, workspace file-system normalization, and web preview/download handling.
- Added a collapsible review file tree for the diff panel, backed by shared file-diff tree logic and shared disclosure motion.
- Added focused coverage for branch toolbar project selection, chat-project container selection, project creation recovery, local file preview grants, review file trees, route inset surfaces, provider availability, and workspace file openers.

### Changed

- Bumped Synara release package versions to `0.3.2` across the server, desktop, web, and contracts packages.
- Refactored transcript scrolling and session-state handling so ChatView owns less browser-specific behavior directly and live transcript/layout state has clearer boundaries.
- Refactored composer chrome measurement, right-dock metadata, workspace preview headers, and the workspace explorer into reusable pieces.
- Made project and home-chat container selection more explicit by sharing project creation/recovery, draft-thread mapping, and chat-container selection helpers across sidebar and toolbar entrypoints.
- Refined provider send readiness by refreshing provider status before chat, Kanban, handoff, and route-driven sends, then returning focus to the composer more consistently.
- Unified explorer icons, working shimmer styles, compact route inset surfaces, composer picker styling, and sidebar visual details.

### Fixed

- Fixed absolute local file previews that could fail to open or download when agent output referenced files outside the immediate workspace preview path.
- Fixed review-heavy diff navigation by adding a tree view instead of forcing users to scan a flat patch list.
- Fixed stale provider availability before send paths that could leave chat or Kanban actions using outdated provider state.
- Fixed release-blocking exact-optional typecheck drift in `apps/web/src/components/Sidebar.tsx`, `apps/web/src/composerDraftStore.ts`, and `apps/web/src/lib/chatProjects.ts`.
- Fixed formatting drift in `apps/web/src/components/RouteInsetSurface.tsx` caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/web/src/components/RouteInsetSurface.tsx`; after targeted `bunx oxfmt` on that file, `bun run fmt:check` passed.
- `bun run lint` passed with 154 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on exact optional property handling in `Sidebar.tsx`, `composerDraftStore.ts`, and `chatProjects.ts`; after targeted fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed. It refreshed install/lockfile state during `bun install`, with no remaining `bun.lock` diff.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m44.64s. `@synara/web` passed 187 files / 2205 tests. `synara` passed 136 files with 1 skipped file, 1464 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.2`, and `npm run lint` passed.

## 0.3.1 - 2026-06-26

### Added

- Added transcript tool-call detail dialogs and formatting helpers for command output, patches, file changes, and tool output so command-heavy turns are easier to inspect.
- Added regression coverage for tool-call labels, tool-call detail formatting, message timeline grouping, sidebar hover-card anchoring, keybindings, Gemini ACP probing, provider runtime ingestion, ProviderService behavior, electron-updater security, and Windows process handling.
- Added a curated central icon asset set and provider/UI icon plumbing used by newer picker, header, sidebar, and preview surfaces.
- Added more explicit project and thread hover-card content, thread pin toggle behavior, recent view switching, and project shortcut targeting.

### Changed

- Bumped Synara release package versions to `0.3.1` across the server, desktop, web, and contracts packages.
- Refined session orchestration and transcript handling so assistant messages, tool/work rows, collapsed turns, runtime activity, and sidechat state stay separated more predictably.
- Improved chat header, recent-view, sidebar, split-chat, and hover-card navigation for multi-pane workflows.
- Tightened keyboard shortcut defaults and persisted keybinding migrations for chat creation, terminal creation, navigation, and duplicate/stale binding rows.
- Expanded provider runtime ingestion for canonical Codex event shapes, generated-image markdown, MCP tool progress, reasoning deltas, proposed-plan events, and synthetic placeholder thread ids.
- Hardened provider management around idle runtime retention, provider health refresh, process cleanup, Cursor/Gemini/Grok adapter paths, OpenCode runtime handling, and Gemini ACP probe parsing.
- Made automation setup/update flows stricter by separating conversational setup prompts, update-only approval paths, approval fallback behavior, prompt filler removal, and risk acknowledgement gating.
- Improved desktop startup/update handling by reducing noisy Node deprecation warnings and tightening electron-updater Windows command construction.
- Refined composer, automation banners, provider/model pickers, Kanban cards, preview cards, tooltip primitives, and project/sidebar icons with smaller consistency fixes.
- Welcomed focused external contributions in the project docs and README while keeping the early-WIP guidance explicit.

### Fixed

- Fixed transcript tool-call inspection gaps where shell command output, patch details, and normalized tool output were hard to review from the UI.
- Fixed session orchestration edge cases around review interrupt retry, compaction progress, runtime event replay, generated image completion replay, and provider-thread placeholder matching.
- Fixed provider runtime warning and ingestion paths that could mishandle missing usage details, auxiliary turn completions, or non-active turn completions in synthetic/runtime tests.
- Fixed automation approval regressions around update-only flows, fallback prompts, conversational setup follow-up text, and dispatch-time risk acknowledgement.
- Fixed desktop updater command-hardening coverage and reduced startup warning noise from desktop Node behavior.
- Fixed formatting drift caught by the release gate in `apps/server/src/keybindings.test.ts` and `apps/web/src/components/chat/ToolCallDetailsDialog.tsx`.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/keybindings.test.ts` and `apps/web/src/components/chat/ToolCallDetailsDialog.tsx`; after targeted `bunx oxfmt` on those two files, `bun run fmt:check` passed.
- `bun run lint` passed with 156 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and left `bun.lock` unchanged.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m6s. `@synara/web` passed 182 files / 2164 tests. `synara` passed 135 files with 1 skipped file, 1456 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.1`, and `npm run lint` passed.

## 0.3.0 - 2026-06-24

### Added

- Added first-class Automations as a real Synara workspace surface, including contracts, persistence, scheduler leases, run tracking, RPC methods, sidebar navigation, list/detail routes, Current/Paused views, inline detail editing, previous-run history, and triage actions.
- Added automation scheduler and composer flows so saved prompts can run manually, once, on intervals, daily, on weekdays, weekly, or from cron-like schedules.
- Added heartbeat automations that continue an existing target thread on each scheduled wake while preserving the normal provider/session/approval/worktree pipeline.
- Added AI-evaluated heartbeat stop clauses through completion policies, natural-language stop conditions, completion-evaluation results, and visible stop reasons in run history.
- Added a dedicated background queue for AI stop checks so slow or stuck completion evaluation does not block automation reconciliation.
- Added timeout handling for stop evaluation, recording a visible warning result and keeping the heartbeat alive when the evaluator stalls.
- Added automation recovery and scheduler observability for swallowed recovery failures and scheduler lease contention.
- Added DST and long-downtime scheduler coverage for spring-forward gaps, fall-back duplicate hours, and coalesced missed interval runs.
- Added generic chat file attachments alongside image attachments, with shared contracts, upload storage, composer paste/drop support, provider prompt projection, optimistic timeline rendering, Kanban dispatch, recap/bootstrap support, and reusable file attachment cards/chips.
- Added automation cards in the chat transcript after automation creation, and added thread automation summaries in the Environment panel.
- Added blob-based browser download handling for local image/generated markdown image downloads so failed local-image responses stay inside Synara instead of navigating the app window to an API error page.
- Added OpenCode CLI-only model discovery fallback so the model picker can still discover available models when the managed server or inventory path fails.
- Added profile skill usage counting coverage for retention-hidden threads and repeated slash/dollar skill invocations.

### Changed

- Bumped Synara release package versions to `0.3.0` across the server, desktop, web, and contracts packages.
- Reworked automation UI toward a Codex-style surface, including the sidebar badge, Current/Paused list, centered detail layout, inline rail editing, schedule editing, target-thread display, max-iteration controls, stop-on-error handling, and previous-run actions.
- Expanded automation composer parsing and review so explicit/generated prompts, schedule phrases, stop clauses, bounded fast loops, restored plan source metadata, queued plan follow-ups, and inline composer editing are handled consistently.
- Made generated automation intents require confirmation before creation, while preserving deterministic local auto-submit behavior for explicitly parsed bounded fast loops.
- Tightened automation cache updates by guarding live definition/run upserts with `updatedAt` and handling equal timestamps without letting stale events roll back newer cache rows.
- Consolidated scheduler-critical SQL around pending completion evaluation and run listing, including a shared view and a bounded evaluation backlog.
- Scoped OpenCode/Kilo server startup and CLI discovery to the request/session cwd, avoided cross-cwd warm server reuse, preserved OpenCode resume cwd, and stopped replacing file config with synthetic empty config content.
- Treated omitted Claude interaction mode as the default/base permission so fresh threads do not inherit sticky plan mode from the previously active thread.
- Preserved attachment-bearing plan follow-ups by routing them through the normal send path while keeping source plan metadata, including queued sends.
- Made composer image blob URL ownership clearer by revoking on normal clears while preserving ownership for optimistic handoff.
- Made composer dropzone generic-file support explicit and visibly rejected unsupported Kanban task files.
- Kept Environment panel open/close preference stable across chat switches while defaulting constrained/floating chat layouts to a calmer closed panel.
- Avoided full thread subscription for file previews and reused thread runtime workspace resolution so worktree-backed chat file/PDF links open in the correct right-dock preview root.
- Included retention-hidden threads in profile stats while still excluding manually deleted threads and deleted projects.

### Fixed

- Fixed automation lifecycle bugs around crash replay, failed-run rollback, duplicate scheduled occurrences, in-flight guards, terminal run transitions, cancellation behavior, and failed update rollback.
- Fixed automation worktree cleanup when standalone thread creation fails or cancellation wins before durable thread ownership exists.
- Fixed automation approval-wait reconciliation so a heartbeat run re-checks turn ownership before leaving `waiting-for-approval`, avoiding resurrection after a different turn takes over the target thread.
- Fixed a completion-evaluation race where a background stop check could clobber a user's archived/read state on the same automation run.
- Fixed stale completion-evaluation results being accepted after an automation changed before evaluation finished.
- Fixed automation review regressions around draft-thread promotion, restored source-thread metadata, source plan persistence, reruns, triage/detail actions, and provider start options.
- Fixed local image downloads so failed `/api/local-image` responses cannot replace the desktop renderer with a plain `Not Found` page.
- Fixed deleted chats staying visible by removing successful deletes from client projections immediately, adding client tombstones, and keeping archived bulk deletes responsive.
- Fixed worktree-backed file/PDF previews from chat links so absolute paths under a materialized worktree do not fall back to the default editor/main surface.
- Fixed OpenCode model discovery fallback so a failed server/inventory path no longer leaves the UI looking like only static GPT-5 is available.
- Fixed OpenCode provider config and sticky plan-mode behavior around cwd-scoped discovery, resume cwd, and fresh-thread bootstrap.
- Fixed attachment handling issues around attachment caps, server normalization rollback, unsupported files, plan follow-ups, image URL cleanup, and attachment drag/drop audit findings.
- Fixed profile skill counts so repeated `/skill` or `$skill` tokens in one prompt count correctly without double-counting structured skill references.
- Fixed release-blocking typecheck drift in automation worktree cleanup tests by asserting the created worktree branch before using it.
- Fixed formatting drift in the automation service test and local image preview download error description.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 151 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing large web chunk/plugin timing warnings, the Astro `transformWithEsbuild` deprecation warning, and the desktop `tsdown.config.ts` typeless-module warning.
- `bun run test` passed: 10 tasks successful in 8m53s. `@synara/web` passed 180 files / 2102 tests. `synara` passed 135 files with 1 skipped file, 1418 passed tests, and 6 skipped tests. The server suite was long-running but completed cleanly without a teardown stall.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.0`, and `npm run lint` passed.

## 0.2.41 - 2026-06-17

### Added

- Added a compact chat-header handoff menu so handoff threads can be created directly from the active chat header again.
- Added provider-target filtering for the handoff menu so only currently usable handoff destinations are offered.

### Changed

- Bumped Synara release package versions to `0.2.41` across the server, desktop, web, and contracts packages.
- Kept the shared project-action dialog path mounted while hiding the visible inline project script runner from the chat header.
- Improved header handoff failure handling by checking provider send availability before creating a handoff and showing a toast when the target is unavailable.

### Fixed

- Fixed the missing header handoff action after the previous chat-header cleanup.
- Fixed chat-header crowding from the project script runner while preserving the project action dialog plumbing used by other header actions.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and left the worktree unchanged.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- Root `bun run test` did not complete cleanly in two attempts: both runs reached a green `@synara/web` suite (169 files / 1954 tests), then stalled in the `apps/server` Vitest tail. The stale duplicate root/Vitest processes were stopped before continuing verification.
- Direct `bun run test` from `apps/server` also stalled before reporting test-file progress, only printing Node SQLite experimental warnings, so it is not counted as passed.
- Direct package tests passed for the release-relevant and non-server packages: `apps/web` 169 files / 1954 tests, `packages/contracts` 9 files / 90 tests, `packages/shared` 24 files / 228 tests, `packages/effect-acp` 3 files / 24 tests, `apps/desktop` 19 files / 149 tests, and `scripts` 5 files / 36 tests.
- `apps/marketing` has no `test` script.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.41`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.4 - 2026-06-17

### Added

- Added focused route-restore recovery coverage so remembered chat routes wait for a fresh snapshot before falling back after restart.
- Added disabled-provider re-enable regression coverage for provider health refreshes.

### Changed

- Bumped Synara release package versions to `0.2.4` across the server, desktop, web, and contracts packages.
- Improved remembered chat route restore so stale empty startup snapshots do not immediately send users to the empty chat route.
- Removed the old handoff shortcut from the chat header to keep primary conversation controls quieter.

### Fixed

- Fixed app restart/chat restore behavior where a valid remembered thread could briefly appear missing while orchestration state was still loading.
- Fixed provider health refresh behavior around re-enabling disabled providers so availability state is less likely to remain stale.
- Fixed formatting drift in `apps/web/src/chatRouteRestore.ts` caught by `bun run fmt:check`.

### Verification

- `bun run fmt:check` initially failed on `apps/web/src/chatRouteRestore.ts`; after formatting that file, `bun run fmt:check` passed.
- `bun run lint` passed with 149 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- `bun run test` passed: 10 tasks successful, including `@synara/web` 169 files / 1954 tests and `synara` 129 files passed / 1 skipped with 1255 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.4`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.3 - 2026-06-16

### Added

- Added richer local profile statistics, including most-worked project, skill/agent usage, active hours, provider/model mix, reasoning usage, and token/activity heatmap data.
- Added compact pasted-text cards for large composer pastes, with line/character metadata, remove controls, restore-to-editor behavior, and expandable sent-message echoes.
- Added shared pasted-text parsing/serialization helpers and focused coverage for composer drafts, pasted text, assistant selections, terminal context, and transcript height handling.

### Changed

- Bumped Synara release package versions to `0.2.3` across the server, desktop, web, and contracts packages.
- Improved profile skill usage counting by combining structured skill references, mentions, agent references, and legacy text-token backfill while filtering obvious non-skill slash/dollar tokens.
- Kept large pasted prompt content out of the visible composer body by storing it as structured prompt context, making long prompts easier to scan and refine.

### Fixed

- Fixed message editing so pasted text blocks remain intact when a user edits a previous message.
- Fixed draft/edit preservation for structured prompt context so pasted text, terminal context, and assistant selections are less likely to be dropped or flattened across composer lifecycle changes.
- Fixed profile stats so prompt-block markup like pasted text, file comments, terminal context, and assistant selections does not pollute skill counting.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- `bun run test` passed: 10 tasks successful, including `@synara/web` 168 files / 1949 tests and `synara` 129 files passed / 1 skipped with 1246 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.3`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.2 - 2026-06-14

### Added

- Added richer profile and personalization surfaces, including profile stats, activity heatmap polish, profile editing updates, and settings panel refinements.
- Added soft-delete thread retention coverage so deleted thread data has clearer cleanup behavior during early WIP usage.
- Added release-test stability safeguards for child-process ACP fixtures and the server Vitest runner.

### Changed

- Improved live composer edit visibility so per-turn composer changes stay attached to the active turn lifecycle.
- Refined curated app/profile UI details across the settings, profile dialog, activity heatmap, and chat route.
- Changed the server test script to run Vitest files serially, avoiding Turbo teardown stalls caused by lingering server Vitest workers after otherwise-passing test runs.

### Fixed

- Fixed flaky `effect-acp` child-process fixture tests by giving slow process-backed assertions an explicit timeout.
- Fixed full root `bun run test` release validation getting stuck after green server test output by making the server package test runner deterministic under Turbo.
- Fixed formatting drift in the profile, retention, and chat-route files that had reached `main`.

### Verification

- `bun run fmt:check` initially failed on `apps/server/src/threadRetention.test.ts`, `apps/web/src/components/profile/ActivityHeatmap.tsx`, `apps/web/src/components/profile/EditProfileDialog.tsx`, `apps/web/src/components/settings/ProfileSettingsPanel.tsx`, and `apps/web/src/routes/_chat.tsx`; after formatting those files, `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- Initial full `bun run test` failed in `packages/effect-acp` on 5000ms child-process fixture timeouts, then repeated with timeouts in `packages/effect-acp/src/client.test.ts` and `packages/effect-acp/src/protocol.test.ts`. Targeted reruns passed after adding explicit fixture timeouts.
- A subsequent root `bun run test` reached green server test output but did not return because the server Vitest process kept worker forks alive during Turbo teardown. Direct server testing showed the suite exits cleanly with `--maxWorkers=1 --no-file-parallelism`, so the server test script was updated accordingly.
- Final `bun run test` passed: 10 tasks successful, including `@synara/web` 167 files / 1935 tests, `effect-acp` 3 files / 24 tests, and `synara` 129 files passed / 1 skipped with 1241 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.2`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.1 - 2026-06-14

### Added

- Added inline file comments from composer and preview surfaces, including line comment boxes, comment summary chips, draft persistence, reference attachment support, chat timeline rendering, and file-comment parsing helpers.
- Added startup turn reconciliation for provider restarts so Synara can recover unfinished turns from persisted runtime state instead of leaving stale active work behind.
- Added an ACP idle watchdog used by ACP-backed providers so quiet turns can complete or fail more predictably when runtime events stop flowing.
- Added partial workspace reference lookup helpers and tests so shortened file references can resolve to the intended workspace entry.

### Changed

- Scoped live changed-file activity to the active turn by carrying active turn identity through provider runtime ingestion, Codex/Claude adapter events, checkpoint handling, chat selectors, and composer live-change headers.
- Improved workspace file opening from chat and preview references so missing prefixes or partial paths are handled through shared workspace file-system logic.
- Refined provider restart recovery across Cursor, Grok, OpenCode, runtime ingestion, command cleanup, and shared thread summaries so session state is less likely to drift after reconnects.
- Extended comment and reference handling through kanban dispatch, terminal context, composer attachments, editor workspace, dock preview, and compact composer controls.

### Fixed

- Fixed stale live changed-files panels that could show file edits from a previous or inactive turn.
- Fixed partial file references failing to open when assistant output did not include the full workspace-relative path.
- Fixed restart and idle-watchdog paths that could leave turns hanging after provider interruption, reconnect, or quiet ACP runtime behavior.
- Fixed composer/file-preview context loss when attaching line comments to a prompt or preserving them across draft updates.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 146 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; marketing still reports the `transformWithEsbuild` deprecation warning; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First full `bun run test` before release-note edits did not complete cleanly: visible server integration and checkpoint suites passed, including `integration/orchestrationEngine.integration.test.ts` and `src/orchestration/Layers/CheckpointReactor.test.ts`, but the root Turbo/Vitest run stopped producing output during teardown with two server Vitest worker forks still alive. The stale `bun`/`turbo`/Vitest process group was interrupted, so this run is not counted as a full pass.
- Final `bun run test` from `apps/web` passed: 165 files passed, 1909 tests passed.
- Final `bun run test` from `packages/effect-acp` passed: 3 files passed, 24 tests passed.
- Final direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 128 files passed, 1 skipped; 1238 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.1`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.0 - 2026-06-13

### Added

- Added a secure in-app PDF previewer backed by pdf.js, including page rendering, toolbar controls, zoom helpers, page navigation state, container sizing, document loading, page render cancellation, and PDF link normalization.
- Added `PdfFilePreview`, `WorkspaceFilePreview`, and a shared preview header so the right dock and editor workspace can render source files, images, markdown, and PDFs through one consistent preview path.
- Added authenticated local preview route coverage for image/PDF files, including workspace and scratch-workspace allowlists for generated local artifacts.
- Added Pi plugin/ACP startup prompt handling, model discovery support, cwd/session routing, provider service safeguards, and a mock ACP agent for focused provider tests.
- Added Cmd+L composer focus support across keybinding metadata, server/web keybinding definitions, shortcut-sheet data, and tests.
- Added markdown task-list parsing/rendering so checklist-style assistant output displays as task lists instead of plain bracket text.
- Added workspace file opener helpers, local preview URL helpers, file reference context-menu helpers, PDF zoom/link/navigation tests, chat view selector coverage, session logic tests, and extra right-dock runtime activation coverage.

### Changed

- Reworked file preview ownership by moving large preview behavior out of `EditorWorkspaceView` and into reusable preview components shared with the dock pane.
- Replaced the older nested changed-files tree/turn-diff-tree path with a flatter changed-files UI and simpler file-list behavior.
- Optimized chat startup and timeline derivation by tightening chat view selectors, route state handling, timeline ordering, collapsed settled-turn behavior, and timeline height calculations.
- Refined right-dock pane metadata and activation so file preview, PDF preview, and dock pane lifecycle state stay more predictable across chat/editor surfaces.
- Improved composer/user-input polish around inline mention chips, composer banners, pending user input panels, provider model picker state, and shortcut labels.
- Refined local preview file handling by renaming the shared helper from local image-only logic to broader local preview-file logic.
- Updated open-in target launcher prop naming and editor launcher hooks to match the newer workspace/dock preview surfaces.

### Fixed

- Fixed unsafe PDF preview behavior by sanitizing annotation links, rejecting unsafe URL schemes, resetting navigation when a new document loads, and avoiding stale page proxies after switching PDFs.
- Fixed local preview exposure risks by tightening preview response CORS/auth behavior and ensuring local file access stays scoped to allowed workspace/scratch paths.
- Fixed scratch workspace path generation so thread-derived scratch folders cannot smuggle path separators or traversal segments.
- Fixed Pi plugin UI routing, startup prompt delivery, model discovery for extensions, and cwd handling for provider-backed sessions.
- Fixed Cursor message id handling and stale changed-files presentation cases.
- Fixed duplicate plan mode icons, stale plan sidebar state, and noisy inline project actions in the chat header.
- Fixed settled-turn collapse fallback and timeline tail behavior when visible turn ids are empty or transcript rows update during long-running work.
- Fixed local image/PDF preview cleanup cases so loaded PDF documents and text layers are destroyed or cancelled when switching files, pages, or zoom levels.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 144 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; marketing still reports the `transformWithEsbuild` deprecation warning; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First full `bun run test` before release-note edits did not pass: `apps/server/integration/orchestrationEngine.integration.test.ts` failed `runs a single turn end-to-end and persists checkpoint state in sqlite + git`, and `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts` failed `captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed`. The run then hung during teardown and was stopped after identifying and killing the stale `bun`/`turbo`/Vitest worker processes.
- Targeted rerun `bun run test src/orchestration/Layers/CheckpointReactor.test.ts -t "captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed"` from `apps/server` passed: 1 test passed, 15 skipped.
- Targeted rerun `bun run test integration/orchestrationEngine.integration.test.ts -t "runs a single turn end-to-end and persists checkpoint state in sqlite + git"` from `apps/server` could not reproduce the live integration test because the file uses `it.live`; the standard targeted Vitest command skipped all 12 tests.
- Final full `bun run test` after version and release-note edits did not pass: `packages/effect-acp/src/client.test.ts` timed out in `returns formatted invalid params when a typed extension request payload is wrong`, and `packages/effect-acp/src/protocol.test.ts` timed out in `does not emit a second process-exit error after a decode failure`. Turbo reported 7 successful tasks, canceled `synara:test` and `@synara/web:test` with code 130, and exited with `effect-acp#test` failed.
- Targeted rerun `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong"` from `packages/effect-acp` passed: 1 test passed, 4 skipped.
- Targeted rerun `bun run test src/protocol.test.ts -t "does not emit a second process-exit error after a decode failure"` from `packages/effect-acp` passed: 1 test passed, 16 skipped.
- Full `packages/effect-acp` rerun passed: 3 files passed, 24 tests passed.
- Full `apps/web` rerun passed: 164 files passed, 1894 tests passed.
- Direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 126 files passed, 1 skipped; 1214 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.0`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.9 - 2026-06-12

### Added

- Added Codex-style chat workspace folder creation and associated workspace/worktree metadata so generated chat files are easier to isolate per conversation.
- Added settings sidebar search deep links and related project/settings navigation polish.
- Added file-only workspace search refinements and stronger provider probe handling around Gemini-backed paths.

### Changed

- Reworked transcript turn collapse and live-tail behavior so collapsed work rows, latest-turn fallback, and active transcript scrolling stay calmer during long or partially visible turns.
- Improved browser session handling and copy-link flow behavior for in-app browsing and chat reference movement.
- Refined UI density controls, sidebar spacing, composer spacing, and settings page opening performance.
- Replaced bespoke editor project menu behavior with the shared `ProjectMenuPicker` path.
- Split kanban composer menu discovery from editor logic so each surface owns less unrelated state.
- Shared local image preview state and error-card handling across chat and editor views.

### Fixed

- Fixed transcript turn collapse and tail jitter cases where visible turn ids could be empty while a latest turn still had active work.
- Fixed browser/copy-link edge cases that could leave stale browser session state or awkward link movement.
- Fixed editor mode production feedback and local image preview duplication between chat and editor surfaces.
- Fixed settings page re-render churn caused by streaming ticks while opening settings.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 143 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First `bun run test` attempt visibly completed the long web/server/integration suites without an assertion failure, then hung during final server Vitest teardown with two workers still alive; it was interrupted and is not counted as a full pass.
- Final full `bun run test` after release-note and version edits failed in `packages/effect-acp/src/client.test.ts` on two 5000ms timeouts: `returns formatted invalid params when a typed extension request payload is wrong` and `replays buffered notifications to handlers registered after they arrive`. Turbo canceled `synara:test` with code 130 after the `effect-acp` failure, so the full run is not counted as passed.
- Targeted rerun `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong|replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed: 2 tests passed, 3 skipped.
- Full `packages/effect-acp` rerun passed: 3 files passed, 24 tests passed.
- Full `apps/web` rerun passed: 160 files passed, 1838 tests passed.
- Direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 125 files passed, 1 skipped; 1197 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.9`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.8 - 2026-06-11

### Added

- Added an editor workspace view beside chat, including file browsing, workspace view state, syntax highlighting, file reference selection, code selection actions, and focused tests around editor metadata, workspace file-system APIs, workspace entries, chat references, and route state.
- Added native editor app discovery and icon caching, with authenticated editor icon routes, shared editor icon path constants, icon rendering in the web app, and broader launcher coverage for Ghostty, Terminal, JetBrains, Xcode, Zed, Cursor, VS Code, and platform-specific fallbacks.
- Added a unified provider skills catalog with provider-root awareness, shared skill ownership display, provider skill prompt injection, skills settings UI/model state, and coverage for Codex/Cursor/native-discovery fallbacks.
- Added provider status/auth refresh plumbing on focus and root orchestration events so Codex auth overlays and provider discovery state recover without stale UI.
- Added composer footer layout helpers, file reference parsing helpers, relative time utilities, syntax highlighting helpers, diff route search, and extra web tests for composer layout, file icons, provider updates, and root invalidation.

### Changed

- Refined the chat header, chat view, composer controls, model/trait/open-in pickers, inline chips, transcript selection actions, and code-selection flows so references and controls stay easier to scan during active work.
- Reworked the diff panel toolbar, file list, and patch viewport behavior to make large diffs easier to navigate from both repository and turn contexts.
- Reworked provider skill discovery so provider-native skill lists can merge with Synara's catalog and fall back cleanly when a provider cannot answer.
- Reconciled legacy migration trackers before running migrations and tightened older sidechat/pinned-thread migration paths.
- Updated desktop stage dependency overrides to keep `@pierre/diffs` pinned to `1.2.8`.
- Tightened terminal environment propagation, terminal manager behavior, workspace path containment, and provider command/runtime plumbing around recent server contracts.

### Fixed

- Fixed stale Codex auth overlay behavior so installed/authenticated Codex states refresh more reliably.
- Fixed skill settings provider display so only providers that actually own a skill are shown for shared skill entries.
- Fixed Ghostty/open-in behavior and native icon sizing so editor launchers open the intended project path and render consistently with other picker icons.
- Fixed file reference selection and mention/chip rendering edge cases across composer text, sent user bubbles, and markdown/code selection surfaces.
- Fixed migration startup edge cases for early installs that still had legacy tracker state.
- Fixed several provider discovery and skill catalog edge cases around missing native provider binaries, invalid provider responses, and provider-root normalization.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 159 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First `bun run test` attempt was interrupted by SIGTERM after partial success; no assertion failure was reported before termination, and `@synara/web:test` had already passed 152 files / 1740 tests.
- Final rerun `bun run test` after version and release-note edits passed: 10 tasks successful; scripts 5 files / 36 tests, desktop 19 files / 149 tests, contracts 9 files / 90 tests, shared 22 files / 188 tests, effect-acp 3 files / 24 tests, web 152 files / 1740 tests, server 123 files passed / 1 skipped with 1187 passed / 6 skipped.
- The rerun still logged expected test-harness WARN/ERROR lines from failure-path coverage and native binding/provider-binary mocks.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.8`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.7 - 2026-06-10

### Added

- Added Claude Fable 5 to the Claude and Cursor model surfaces, including the shared model contract, Cursor model variants, keybinding metadata, provider discovery invalidation, and focused model-picker coverage.
- Added Cursor ACP model discovery and refresh handling so Cursor-backed sessions can recover from stale, partial, or invalid model state more reliably.
- Added provider usage infrastructure for Codex, Claude, Cursor, and Gemini, including credential discovery, provider-specific parsers, shared display helpers, SQLite-backed snapshot caching, server RPC routes, and client snapshot normalization.
- Added provider usage UI in chat and settings: Environment panel usage rows, compact usage menu controls, progress tracks, line lists, limit rows, rate-limit opening helpers, and provider usage settings navigation.
- Added desktop backend Node option handling and tests, memory diagnostics, WebSocket stream backpressure guards, and provider runtime ingestion buffer coverage.
- Added centralized Windows desktop caption controls, top-bar gutter support, preload IPC wiring, and focused browser/unit coverage for sidebar, keybinding, composer, usage, and provider discovery paths.

### Changed

- Reworked the composer model/options picker flow so split pickers are used where they help, empty threads stay focused, and stacked composer panels share steadier sizing/content helpers.
- Refined Cursor provider integration around ACP capability checks, model support parsing, discovery refreshes, provider health, and adapter behavior.
- Unified provider usage display and pacing logic across server snapshots, shared helpers, React hooks, settings panels, and in-chat usage sections.
- Tightened Codex app-server recovery, backend memory limits, and streaming behavior so reconnects, partial streams, and live provider updates stay more predictable.
- Refined Windows desktop chrome to keep native-style controls in one fixed cluster and avoid custom titlebar paths outside Windows.
- Updated Linux download metadata to use the current `-x64` AppImage asset naming.

### Fixed

- Fixed plugin mention icons in sent user bubbles so selected plugin/file identity is preserved after sending.
- Fixed provider discovery invalidation so refreshed model lists can update the UI without stale model state lingering.
- Fixed usage parsing/display edge cases for provider-specific quota and pacing data.
- Fixed composer stacked panel sizing, queued/live-change header alignment, and trait-picker behavior around compact controls.
- Fixed sidebar/search palette state and route metadata edge cases covered by new tests.
- Fixed WebSocket backpressure and buffered provider-runtime ingestion cases that could otherwise leave live updates stale under load.

### Verification

- `bun run fmt:check` initially failed on `apps/web/src/routes/__root.tsx`; after formatting that file with `bunx oxfmt apps/web/src/routes/__root.tsx`, `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` initially failed in `apps/web/src/components/chat/TraitsPicker.browser.tsx`, `apps/web/src/store.ts`, `apps/server/src/provider/Layers/CursorAdapter.ts`, and `apps/server/src/wsRpc.ts`; after targeted fixes, `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings.
- `bun run test` failed in `packages/effect-acp/src/client.test.ts` on `returns formatted invalid params when a typed extension request payload is wrong` and `replays buffered notifications to handlers registered after they arrive`, both with 5000ms timeouts; Turbo then canceled `synara:test` and `@synara/web:test` with code 130.
- `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong|replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed (2 tests passed, 3 skipped).
- `bun run test` from `packages/effect-acp` passed (3 files passed; 24 tests passed).
- `bun run test` from `apps/server` passed (118 files passed, 1 skipped; 1136 tests passed, 6 skipped).
- `bun run test` from `apps/web` passed (147 files passed; 1690 tests passed).
- Final `bun run fmt:check` passed.
- Final `bun run lint` passed with 148 warnings, 0 errors.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.7`.

## 0.1.6 - 2026-06-09

### Added

- Added transcript text markers with orchestration events, projection persistence, migration `042_ProjectionThreadsMarkers`, shared marker validation, transcript selection actions, marker-aware scrolling, and an Environment panel marker section.
- Added website favicon support for markdown links, composer/user-bubble link chips, and bare-domain link parsing, backed by a server-side favicon cache and authenticated favicon image route.
- Added local server monitoring, project-run tracking, local-server Environment panel rows, sidebar/project-run controls, and WebSocket/RPC contracts for listing and stopping tracked dev servers.
- Added terminal/project visual identity helpers and project-run target/running helpers so local server and terminal surfaces can share clearer labels and icons.
- Added focused tests for marker round-trips, marker scrolling, local server monitoring, project run targets, terminal visual identity, favicon parsing/cache behavior, and link chip parsing.

### Changed

- Refined transcript rendering and timeline behavior so marker navigation, markdown highlights, collapsed work disclosures, and auto-scroll follow logic are less likely to fight each other.
- Unified link rendering across AI responses, composer chips, and sent user bubbles so site identity, favicon fallback, alignment, and medium-weight text stay consistent.
- Reworked local-server discovery around listener address-family metadata, project ownership matching, and tracked PTY/dev-server state.
- Refined recent view switching, browser panel identity, terminal chrome sizing, and local server display state around project-aware surfaces.
- Tightened orchestration projection and provider/runtime handling around markers, thread updates, local server state, and terminal/runtime cleanup.

### Fixed

- Fixed retired model picker keybindings so shortcuts keep working when hidden/retired model entries are present.
- Fixed collapsed work disclosures retriggering tail-scroll behavior after output had already settled.
- Fixed formatter drift in `apps/server/src/wsRpc.ts` and `apps/web/src/lib/serverReactQuery.ts`.
- Fixed the local-server test fixture to include the required listener address `family` field.
- Fixed bare domains such as `linear.app/...` being ignored by composer/user-bubble link chip parsing while full `https://...` links worked.

### Verification

- `bun run fmt:check` initially failed on `apps/server/src/wsRpc.ts` and `apps/web/src/lib/serverReactQuery.ts`; both files were formatted and the rerun passed.
- `bun run lint` passed with 145 warnings, 0 errors.
- `bun run typecheck` initially failed in `apps/server/src/devServerManager.test.ts` because a `ServerLocalServerProcess` fixture lacked `family`; after the fixture fix, `bun run typecheck` passed.
- `bun run release:smoke` passed.
- `bun run build` passed.
- `bun run test` failed in `packages/effect-acp/src/client.test.ts` on `replays buffered notifications to handlers registered after they arrive` with a 5000ms timeout; Turbo canceled the server test package afterward with code 130.
- `bun run test src/client.test.ts -t "replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed (1 test passed, 4 skipped).
- `bun run --cwd apps/server test -- --reporter verbose --maxWorkers=1` passed (112 files passed, 1 skipped; 1108 tests passed, 6 skipped).
- `bun run test` from `apps/web` passed (140 files passed; 1657 tests passed).
- `bun run test` from `packages/contracts` passed (9 files passed; 90 tests passed).
- `bun run test` from `packages/shared` passed (21 files passed; 183 tests passed).
- `bun run test` from `apps/desktop` passed (18 files passed; 141 tests passed).
- `bun run test` from `scripts` passed (5 files passed; 36 tests passed).
- `apps/marketing` has no `test` script.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.6`.

## 0.1.5 - 2026-06-08

### Added

- Added macOS update artifact smoke tooling, zip finalization helpers, and boolean environment parsing tests for the desktop release path.
- Added focused diff panel components for the toolbar, file jump menu, file list, patch viewport, and selector helpers.
- Added browser/unit coverage for queued turn auto-dispatch, plan-mode queued chat turns, composer stacked panel framing, diff view-source logic, provider discovery, markdown rendering, and mention/file icon behavior.

### Changed

- Refreshed README/release messaging and Synara desktop update flow documentation around the current app positioning.
- Reworked the diff panel around explicit repo-vs-turn state, searchable file filtering, and smaller view components.
- Unified composer stacked panels above the input so plan activity, queued follow-ups, and live file-change rows share width, border, radius, and dark-mode opacity.
- Refined chat markdown spacing, composer command menu selection, provider/plugin discovery normalization, and file/plugin icon rendering in sent messages.

### Fixed

- Fixed queued chat dispatch so queued turns preserve their own interaction mode, attachments, and prompt while a plan follow-up is pending.
- Fixed live file-change composer chrome so it appears only for active turns with actual provider file edits.
- Fixed draft/reference handling so selected plugin and file mentions keep their structured references and icons after navigation or reload.
- Removed the older update-feed cache path in favor of the newer resumable update download coverage.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with 145 warnings, 0 errors)
- `bun run typecheck` (passes with TS44 informational messages about JSON usage in tests/protocol files)
- `bun run release:smoke`
- `bun run build` (passes; Vite still warns about large web chunks and plugin timings)
- `bun run test` (failed once: `packages/effect-acp/src/client.test.ts` timed out in `replays buffered notifications to handlers registered after they arrive`)
- `bun run test src/client.test.ts -t "replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` (targeted rerun passed: 1 test passed, 4 skipped)
- `bun run test src/whatsNew/logic.test.ts` from `apps/web`
- `bun run test src/components/ChatMarkdown.test.tsx` from `apps/web`
- `bun run test` from `apps/web` (132 test files passed; 1588 tests passed)
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website`

## 0.1.4 - 2026-06-07

### Added

- Added project, thread, and message pinning across the orchestration projection, persistence layer, shared pin helpers, sidebar state, environment panel, and focused web stores.
- Added environment-panel pinned-message management and autosaved thread notes so durable context can live beside the transcript without being mixed into the chat stream.
- Added a recent-view switcher with keyboard navigation, keycap hints, route activation logic, persistent recent-view tracking, and browser/unit coverage.
- Added resumable desktop update download infrastructure with dedicated tests for partial files, persisted metadata, retry behavior, and interrupted download recovery.
- Added pull-availability data to the Git contract/server/web path so Git action controls can reflect whether pull is actually safe and useful for the current branch.
- Added broader tests for keybindings, composer mentions, composer drafts, pinned projects/threads/messages, thread detail prewarming, recent views, migrations, and release browser flows.

### Changed

- Reworked the sidebar/project/thread pinning model around shared logic so pinned state is projected consistently after reloads, legacy migration reconciliation, and snapshot refreshes.
- Expanded the chat environment surface with dedicated pinned and notes sections, tighter environment row styling, and shared action hooks for pin/unpin flows.
- Tightened composer behavior around mention icons, draft references, queued headers, picker styling, compact controls, and empty-chat controls.
- Improved runtime resilience around external Claude shutdowns, terminal manager cleanup, websocket RPC error flow, and provider session recovery.
- Refined projection snapshot queries and pipeline behavior so pinned messages, notes, and project pins are present in thread detail and orchestration snapshots.
- Updated release/browser tests and mocks around the recent switcher, keybindings, and app release surfaces.

### Fixed

- Fixed pinned-state migrations and legacy reconciliation so older projected thread data can upgrade cleanly.
- Fixed composer mention icon rendering and draft reference handling.
- Fixed release browser tests by adding switcher keycap coverage and the needed test mock.
- Fixed Git action availability checks that previously had to infer pull state too late in the UI.
- Fixed external Claude SIGTERM handling so an outside shutdown is treated as a benign suspended session instead of a failed turn.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with 138 warnings, 0 errors)
- `bun run typecheck` (passes with TS44 informational messages about JSON usage in tests/protocol files)
- `bun run release:smoke`
- `bun run build` (passes; Vite still warns about large web chunks and plugin timings)
- `bun run test` (109 test files passed, 1 skipped; 1068 tests passed, 6 skipped; 6m13s)
- `bun install` after version bump to update `bun.lock`
- `bun run test src/whatsNew/logic.test.ts` from `apps/web` after release-note edits (12 tests passed)
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website`

## 0.1.3 - 2026-06-05

### Added

- Added in-app thread recap support with provider-backed generation, cached recap state, current-state context, and tests around recap assembly.
- Added richer agent activity detail surfaces so subagent/task rows can be opened and inspected from the transcript flow.
- Added release notes for `0.1.3` to the built-in What's New / Release History data.

### Changed

- Reworked transcript, chat header, environment panel, Git action, branch toolbar, and queued composer rendering so busy sessions remain easier to scan.
- Computed repo diff totals once in `ChatView` and reused them across the header and environment panel, avoiding duplicate large-patch parsing during live updates.
- Streamlined archived-thread deletion through shared client helpers, including optimistic local removal, batched worktree-linked cleanup, and a single shell snapshot reconciliation.
- Made desktop update UI quieter during background polling and kept production web/server/desktop sourcemaps disabled by default unless explicitly enabled for diagnostics.
- Tightened terminal runtime cleanup, shell summary handling, provider activity ingestion, and session handoff safeguards.
- Refined composer attachment, reference chip, queued row, and compact control spacing for a cleaner release build.

### Fixed

- Fixed TypeScript exact-optional-property failures in optional callback pass-throughs.
- Fixed recap generation test doubles to use the shared `ThreadRecapGenerationInput` contract.
- Updated image attachment chip tests to match the current compact thumbnail UI.
- Preserved the final archived-thread and diff-total behavior with focused tests.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with existing warnings)
- `bun run typecheck`
- `bun run release:smoke`
- `bun run build`
- `bun run test`
- `bun run test integration/orchestrationEngine.integration.test.ts -t "reverts to an earlier checkpoint and trims checkpoint projections"`
- `bun run test integration/orchestrationEngine.integration.test.ts -t "forwards thread.turn.interrupt to claudeAgent provider sessions"`
- `bun run test -- src/lib/archivedThreadDelete.test.ts src/components/chat/ComposerImageAttachmentChip.test.tsx src/whatsNew/logic.test.ts`
- `bun run test -- src/git/Layers/GitManager.test.ts -t "thread recap|commit message|status"`
