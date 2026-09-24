---
name: verify
description: Run an isolated Synara instance and verify UI behavior with real provider sessions.
---

# Verify: run Synara locally for runtime verification

How to launch an isolated Synara instance (server + web) to observe UI changes, without touching `~/.synara` or the default dev ports.

## Launch

```bash
# 1. Server (from the directory you want as the workspace/project cwd):
SYNARA_HOME=<scratch>/synara-home \
SYNARA_PORT=3899 SYNARA_MODE=web SYNARA_NO_BROWSER=1 \
VITE_DEV_SERVER_URL=http://localhost:5899 \
bun <repo>/apps/server/src/index.ts &

# 2. Web (vite dev):
cd <repo>/apps/web && PORT=5899 VITE_WS_URL=ws://localhost:3899 bun run dev &
```

Then open http://localhost:5899/.

## Gotchas

- Preflight the ports before launching: run `lsof -nP -iTCP:<port> -sTCP:LISTEN` on both the server and web ports (check IPv4 and IPv6 listeners — a `:::port` entry collides even when `127.0.0.1` looks free). If you use `scripts/dev-runner.ts dev`, read its dry-run output for the real port map first.
- `SYNARA_AUTH_TOKEN` is inherited from the launching shell: a server started with it set requires auth the web client does not have, which produces a healthy-but-disconnected UI. Unset it in the isolated test process only — never strip it from production policy.
- `VITE_DEV_SERVER_URL` on the **server** is required — without it the WS handshake from the vite origin is rejected with 403 (see `apps/server/src/trustedOrigins.ts`).
- `VITE_WS_URL` on the **web** side tells the app where the WS server lives (`apps/web/src/wsTransport.ts`).
- Default ports are 3773 (server) / 5733 (web), with no automatic per-checkout offset. The dev runner uses an explicit `SYNARA_PORT_OFFSET` or derives an offset from `SYNARA_DEV_INSTANCE` when supplied — pick explicit distinct ports and confirm the dry-run output to avoid colliding with a running dev instance.
- Add a disposable git workspace through the sidebar's **Projects → Add project**
  button and enter its absolute folder path. If New project in the composer
  picker does not open the dialog, use this sidebar entry point instead.
- To see diffs: select a git workspace with uncommitted changes, then click the **+N −N** toggle in the top-right chat header — it opens the DiffPanel (working-tree diff). No project/thread needed.
- Server tests: don't run the suite from a checkout under `/private/tmp` — `localImageRoute.test.ts` fails there (its "outside the workspace" fixture lands in an allowed temp root). It passes from a normal checkout and on CI.

## Playwright driving

Chrome extension may be unavailable; `playwright` is a devDependency of `apps/web` — import it by absolute path from `apps/web/node_modules/playwright/index.mjs` in a scratch script.

## Real provider feature verification

The Mind- and Kanban-specific bullets below describe the feature branches
under test (`agent/mind-feature-rebased`, `agent/kanban-v2-clean`), not
mainline UI — run them while checking out or merging those branches.

- Use an installed, authorized provider/model, selected explicitly in the UI.
  Wait for model discovery to resolve before sending; a new composer can briefly
  display loading placeholders or default to a different model than expected.
- A real UI-initiated turn exercises the browser WebSocket transport and provider
  gateway. Keep mechanical tool coverage separate from behavioral feature tests.
- For continual-learning memory, naturally teach a project preference without
  naming tools. Check its appearance in Mind, then ask a relevant question in a
  **new thread in the same project**. Expand the worked/tool rows to distinguish
  retrieval from conversation recollection or a plausible generic answer.
- If a natural targeted query misses a saved fact, retain that failure before
  trying a broad question about remembered facts. A successful broad recall does
  not retroactively prove spontaneous recall on the original task.
- To verify Mind auto-refresh, mount Mind before the agent saves, then leave it
  untouched for at least one polling interval. Navigating, refreshing, or editing
  a memory during the observation window is not independent polling evidence.
- Project chips require multiple memory-bearing projects. Use distinct facts in
  two disposable projects and verify each filter and each project profile.
- Kanban's overview and per-project board are separate views. Click the project
  heading for the four-column Attention board. For keyboard draft reorder, focus
  the inner card button before Alt+ArrowUp/Down.
- An idle-draft move-to-Done refusal requires a draft **without a goal**. Setting
  a goal can start provider work and invalidate that precondition. Read the card
  immediately before the probe, and retain the exact runtime error.
- Do not manufacture aged/stale or high-volume cap evidence by mutating a live
  database. Use authorized fixtures or report those coverage gaps explicitly.

## Groups-web testing (group panel, group threads, library)

- There is no UI path to open a chat inside an unconfigured group (the group row
  only expands; "New thread" on the threads surface opens Create project). To get
  a group thread, register a client-side draft in DevTools console:
  `(await import('/src/composerDraftStore.ts')).useComposerDraftStore.getState()
.registerDraftThread('<uuid>', {projectId:'<realProjectId>', entryPoint:'chat',
createdAt:new Date().toISOString(), envMode:'local'})`.
  Read the real projectId from `useStore.getState().projects` — do not type it
  from notes; a mistyped id resolves to no project, `isGroupContainer` stays
  false, and the Group/Library header toggles silently disappear. Repoint a wrong
  id with `setDraftThreadContext(threadId, {projectId})`.
- For navigation that must keep drafts alive, use
  `(await import('/src/appNavigation.ts')).appHistory.push('/<threadId>')`.
  Typing a URL in the address bar is a full reload: drafts are lost and any id
  not in `useStore.threads`/`draftThreadsByThreadId` bounces to a fresh chat via
  createFreshChat. Coordinator/agent threads are not in `threads`, so their
  URLs are not deep-linkable after reload — use in-session nav or a draft.
- Store/logic probes (DevTools console via cmd+alt+j — `read_dom`/
  `browser_console` tools report "Chrome is not in the foreground"):
  `useStore.getState()` from `/src/store.ts` (threads, projects,
  sidebarThreadSummaryById, threadsHydrated); `/src/workspacePathsStore.ts`
  (groupsWorkspaceRoot); `/src/lib/groupProjects.ts` (isGroupContainerProject);
  `/src/storeSelectors.ts` (createProjectSelector). Settings live in
  `localStorage['synara:app-settings:v1']` (e.g. showGroupsSection).
- Library panel refresh: the library root is
  `<SYNARA_HOME>/dev/project-context/<projectId>/library`; `library.list` uses
  fs.readdir, so files/dirs created on disk appear without UI actions. Refresh
  is triggered by the window `focus` event — do a real OS-level blur/focus
  (`open -a TextEdit`, then re-activate the specific Chrome window via the
  Window menu; `open -a "Google Chrome"` may surface a different Chrome window).
- Coordinate mapping on the test Mac: real display 1600x1200, tool screenshot
  space 1024x768 (≈0.64 scale, +~88px browser chrome y). With DevTools docked,
  innerWidth≈1045 and the page is the left ~669px of the screenshot — get DOM
  positions via `getBoundingClientRect()` in console, click `(x*0.64,
(88+y)*0.64)`. In-app toasts can cover the header panel toggles.
- GroupSettingsDialog saves without provider credentials (falls back to
  codex/gpt-5-codex) and creates the coordinator thread server-side; the
  coordinator's first turn then errors "Codex CLI is not installed" — expected
  in a no-credential env, not a config failure.

## Devin Secrets Needed

None for an already available no-auth provider/model in an isolated instance.
Otherwise obtain the chosen provider's required credential through the approved
secret mechanism; never put secret values in this skill or test artifacts.
