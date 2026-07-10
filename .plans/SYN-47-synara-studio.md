# SYN-47 — Synara Studio (head-to-toe implementation plan)

> Execution target: **GPT‑5.5 @ xhigh via the Codex plugin.**
> After Codex lands the functional implementation, a human/Claude pass does the **UI refinement**.
> Linear: https://linear.app/emanueledpt/issue/SYN-47

---

## 1. Goal (what we are building)

Add a **"Studio"** experience to Synara that is a near-exact clone of the existing **Chats / Threads**
experience, exposed as a new segment in the sidebar's segmented picker (so it reads **`Threads | Studio`**).

- Studio shows the **same folder selector** as Chats (`ProjectPicker`) and lists **studio-chats** grouped
  under folders, using the **same UI and logic** as Threads. Reuse, do not reinvent.
- Studio chats are **normal AI threads** (full chat surface, any provider) — but their working directory is
  rooted at **`~/Documents/Synara/Studio`**, so anything the agent writes lands there, e.g.
  `~/Documents/Synara/Studio/Outbox/Content/2026-06-09_synara_local_dev_server_x_posts.md`.
- The Studio folder layout **mirrors how Claude lays out `~/Documents/Claude`** (structure only — we copy the
  shape, not the contents, and Studio is **not** connected to the Claude provider in any way).

### Locked decisions (from the issue author)
1. **Picker layout:** Add Studio as a new segment → `Threads | Studio`. **Do NOT remove the existing Workspace
   feature** — it stays gated by `showWorkspaceSection` (default `false`) exactly as today. With Workspace off
   (the default) the picker shows `Threads | Studio`. With Workspace also on it shows `Threads | Studio | Workspace`.
2. **Folders:** Mirror `~/Documents/Claude/*` structure under `~/Documents/Synara/Studio`. Single shared
   Studio root; all studio output accumulates under `Studio/Outbox/Content/`.
3. **Provider:** Studio is **NOT** linked to Claude. New studio chats inherit the **global default provider**
   (same as a normal new chat). "Study how Claude does it" referred only to copying the folder structure.

---

## 2. Mental model / how it maps onto existing code

The codebase already has a "**home chat container**" pattern we copy almost verbatim:

- A hidden project with `kind: "chat"` rooted at `chatWorkspaceRoot` (= `~/Documents/Synara`) acts as the
  backing container for all general chats. Created lazily by `ensureHomeChatProject`
  (`apps/web/src/lib/chatProjects.ts`). Identified by `isHomeChatContainerProject`.
- General chats are just **threads** under that container.

**Studio is the same pattern with a new project kind:**

- Add `ProjectKind` value **`"studio"`**.
- A hidden **Studio container** project (`kind: "studio"`) rooted at **`studioWorkspaceRoot`**
  (= `~/Documents/Synara/Studio`). Lazily ensured by a new `ensureStudioProject`.
- Studio chats are **threads under the studio container**.
- **A thread is a "Studio chat" iff its project's `kind === "studio"`.** This single discriminator drives
  sidebar routing/filtering, the active segment, and cwd resolution.

### Why `kind: "studio"` gives us the right cwd for free
`resolveThreadWorkspaceCwd` (`apps/server/src/checkpointing/Utils.ts:41-44`) only null-cases `kind === "chat"`:
```ts
const projectCwd =
  project?.kind === "chat" && !input.thread.worktreePath
    ? null
    : (project?.workspaceRoot ?? null);
```
`kind: "studio"` falls into the `else` and returns `project.workspaceRoot` → studio threads get a **real cwd**
of `~/Documents/Synara/Studio` with **no extra change** to this resolver. (Codex CLI/Claude SDK then run with
that cwd; outputs land under `Studio/Outbox/Content/…`.)

> ⚠️ **Exhaustiveness:** grep every `kind === "chat"` and `kind === "project"` usage and decide per-site whether
> `"studio"` should behave like `"chat"` (hidden container, no git assumptions) or like `"project"`. Default:
> studio behaves like a **container** in the sidebar (hidden as a "project folder", surfaced only inside the
> Studio segment) but like a **project** for cwd (real workspace root). See the per-file notes below.

---

## 3. Folder structure to scaffold (mirror of `~/Documents/Claude`)

Reference (the user's actual Claude tree):
```
~/Documents/Claude/
  CLAUDE.md
  Context/            Inbox/            Logs/            Skills/
  Outbox/
    Content/  Daily/  Notion/  TikTok/  YouTube/
```
Create the equivalent under the Studio root the first time the Studio container is prepared:
```
~/Documents/Synara/Studio/
  Inbox/
  Context/
  Logs/
  Skills/
  Outbox/
    Content/
    Daily/
    Notion/
    TikTok/
    YouTube/
```
- Create directories only (idempotent `mkdir -p` semantics). Do **not** copy Claude's file contents.
- The essential one for this issue is `Outbox/Content/`; create the full set for parity.
- (Optional, nice-to-have) drop a minimal `Studio/README.md` describing the layout. Skip if it complicates the
  normalizer; not required for acceptance.

---

## 4. Implementation phases

Work bottom-up: contracts → server → shared → web state → web routes → sidebar → settings. Keep each phase
compiling. Run the full verification gate **once** at the end (see §6).

### Phase 0 — Contracts (`packages/contracts`) — schema only, no runtime logic

1. **`src/project.ts:18`** — extend `ProjectKind`:
   ```ts
   export const ProjectKind = Schema.Literals(["project", "chat", "studio"]);
   ```
2. **`src/server.ts`** (`ServerConfig` ~L87-97 and `ServerLifecycleWelcomePayload` ~L349-357) — add an optional
   `studioWorkspaceRoot`:
   ```ts
   studioWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
   ```
   Add it to **both** `ServerConfig` and the welcome payload, right after `chatWorkspaceRoot`.
3. Confirm `orchestration.ts` `project.create` / `project.meta.update` already accept `kind` via `ProjectKind`
   (they do) — no change beyond the union widening in step 1.

### Phase 1 — Server (`apps/server/src`)

1. **`config.ts`**
   - Add `readonly studioWorkspaceRoot: string;` to `ServerConfigShape` (after `chatWorkspaceRoot`, ~L48).
   - Add a resolver mirroring `resolveDefaultChatWorkspaceRoot`:
     ```ts
     export function resolveDefaultStudioWorkspaceRoot(input: {
       readonly homeDir: string; readonly platform?: NodeJS.Platform;
     }): string {
       const pathApi = (input.platform ?? process.platform) === "win32" ? pathWin32 : pathPosix;
       return pathApi.join(resolveDefaultChatWorkspaceRoot(input), "Studio");
     }
     ```
   - Set `studioWorkspaceRoot` in `ServerConfig.layerTest` (~L125) and wherever the real config is built.
2. **`main.ts`** (~L218 where `chatWorkspaceRoot` is set) — set
   `studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: userHomeDir })`.
3. **`effectServer.ts`** (~L145-153 welcome emit) and **`wsRpc.ts`** (~L498-512 `loadServerConfig` +
   ~L1045 welcome stream) — pass `studioWorkspaceRoot` through the welcome event and the config snapshot.
4. **`wsRpc.ts`** — add a `prepareStudioWorkspaceRoot` mirroring `prepareChatWorkspaceRoot` (~L405-418), but
   creating the Claude-mirror tree from §3:
   ```ts
   const prepareStudioWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
     const dirs = ["Inbox","Context","Logs","Skills","Outbox/Content","Outbox/Daily","Outbox/Notion","Outbox/TikTok","Outbox/YouTube"];
     for (const rel of dirs) {
       yield* fileSystem.makeDirectory(path.join(workspaceRoot, rel), { recursive: true }).pipe(/* same orElse as chat */);
     }
   });
   ```
   Export it alongside `canonicalizeProjectWorkspaceRoot` / `prepareChatWorkspaceRoot` (~L425-426) and wire it
   into wherever those are provided to the normalizer.
5. **`orchestration/dispatchCommandNormalization.ts`**
   - Add `readonly studioWorkspaceRoot?: string;` and
     `readonly prepareStudioWorkspaceRoot?: (workspaceRoot: string) => Effect.Effect<void, E>;` to the options
     interface (alongside `chatWorkspaceRoot` / `prepareChatWorkspaceRoot`, ~L128-135).
   - Add `maybePrepareStudioWorkspaceRoot` paralleling `maybePrepareChatWorkspaceRoot` (~L144-156). **Key
     difference:** studio scaffolds the root **itself**, so the guard is
     `command.kind === "studio"` and `isWorkspaceRootWithin(ws, studioRoot) || workspaceRootsEqual(ws, studioRoot)`
     (i.e. include the equal-to-root case, unlike the chat variant which excludes it).
   - Call it after `canonicalizeProjectWorkspaceRoot` in both the `project.create` and `project.meta.update`
     branches (~L167, ~L182), same as the chat call.
   - Wire the new options where the normalizer is constructed (find `makeDispatchCommandNormalizer` call site;
     pass `studioWorkspaceRoot` + `prepareStudioWorkspaceRoot`).
6. **Sanity grep:** `rg 'kind === "chat"' apps/server` and confirm none of them need to also match `"studio"`.
   The cwd resolver intentionally does **not** (studio wants a real cwd). Scratch-workspace fallback
   (`codexAppServerManager.ts`, `scratchWorkspaces.ts`) is unaffected because studio threads now resolve a real
   cwd and never hit the fallback.

### Phase 2 — Shared (`packages/shared`)

- No required change: `resolveThreadWorkspaceCwd` only special-cases `"chat"`. Confirm
  `@synara/shared/threadWorkspace` helpers (`isWorkspaceRootWithin`, `workspaceRootsEqual`) are exported for
  reuse by the new web `studioProjects.ts` (they already are; used by `chatProjects.ts`).

### Phase 3 — Web state & helpers (`apps/web/src`)

1. **`workspaceStore.ts`** — add `studioWorkspaceRoot: string | null` to state + a setter; extend
   `setServerWorkspacePaths` to accept/store it. **Bump the persist key** (`synara:workspace-pages:v2` → `v3`)
   only if you add it to the persisted partialize set; prefer treating it as server-derived (non-persisted,
   same as `chatWorkspaceRoot`) and just populate from welcome/config — **no key bump needed**.
2. **Populate it** wherever `chatWorkspaceRoot` is read from the server: `WorkspaceView.tsx` (~L87-109,
   `onServerWelcome` + `serverConfigQueryOptions`). Add `payload.studioWorkspaceRoot` / `data.studioWorkspaceRoot`.
3. **`lib/serverWorkspacePaths.ts`** — extend `ServerWorkspacePaths` with optional `studioWorkspaceRoot` and add
   `resolveServerStudioWorkspaceRoot(paths)` (returns `studioWorkspaceRoot?.trim() || null`; **no homeDir
   fallback** — Studio must be explicit).
4. **New `lib/studioProjects.ts`** — clone `chatProjects.ts` for `kind: "studio"`:
   - `ensureStudioProject(paths): Promise<ProjectId | null>` — mirrors `ensureHomeChatProject` but dispatches
     `project.create` with `kind: "studio"`, `title: "Studio"`,
     `workspaceRoot: studioWorkspaceRoot`, `createWorkspaceRootIfMissing: true`.
   - `isStudioContainerProject(project, paths): boolean` — `project.kind === "studio"` and its cwd is within /
     equal to `studioWorkspaceRoot`.
   - `findStudioContainerProject(projects, paths)`.
   - Reuse the same de-dupe / pending-creation guards as chatProjects (copy the `pending…Map` pattern).
   - **Important:** unlike chat, pass the **real** Studio root as `workspaceRoot` (not a placeholder homeDir),
     so the container's cwd is the Studio folder.
5. **Hooks** — add `hooks/useHandleNewStudioChat.ts` mirroring `useHandleNewChat.ts`:
   - read `studioWorkspaceRoot` from `workspaceStore`; `ensureStudioProject(...)`; then `handleNewThread(projectId, …)`.
   - Reuse `useHandleNewThread` unchanged (studio threads are ordinary threads).
   - Prefer **generalizing** `useHandleNewChat` to take a `{ surface: "chat" | "studio" }` arg if it stays clean;
     otherwise a thin parallel hook is acceptable. Don't duplicate `useHandleNewThread`.
6. **`store.ts` / `types.ts`** — `Project.kind` already typed via `ProjectKind`; once the contract union is
   widened it flows through. Verify `normalizeProjectFromReadModel` passes `kind` straight through (it does).

### Phase 4 — Web routes (`apps/web/src/routes`)

Studio **threads reuse the existing `/$threadId` route + `ChatView`** — do **not** duplicate the chat surface.
Only add a Studio **landing** route.

1. **New `_chat.studio.index.tsx`** — clone `_chat.index.tsx` but for studio:
   - On mount: restore the last studio thread (filter restorable threads to studio-container projects) or call
     `useHandleNewStudioChat().handleNewChat({ fresh: true })`.
   - Renders `<SplashScreen/>` while resolving, same as `_chat.index.tsx`.
   - Use a studio-scoped "last route" key if you want independent restore; otherwise reuse and filter by kind.
2. Register the route (file-based routing auto-generates `routeTree.gen.ts` on `bun dev`/build; if the repo
   commits `routeTree.gen.ts`, regenerate it — do not hand-edit unless required).

### Phase 5 — Web sidebar + segmented picker (`apps/web/src/components/Sidebar.tsx`)

This is the largest surface. The Explore map flagged every touch point; handle all of them:

1. **Widen the view union** everywhere it's `"threads" | "workspace"` → add `"studio"`:
   `SidebarSegmentedPicker` props (~L1110-1112), `handleSidebarViewChange` (~L2137), `activeView` plumbing.
   Consider extracting a `type SidebarView = "threads" | "studio" | "workspace"` alias to avoid drift.
2. **Label rendering** (~L1137) — replace the binary ternary with a lookup so unknown views can't mislabel:
   ```ts
   const LABELS: Record<SidebarView, string> = { threads: "Threads", studio: "Studio", workspace: "Workspace" };
   ```
3. **Settings gate** — add `const studioSectionVisible = appSettings.showStudioSection;` (~L1260-1261).
4. **`views` array at call site** (~L6055):
   ```ts
   views={[
     "threads",
     ...(studioSectionVisible ? (["studio"] as const) : []),
     ...(workspaceSectionVisible ? (["workspace"] as const) : []),
   ]}
   ```
5. **Active segment derivation** (~L6056). Studio threads live on `/$threadId`, so derive studio from the
   **active thread's project kind**, not just pathname:
   ```ts
   const isOnStudio = pathname.startsWith("/studio") || activeProject?.kind === "studio";
   activeView={isOnStudio ? "studio" : isOnWorkspace ? "workspace" : "threads"}
   ```
   (Get `activeProject` from the route thread → its project, already available in the sidebar.)
6. **`isOnStudio` local** (~L1235 next to `isOnWorkspace`) and a **`navigateToStudio`** callback (~L2086 next to
   `navigateToWorkspace`) → `navigate({ to: "/studio" })`.
7. **`handleSidebarViewChange`** (~L2137) — add a `"studio"` branch that calls `navigateToStudio()` (or routes to
   the last studio thread if you track one).
8. **Guard effect** (~L2175-2182) — add an analogous redirect: if on a studio surface but `!studioSectionVisible`,
   navigate back to threads.
9. **Primary action bar** (~L6062) — add a studio arm:
   `isOnStudio ? <SidebarPrimaryAction label="New studio chat" onClick={handleNewStudioChat}/> + Search : …`.
10. **Main content branch** (~L6106) — add a studio arm that renders **the same structure as the Threads view**
    (folder groups + nested chat rows) but **filtered to studio**:
    - Partition projects: `studioProjects = projects.filter(p => isStudioContainerProject(p, paths))`;
      `nonStudioProjects = the rest`. Threads view renders `nonStudioProjects` (unchanged behavior); Studio view
      renders `studioProjects`.
    - Reuse `groupSidebarThreadsByProjectId` + `renderProjectItem` + `buildProjectThreadTree`. Filter
      `sidebarDisplayThreads` to threads whose project is studio for the Studio list, and exclude those from the
      Threads list. **Do this with one shared partition helper** so Threads and Studio stay in lockstep.
    - The footer "Chats" section (gated by `chatsSectionVisible`) must **exclude studio chats** so they don't
      double-list.
11. Make sure `standardProjects` / pinned-thread logic excludes studio-container projects from the Threads view.

### Phase 6 — Web settings (`apps/web/src`)

1. **`appSettings.ts`** (~L169-175) — add:
   ```ts
   showStudioSection: Schema.Boolean.pipe(withDefaults(() => true)),
   ```
   (Default **true** — Studio is the new headline segment.)
2. **`routes/_chat.settings.tsx`** — add a "Studio" boolean row in the **Sidebar sections** group
   (~L1656-1673, next to Chats/Workspace) via `renderBooleanSettingRow({ settingKey: "showStudioSection", … })`,
   and add it to the changed-settings summary list (~L937-938).
3. Check `settingsSearchIndex.ts` for the Chats/Workspace section entries and add a Studio entry for search parity.

### Phase 7 — Empty-state reuse (`apps/web/src/components/ChatView.tsx`)

So a fresh studio draft shows the **same empty-state hero + `ProjectPicker`** as a new chat:

- `isEmptyChatLanding` (~L2590) currently gates on `isHomeChatContainerProject(activeProject, paths)`. Extend to
  **also** accept `isStudioContainerProject(activeProject, paths)`:
  ```ts
  const isContainerLanding =
    isHomeChatContainerProject(activeProject, paths) || isStudioContainerProject(activeProject, paths);
  ```
- The existing `ProjectPicker` render (~L8692) and `handleSelectWorkspaceRoot` are reused as-is. Picking an
  external folder in a studio chat behaves exactly like Chats (sets `worktreePath` → on first send may
  create/use a `kind:"project"` project). Default (no pick) keeps the chat in the Studio container rooted at
  `~/Documents/Synara/Studio`.
- Optional polish (leave for the UI-refinement pass): a Studio-specific empty-state heading/subcopy.

---

## 5. Files to touch (checklist)

**Contracts**
- [ ] `packages/contracts/src/project.ts` (ProjectKind union)
- [ ] `packages/contracts/src/server.ts` (`studioWorkspaceRoot` in ServerConfig + welcome payload)

**Server**
- [ ] `apps/server/src/config.ts` (shape + `resolveDefaultStudioWorkspaceRoot` + layerTest)
- [ ] `apps/server/src/main.ts` (set `studioWorkspaceRoot`)
- [ ] `apps/server/src/effectServer.ts` (welcome emit)
- [ ] `apps/server/src/wsRpc.ts` (`prepareStudioWorkspaceRoot`, config snapshot, welcome stream)
- [ ] `apps/server/src/orchestration/dispatchCommandNormalization.ts` (`maybePrepareStudioWorkspaceRoot` + wiring)

**Web — state/helpers**
- [ ] `apps/web/src/workspaceStore.ts`
- [ ] `apps/web/src/components/WorkspaceView.tsx` (hydrate studioWorkspaceRoot)
- [ ] `apps/web/src/lib/serverWorkspacePaths.ts`
- [ ] `apps/web/src/lib/studioProjects.ts` (new)
- [ ] `apps/web/src/hooks/useHandleNewStudioChat.ts` (new, or generalize `useHandleNewChat.ts`)

**Web — routes**
- [ ] `apps/web/src/routes/_chat.studio.index.tsx` (new)
- [ ] `apps/web/src/routeTree.gen.ts` (regenerated)

**Web — sidebar / settings / empty-state**
- [ ] `apps/web/src/components/Sidebar.tsx`
- [ ] `apps/web/src/appSettings.ts`
- [ ] `apps/web/src/routes/_chat.settings.tsx`
- [ ] `apps/web/src/settingsSearchIndex.ts`
- [ ] `apps/web/src/components/ChatView.tsx` (empty-state container check)

**Tests to add/update** (see §6).

---

## 6. Testing & verification

- **Unit/logic tests (Vitest):** run with **`bun run test`** — **NEVER `bun test`**.
  - Add tests for `lib/studioProjects.ts` (`isStudioContainerProject`, `ensureStudioProject` dispatch shape) —
    mirror existing `chatProjects` tests if present.
  - Add a server test for `resolveDefaultStudioWorkspaceRoot` (posix + win32) next to any `config` test.
  - Extend the sidebar partition test (Threads vs Studio) if `Sidebar.logic.test.ts` covers grouping.
- **Final gate (run once, bundled):** `bun fmt && bun lint && bun typecheck`. All three must pass.
- **Manual smoke (for the UI-refinement pass / verify skill):**
  1. Sidebar shows `Threads | Studio`. Toggle `showStudioSection` off → Studio segment disappears + redirects.
  2. Click Studio → empty-state with `ProjectPicker` (same as Chats).
  3. Start a studio chat, ask it to write a file → it appears under `~/Documents/Synara/Studio/Outbox/Content/…`.
  4. Studio chats appear only in the Studio segment, never in Threads or the footer Chats list.
  5. Existing Chats/Threads and Workspace behavior unchanged.

---

## 7. Edge cases & gotchas

- **Exhaustive `kind` switches:** widening `ProjectKind` may surface TS exhaustiveness errors — handle each.
  Treat `"studio"` like `"chat"` for "is a hidden container / not a normal project folder" decisions, like
  `"project"` for cwd. Grep both `=== "chat"` and `=== "project"`.
- **Double-listing:** ensure studio threads are removed from (a) the Threads project list, (b) pinned threads in
  Threads, and (c) the footer "Chats" list. One shared partition helper prevents drift.
- **Active segment while viewing a studio thread:** must derive from `activeProject?.kind === "studio"` (threads
  live on `/$threadId`), else the picker snaps back to "Threads".
- **cwd correctness:** verify a studio thread's resolved cwd is `~/Documents/Synara/Studio` (not scratch/tmp).
  This is the whole point — confirm via the manual smoke test #3.
- **Scaffold idempotency:** `prepareStudioWorkspaceRoot` must be safe to call repeatedly (recursive mkdir,
  swallow "already exists").
- **Windows:** use the platform-aware `path` join in `resolveDefaultStudioWorkspaceRoot` (mirror the chat resolver).
- **Persist keys:** only bump `workspaceStore` persist version if you persist `studioWorkspaceRoot`. Prefer
  server-derived/non-persisted (no bump).
- **Don't touch** the Workspace terminal feature beyond adding the third segment slot.

---

## 8. Out of scope (left for the human/Claude UI-refinement pass)

- Studio-specific empty-state copy/iconography, segment iconography, and any visual polish.
- Any "Outbox" content browser / file viewer UI (not required; outputs are plain files on disk).
- Skills/Context seeding inside the Studio folder (we only create empty dirs).
- Renaming/curating the mirrored subfolders beyond the Claude parity set.

---

## 9. Acceptance criteria

1. Sidebar segmented picker renders `Threads | Studio` (and `| Workspace` only when that setting is on), with
   correct labels and active-state.
2. `showStudioSection` (default on) toggles the Studio segment; turning it off while on a studio surface
   redirects to Threads.
3. A new studio chat is a real AI thread whose cwd is `~/Documents/Synara/Studio`; agent-written files land
   under `Studio/Outbox/Content/…`. The Studio folder tree mirrors `~/Documents/Claude` (structure only).
4. Studio chats are listed only under the Studio segment (folder selector + grouped chats, same UI as Threads),
   never duplicated in Threads or footer Chats.
5. Existing Chats/Threads and Workspace features are unchanged.
6. `bun fmt`, `bun lint`, `bun typecheck` pass; new logic has Vitest coverage run via `bun run test`.
</content>
</invoke>
