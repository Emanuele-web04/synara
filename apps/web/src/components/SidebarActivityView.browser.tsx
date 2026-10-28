// FILE: SidebarActivityView.browser.tsx
// Purpose: Browser regressions for Activity paging, stateful actions, scope fallback, and live PR data.
// Layer: Sidebar Activity UI test

import "../index.css";

import { ProjectId, ThreadId, type OrchestrationThreadPullRequest } from "@synara/contracts";
import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { Project, SidebarThreadSummary } from "../types";
import { DEFAULT_PROJECT_ICON, type ProjectAppearance } from "../lib/projectAppearance";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import { SidebarActivityView } from "./SidebarActivityView";
import type { ActivityGroupMode, ActivityScopeSelection } from "./SidebarActivityView.logic";
import type { WorkspaceNavigation, WorkspaceSidebarActions } from "../lib/hosts/workspaceFrame";
import type { WorkspaceSession } from "../lib/hosts/workspaceSessions";
import { workspaceActivityRows, type WorkspaceThreadEntry } from "../lib/hosts/workspaceSidebar";
import { WorkspaceThreadRow } from "./hosts/WorkspaceProjects";
import { SidebarProvider } from "./ui/sidebar";
import { toastManager } from "./ui/toast";

const remoteFixture = vi.hoisted(() => ({
  available: new Map<WorkspaceSession, WorkspaceNavigation>(),
  sessions: [] as WorkspaceSession[],
  open: vi.fn(),
  href: "/",
}));
vi.mock("../lib/hosts/workspaceSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hosts/workspaceSessions")>()),
  readAvailableWorkspaceNavigation: (session: WorkspaceSession) =>
    remoteFixture.available.get(session),
  readWorkspaceSessions: () => remoteFixture.sessions,
}));
vi.mock("../lib/hosts/workspaceCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hosts/workspaceCommands")>()),
  openWorkspacePath: remoteFixture.open,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: ({ select }: { select: (location: { href: string }) => unknown }) =>
    select({ href: remoteFixture.href }),
}));

const projectFavicon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="red"/></svg>',
)}`;

vi.mock("~/lib/wsHttpUrl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/wsHttpUrl")>()),
  resolveExecutionResource: () => projectFavicon,
}));

const PROJECT_A = ProjectId.makeUnsafe("activity-project-a");
const PROJECT_B = ProjectId.makeUnsafe("activity-project-b");

function makeProject(id: ProjectId, name: string): Project {
  return {
    id,
    kind: "project",
    name,
    remoteName: name,
    folderName: name,
    localName: null,
    cwd: `/tmp/${id}`,
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
  };
}

function makeThread(
  index: number,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  const completedAt = `2026-08-02T10:${String(index % 60).padStart(2, "0")}:00.000Z`;
  return {
    id: ThreadId.makeUnsafe(`activity-thread-${index}`),
    projectId: PROJECT_A,
    title: `Activity thread ${index}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-08-02T09:00:00.000Z",
    updatedAt: completedAt,
    latestTurn: {
      turnId: `activity-turn-${index}`,
      state: "completed",
      requestedAt: completedAt,
      startedAt: completedAt,
      completedAt,
      assistantMessageId: null,
    } as SidebarThreadSummary["latestTurn"],
    lastVisitedAt: "2026-08-02T12:00:00.000Z",
    latestUserMessageAt: null,
    latestHumanMessageAt: completedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  };
}

function renderActivity(input: {
  threads: readonly SidebarThreadSummary[];
  projects?: readonly Project[];
  activeThreadId?: ThreadId | null;
  visualActiveThreadId?: ThreadId | null;
  pinnedThreadIdSet?: ReadonlySet<ThreadId>;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  prByThreadId?: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  externalRows?: ReadonlyMap<
    ThreadId,
    {
      hostName: string;
      onOpen: () => void;
      status: ThreadStatusPill | null;
      entry?: WorkspaceThreadEntry;
    }
  >;
  onVisibleThreadIdsChange?: (threadIds: readonly ThreadId[]) => void;
  renderThreadHoverCard?: (thread: SidebarThreadSummary, anchorId: string) => ReactNode;
  onOpenThread?: (threadId: ThreadId) => void;
  onSetThreadSettled?: (threadId: ThreadId, settled: boolean) => void;
  onToggleThreadPinned?: (threadId: ThreadId) => void;
  onArchiveThread?: (threadId: ThreadId) => void;
  onReturnSnoozedThread?: (threadId: ThreadId) => void;
  onMarkThreadRead?: (threadId: ThreadId, completedAt?: string) => void;
  onRenameThread?: (threadId: ThreadId) => void;
  onThreadRenamePointerUp?: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onThreadContextMenu?: (threadId: ThreadId, position: { x: number; y: number }) => void;
  onProjectContextMenu?: (projectId: ProjectId, position: { x: number; y: number }) => void;
  resolveThreadStatus?: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  threadsHydrated?: boolean;
  /** Controlled scope (the sidebar's role); omitted, the harness keeps it in local state. */
  scope?: {
    selection: ActivityScopeSelection;
    onChange: (selection: ActivityScopeSelection) => void;
  };
}) {
  return <ActivityHarness {...input} />;
}

function ActivityHarness(input: Parameters<typeof renderActivity>[0]) {
  const projects = input.projects ?? [makeProject(PROJECT_A, "Project A")];
  const [localScope, setLocalScope] = useState<ActivityScopeSelection>(null);
  const [groupMode, setGroupMode] = useState<ActivityGroupMode>("time");
  return (
    <SidebarActivityView
      threads={input.threads}
      projectById={new Map(projects.map((project) => [project.id, project]))}
      externalRows={input.externalRows}
      activeThreadId={input.activeThreadId ?? null}
      {...(input.visualActiveThreadId === undefined
        ? {}
        : { visualActiveThreadId: input.visualActiveThreadId })}
      pinnedThreadIdSet={input.pinnedThreadIdSet ?? new Set()}
      settledOverrideByThreadId={input.settledOverrideByThreadId ?? new Map()}
      threadsHydrated={input.threadsHydrated ?? true}
      scopeSelection={input.scope ? input.scope.selection : localScope}
      onScopeSelectionChange={input.scope ? input.scope.onChange : setLocalScope}
      groupMode={groupMode}
      onChangeGroupMode={setGroupMode}
      prByThreadId={input.prByThreadId ?? new Map()}
      threadJumpLabelByThreadId={new Map()}
      onVisibleThreadIdsChange={input.onVisibleThreadIdsChange ?? (() => {})}
      resolveThreadStatus={input.resolveThreadStatus ?? (() => null)}
      onOpenThread={input.onOpenThread ?? (() => {})}
      onOpenThreadPullRequest={() => {}}
      onSetThreadSettled={input.onSetThreadSettled ?? (() => {})}
      onReturnSnoozedThread={input.onReturnSnoozedThread ?? (() => {})}
      onToggleThreadPinned={input.onToggleThreadPinned ?? (() => {})}
      onArchiveThread={input.onArchiveThread ?? (() => {})}
      onMarkThreadRead={input.onMarkThreadRead ?? (() => {})}
      onRenameThread={input.onRenameThread ?? (() => {})}
      onThreadRenamePointerUp={input.onThreadRenamePointerUp ?? (() => {})}
      onThreadContextMenu={input.onThreadContextMenu ?? (() => {})}
      onProjectContextMenu={input.onProjectContextMenu ?? (() => {})}
      renderThreadHoverCard={input.renderThreadHoverCard ?? (() => null)}
      onCreateChat={() => {}}
      onAddProject={() => {}}
    />
  );
}

/** The status pill the sidebar really resolves, so Priority tiers follow live thread state. */
function realThreadStatus(thread: SidebarThreadSummary): ThreadStatusPill | null {
  return resolveThreadStatusPill({
    thread,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
  });
}

/** Section labels ("# Label") and row ids in document order. */
function activityLayout(): string[] {
  return [
    ...document.querySelectorAll(
      '[data-slot="activity-section-label"], [data-testid^="activity-thread-"]',
    ),
  ].map((element) =>
    element.getAttribute("data-slot") === "activity-section-label"
      ? `# ${element.textContent}`
      : element.getAttribute("data-testid")!.replace("activity-thread-", ""),
  );
}

function makeRemoteEntry(
  environmentId: string,
  overrides: Partial<WorkspaceThreadEntry["thread"]> = {},
  children: readonly WorkspaceThreadEntry["thread"][] = [],
) {
  const actions = {
    renameThread: vi.fn(async () => {}),
    setThreadPinned: vi.fn(async () => {}),
    archiveThread: vi.fn(async () => {}),
    setThreadSettled: vi.fn(async (_threadId: ThreadId, _settled: boolean) => true),
    returnSnoozedThread: vi.fn(async () => {}),
    renameProject: vi.fn(),
    setProjectPinned: vi.fn(async () => {}),
  } satisfies WorkspaceSidebarActions;
  const thread: WorkspaceThreadEntry["thread"] = {
    ...makeThread(71, {
      id: ThreadId.makeUnsafe("same-remote-thread"),
      lastVisitedAt: "2026-08-02T09:00:00.000Z",
    }),
    status: {
      label: "Completed",
      colorClass: "text-emerald-600",
      dotClass: "bg-emerald-500",
      pulse: false,
    },
    ...overrides,
  };
  const navigation: WorkspaceNavigation = {
    sidebar: actions,
    navigate: vi.fn(),
    newChat: vi.fn<WorkspaceNavigation["newChat"]>(),
    createChat: vi.fn<WorkspaceNavigation["createChat"]>(),
    openTerminal: vi.fn(),
    browseFolders: vi.fn<WorkspaceNavigation["browseFolders"]>(),
    createProject: vi.fn<WorkspaceNavigation["createProject"]>(),
    openProject: vi.fn<WorkspaceNavigation["openProject"]>(),
    recover: vi.fn(),
  };
  const session: WorkspaceSession = {
    host: {
      hostId: environmentId,
      hostName: `Computer ${environmentId}`,
      wsPath: `/ws/remote/${environmentId}`,
      executionScope: {
        environmentId,
        accountAuthority: "https://account.example.test",
        userId: "fixture-owner",
        organizationId: "fixture-org",
        channel: "beta",
      },
    },
    navigation,
    summary: {
      state: "open",
      path: "/previous-chat",
      projects: [{ ...makeProject(PROJECT_A, "Project A"), section: "projects" }],
      threads: [thread, ...children],
    },
  };
  remoteFixture.available.set(session, navigation);
  remoteFixture.sessions.push(session);
  return {
    entry: { key: environmentId, thread, session } satisfies WorkspaceThreadEntry,
    session,
    actions,
  };
}

function remoteActivityInput(sessions: readonly WorkspaceSession[]) {
  const activity = workspaceActivityRows(sessions);
  const onOpen = vi.fn();
  return {
    threads: activity.threads,
    projects: [...activity.projectById.values()],
    externalRows: new Map(
      [...activity.remoteById].map(([id, entry]) => [
        id,
        {
          entry,
          hostName: entry.session!.host.hostName,
          status: entry.thread.status,
          onOpen,
        },
      ]),
    ),
    onOpen,
  };
}

function actionButton(row: HTMLElement, label: string): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  return button!;
}

describe("SidebarActivityView", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-02T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    remoteFixture.available.clear();
    remoteFixture.sessions = [];
    remoteFixture.open.mockClear();
    remoteFixture.href = "/";
    document.body.innerHTML = "";
  });

  it("keeps remote pinned rows in the feed without sending them to local actions", async () => {
    const local = makeThread(70, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const remote = makeThread(71, {
      id: ThreadId.makeUnsafe('workspace:["remote-env","thread-71"]'),
      projectId: PROJECT_B,
      lastVisitedAt: "2026-08-02T09:00:00.000Z",
    });
    const onRemoteOpen = vi.fn();
    const onOpenThread = vi.fn();
    const onMarkThreadRead = vi.fn();
    const onRenameThread = vi.fn();
    const onThreadContextMenu = vi.fn();
    const onVisibleThreadIdsChange = vi.fn();
    const renderThreadHoverCard = vi.fn(() => null);
    const mounted = await render(
      renderActivity({
        threads: [local, remote],
        renderThreadHoverCard,
        projects: [makeProject(PROJECT_A, "Project A"), makeProject(PROJECT_B, "Project B")],
        pinnedThreadIdSet: new Set([remote.id]),
        externalRows: new Map([
          [remote.id, { hostName: "Studio Mac", onOpen: onRemoteOpen, status: null }],
        ]),
        onOpenThread,
        onMarkThreadRead,
        onRenameThread,
        onThreadContextMenu,
        onVisibleThreadIdsChange,
      }),
    );

    expect(page.getByRole("button", { name: "Pinned" })).toBeVisible();
    const remoteRow = page.getByTestId(`activity-thread-${remote.id}`);
    expect(remoteRow).toHaveAttribute("draggable", "false");
    // The computer is named by the hover card and the accessible label, not the meta line.
    expect(remoteRow).toHaveAttribute("aria-label", expect.stringContaining("Studio Mac"));
    expect(remoteRow.element().textContent).not.toContain("Studio Mac");
    // Remote rows open the same hover card as local ones.
    expect(remoteRow.element().closest("[data-thread-hover-anchor]")).not.toBeNull();
    expect(renderThreadHoverCard).toHaveBeenCalledWith(
      expect.objectContaining({ id: remote.id }),
      expect.any(String),
    );
    expect(remoteRow.element().parentElement?.querySelectorAll("button")).toHaveLength(1);
    await remoteRow.click();
    expect(onRemoteOpen).toHaveBeenCalledOnce();
    expect(onOpenThread).not.toHaveBeenCalled();
    remoteRow.element().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    remoteRow.element().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(onRenameThread).not.toHaveBeenCalled();
    expect(onThreadContextMenu).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Activity options" }).click();
    await page.getByRole("menuitem", { name: "Mark all as read" }).click();
    expect(onMarkThreadRead).toHaveBeenCalledOnce();
    expect(onMarkThreadRead).toHaveBeenCalledWith(local.id, local.latestTurn?.completedAt);
    await vi.waitFor(() =>
      expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith([remote.id, local.id]),
    );
    await mounted.unmount();
  });

  it("routes remote Priority actions to their own host even when raw thread IDs collide", async () => {
    const first = makeRemoteEntry("mini");
    const second = makeRemoteEntry("book");
    const input = remoteActivityInput([first.session, second.session]);
    const local = {
      onSetThreadSettled: vi.fn(),
      onMarkThreadRead: vi.fn(),
      onToggleThreadPinned: vi.fn(),
      onArchiveThread: vi.fn(),
      onRenameThread: vi.fn(),
    };
    const mounted = await render(renderActivity({ ...input, ...local }));
    await expect.element(page.getByText("Priority", { exact: true })).toBeVisible();

    for (const [index, owner] of [first, second].entries()) {
      const row = page.getByTestId(`activity-thread-${input.threads[index]!.id}`).element();
      row.focus();
      const wrapper = row.parentElement!;
      actionButton(wrapper, "Pin thread").click();
      actionButton(wrapper, "Archive thread").click();
      actionButton(wrapper, "Done").click();
      await vi.waitFor(() => {
        expect(owner.actions.setThreadPinned).toHaveBeenCalledExactlyOnceWith(
          owner.entry.thread.id,
          true,
        );
        expect(owner.actions.archiveThread).toHaveBeenCalledExactlyOnceWith(owner.entry.thread.id);
        expect(owner.actions.setThreadSettled).toHaveBeenCalledExactlyOnceWith(
          owner.entry.thread.id,
          true,
        );
      });
      expect(remoteFixture.open).toHaveBeenCalledWith(owner.session, "/previous-chat");
      for (const label of ["Pin thread", "Archive thread", "Done"]) {
        actionButton(wrapper, label).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        actionButton(wrapper, label).dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }),
        );
      }
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
    expect(input.onOpen).not.toHaveBeenCalled();
    for (const callback of Object.values(local)) expect(callback).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it.each(["activity", "classic", "pinned"] as const)(
    "matches remote glyph/action sizes and hides the resting marker on hover and focus (%s)",
    async (surface) => {
      await page.viewport(1000, 700);
      const owner = makeRemoteEntry("mini");
      const input = remoteActivityInput([owner.session]);
      const mounted = await render(
        <div className="w-80">
          {surface === "activity" ? (
            renderActivity(input)
          ) : (
            <SidebarProvider>
              <div className="w-80">
                <WorkspaceThreadRow entry={owner.entry} topLevel={surface === "pinned"} />
              </div>
            </SidebarProvider>
          )}
        </div>,
      );
      const main = page.getByRole("button", {
        name: new RegExp(`Activity thread 71, Computer mini`),
      });
      const button = main.element();
      const wrapper = button.parentElement!;
      const marker = wrapper.querySelector<HTMLElement>('[data-slot="remote-thread-marker"]');
      if (surface !== "classic") {
        expect(marker).not.toBeNull();
        const glyph = marker!.querySelector("svg, [data-slot=central-icon]")!;
        expect(glyph.getBoundingClientRect().width).toBe(15);
        expect(glyph.getBoundingClientRect().height).toBe(15);
      }
      await main.hover();
      if (marker) await vi.waitFor(() => expect(getComputedStyle(marker).opacity).toBe("0"));
      const quickButtons = ["Pin thread", "Archive thread", "Done"].map((label) =>
        actionButton(wrapper, label),
      );
      for (const action of quickButtons) {
        const glyph = action.querySelector("svg, [data-slot=central-icon]")!;
        expect(glyph.getBoundingClientRect().width).toBe(15);
        expect(glyph.getBoundingClientRect().height).toBe(15);
        expect(action.getBoundingClientRect().width).toBe(20);
      }
      const title =
        wrapper.querySelector('[data-testid^="thread-title-"]') ??
        button.querySelector("span.min-w-0.flex-1");
      await vi.waitFor(() =>
        expect(title!.getBoundingClientRect().right).toBeLessThanOrEqual(
          quickButtons[0]!.getBoundingClientRect().left,
        ),
      );
      await userEvent.hover(document.body);
      button.focus();
      if (marker) await vi.waitFor(() => expect(getComputedStyle(marker).opacity).toBe("0"));
      expect(quickButtons.every((action) => getComputedStyle(action).visibility !== "hidden")).toBe(
        true,
      );
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
      );
      await expect.element(page.getByRole("menuitem", { name: "Rename chat" })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await mounted.unmount();
    },
  );

  it("disables offline remote actions and rejects an action from a stale captured session", async () => {
    const owner = makeRemoteEntry("offline");
    remoteFixture.available.delete(owner.session);
    const input = remoteActivityInput([owner.session]);
    const mounted = await render(renderActivity(input));
    const row = page.getByTestId(`activity-thread-${input.threads[0]!.id}`).element();
    row.focus();
    for (const label of ["Pin thread", "Archive thread", "Done"]) {
      const action = actionButton(row.parentElement!, label);
      expect(action.disabled).toBe(true);
      action.click();
    }
    for (const action of Object.values(owner.actions)) expect(action).not.toHaveBeenCalled();
    expect(input.onOpen).not.toHaveBeenCalled();
    expect(remoteFixture.open).not.toHaveBeenCalled();
    await mounted.unmount();

    remoteFixture.available.set(owner.session, owner.session.navigation!);
    const fresh = await render(renderActivity(input));
    const liveRow = page.getByTestId(`activity-thread-${input.threads[0]!.id}`).element();
    liveRow.focus();
    remoteFixture.available.delete(owner.session);
    for (const label of ["Pin thread", "Archive thread", "Done"])
      actionButton(liveRow.parentElement!, label).click();
    for (const action of Object.values(owner.actions)) expect(action).not.toHaveBeenCalled();
    expect(remoteFixture.open).not.toHaveBeenCalled();
    await fresh.unmount();
  });

  it("keeps a remote optimistic Done state undoable before its projection arrives", async () => {
    const owner = makeRemoteEntry("mini", { settledOverride: true });
    const input = remoteActivityInput([owner.session]);
    const mounted = await render(
      renderActivity({
        ...input,
        settledOverrideByThreadId: new Map([[input.threads[0]!.id, true]]),
        pinnedThreadIdSet: new Set([input.threads[0]!.id]),
      }),
    );
    const row = page.getByTestId(`activity-thread-${input.threads[0]!.id}`).element();
    row.focus();
    actionButton(row.parentElement!, "Undo").click();
    await vi.waitFor(() =>
      expect(owner.actions.setThreadSettled).toHaveBeenCalledExactlyOnceWith(
        owner.entry.thread.id,
        false,
      ),
    );
    await mounted.unmount();
  });

  it.each(["active", "another-host", "child-active"] as const)(
    "keeps controller Done undo after its remote row unmounts (route: %s)",
    async (route) => {
      const childId = ThreadId.makeUnsafe("remote-child");
      const owner = makeRemoteEntry("mini", {}, [
        {
          ...makeThread(72, {
            id: childId,
            parentThreadId: ThreadId.makeUnsafe("same-remote-thread"),
          }),
          status: null,
        },
      ]);
      const other = makeRemoteEntry("book");
      const environment = route === "another-host" ? "book" : "mini";
      const path = route === "child-active" ? `/${childId}` : `/${owner.entry.thread.id}`;
      remoteFixture.href = `/remote?${new URLSearchParams({ environment, path })}`;
      const input = remoteActivityInput([owner.session, other.session]);
      const addToast = vi.spyOn(toastManager, "add");
      const mounted = await render(renderActivity(input));
      const row = page.getByTestId(`activity-thread-${input.threads[0]!.id}`).element();
      row.focus();
      actionButton(row.parentElement!, "Done").click();
      await vi.waitFor(() =>
        expect(addToast).toHaveBeenCalledWith(
          expect.objectContaining({
            timeout: 0,
            data: expect.objectContaining({
              allowCrossThreadVisibility: true,
              dismissAfterVisibleMs: 8_000,
              archiveUndo: expect.objectContaining({ message: "Marked as done" }),
            }),
          }),
        ),
      );
      const undo = addToast.mock.calls[0]![0].data!.archiveUndo!.onUndo;
      await mounted.unmount();
      await expect(Promise.resolve(undo())).resolves.toBe(true);
      expect(owner.actions.setThreadSettled).toHaveBeenNthCalledWith(
        1,
        owner.entry.thread.id,
        true,
      );
      expect(owner.actions.setThreadSettled).toHaveBeenNthCalledWith(
        2,
        owner.entry.thread.id,
        false,
      );
      expect(other.actions.setThreadSettled).not.toHaveBeenCalled();
      if (route === "active")
        expect(remoteFixture.open).toHaveBeenCalledExactlyOnceWith(
          owner.session,
          `/${owner.entry.thread.id}`,
        );
      else expect(remoteFixture.open).not.toHaveBeenCalled();
    },
  );

  it.each(["offline", "frame-replaced"] as const)(
    "keeps Done undo unsuccessful without targeting another owner (%s)",
    async (state) => {
      const owner = makeRemoteEntry("mini");
      const other = makeRemoteEntry("book");
      const input = remoteActivityInput([owner.session]);
      const addToast = vi.spyOn(toastManager, "add");
      const mounted = await render(renderActivity(input));
      const row = page.getByTestId(`activity-thread-${input.threads[0]!.id}`).element();
      row.focus();
      actionButton(row.parentElement!, "Done").click();
      await vi.waitFor(() => expect(addToast).toHaveBeenCalled());
      const undo = addToast.mock.calls[0]![0].data!.archiveUndo!.onUndo;
      await mounted.unmount();
      remoteFixture.available.delete(owner.session);
      const replacement = state === "frame-replaced" ? makeRemoteEntry("mini") : null;
      await expect(Promise.resolve(undo())).resolves.toBe(false);
      expect(owner.actions.setThreadSettled).toHaveBeenCalledExactlyOnceWith(
        owner.entry.thread.id,
        true,
      );
      expect(other.actions.setThreadSettled).not.toHaveBeenCalled();
      if (replacement) expect(replacement.actions.setThreadSettled).not.toHaveBeenCalled();
      expect(remoteFixture.open).not.toHaveBeenCalled();
    },
  );

  it.each(["unconfirmed", "stale-frame"] as const)(
    "does not offer Undo for a stale or unconfirmed remote Done (%s)",
    async (state) => {
      const owner = makeRemoteEntry("mini");
      let confirm!: (confirmed: boolean) => void;
      owner.actions.setThreadSettled.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            confirm = resolve;
          }),
      );
      const input = remoteActivityInput([owner.session]);
      const addToast = vi.spyOn(toastManager, "add");
      const mounted = await render(renderActivity(input));
      const row = page.getByTestId(`activity-thread-${input.threads[0]!.id}`).element();
      row.focus();
      actionButton(row.parentElement!, "Done").click();
      expect(addToast).not.toHaveBeenCalled();
      if (state === "stale-frame") remoteFixture.available.delete(owner.session);
      confirm(state === "stale-frame");
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      expect(addToast).not.toHaveBeenCalled();
      await mounted.unmount();
    },
  );

  it("returns a remote snoozed chat through its owner without marking a local chat Done", async () => {
    const owner = makeRemoteEntry("mini", { snoozedUntil: "2026-08-02T13:00:00.000Z" });
    const input = remoteActivityInput([owner.session]);
    const onReturnSnoozedThread = vi.fn();
    const onSetThreadSettled = vi.fn();
    const onMarkThreadRead = vi.fn();
    const mounted = await render(
      renderActivity({ ...input, onReturnSnoozedThread, onSetThreadSettled, onMarkThreadRead }),
    );
    await page.getByRole("button", { name: "Snoozed", exact: true }).click();
    const row = page.getByTestId(`activity-thread-${input.threads[0]!.id}`).element();
    row.focus();
    actionButton(row.parentElement!, "Return now").click();
    await vi.waitFor(() =>
      expect(owner.actions.returnSnoozedThread).toHaveBeenCalledExactlyOnceWith(
        owner.entry.thread.id,
      ),
    );
    expect(owner.actions.setThreadSettled).not.toHaveBeenCalled();
    expect(onReturnSnoozedThread).not.toHaveBeenCalled();
    expect(onSetThreadSettled).not.toHaveBeenCalled();
    expect(onMarkThreadRead).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it.each([false, true])(
    "selects a hidden child's root without marking that root read (child open: %s)",
    async (childOpen) => {
      const root = makeThread(301, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
      const mounted = await render(
        renderActivity({
          threads: [root],
          activeThreadId: childOpen ? ThreadId.makeUnsafe("open-subagent") : root.id,
          visualActiveThreadId: root.id,
          resolveThreadStatus: () => ({
            label: "Completed",
            colorClass: "text-emerald-600",
            dotClass: "bg-emerald-500",
            pulse: false,
          }),
        }),
      );
      const row = mounted.getByTestId(`activity-thread-${root.id}`).element();
      expect(row.getAttribute("aria-current")).toBe("page");
      const unreadDot = row.parentElement?.querySelector('[aria-label="Unread completion"]');
      if (childOpen) expect(unreadDot).not.toBeNull();
      else expect(unreadDot).toBeNull();
      await mounted.unmount();
    },
  );

  it("keeps a snoozed pin out of normal rows and returns it through its own section", async () => {
    const thread = makeThread(40, { snoozedUntil: "2026-08-02T13:00:00.000Z" });
    const onReturnSnoozedThread = vi.fn();
    const onVisibleThreadIdsChange = vi.fn();
    const onOpenThread = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [thread],
        pinnedThreadIdSet: new Set([thread.id]),
        onReturnSnoozedThread,
        onVisibleThreadIdsChange,
        onOpenThread,
      }),
    );
    await expect
      .element(mounted.getByRole("button", { name: "Snoozed", exact: true }))
      .toBeVisible();
    await expect
      .element(mounted.getByRole("button", { name: "Pinned", exact: true }))
      .not.toBeInTheDocument();
    await expect.poll(() => onVisibleThreadIdsChange.mock.calls.at(-1)?.[0]).toEqual([]);
    await mounted.getByRole("button", { name: "Snoozed", exact: true }).click();
    await expect.element(mounted.getByTestId(`activity-thread-${thread.id}`)).toBeVisible();
    await expect.element(mounted.getByText(/^Returns /)).toBeVisible();
    await expect.poll(() => onVisibleThreadIdsChange.mock.calls.at(-1)?.[0]).toEqual([thread.id]);
    // Scoping must not repeatedly report the same rows as its filter Set changes.
    await page.getByRole("button", { name: "Filter activity by project" }).click();
    await page.getByRole("menuitemradio", { name: /Project A/u }).click();
    await expect.element(mounted.getByTestId(`activity-thread-${thread.id}`)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await mounted.getByRole("button", { name: "Return now", exact: true }).click();
    expect(onReturnSnoozedThread).toHaveBeenCalledWith(thread.id);
    expect(onOpenThread).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it.each([
    { name: "favicon", appearance: null },
    { name: "emoji", appearance: { kind: "emoji", emoji: "🚀" } },
    { name: "icon", appearance: { kind: "icon", icon: "rocket", color: "blue" } },
    { name: "color", appearance: { kind: "icon", icon: DEFAULT_PROJECT_ICON, color: "red" } },
  ] satisfies ReadonlyArray<{ name: string; appearance: ProjectAppearance | null }>)(
    "keeps the $name project identity and worktree indicator in recent rows",
    async ({ name, appearance }) => {
      const thread = makeThread(0, {
        envMode: "worktree",
        worktreePath: "/tmp/activity-worktree",
        branch: "feature/sidebar-icons",
      });
      const mounted = await render(
        renderActivity({
          threads: [thread],
          projects: [{ ...makeProject(PROJECT_A, "Project A"), appearance }],
        }),
      );
      await vi.waitFor(() => {
        const row = page.getByTestId(`activity-thread-${thread.id}`).element();
        if (name === "favicon") {
          const image = row.querySelector<HTMLImageElement>("img");
          expect(image?.naturalWidth).toBeGreaterThan(0);
        } else if (appearance?.kind === "emoji") {
          expect(row.textContent).toContain(appearance.emoji);
          expect(row.querySelector("img")).toBeNull();
        } else if (appearance?.kind === "icon") {
          // The default project icon is the shared Hugeicons folder (an svg); every other
          // choice is a masked Central asset named after the icon.
          const glyph =
            appearance.icon === DEFAULT_PROJECT_ICON
              ? row.querySelector<SVGElement>('[data-slot="hugeicon"]')
              : [...row.querySelectorAll<HTMLElement>('[data-slot="central-icon"]')].find(
                  (element) => element.style.maskImage.includes(`/${appearance.icon}.svg`),
                );
          expect(glyph).toBeDefined();
          const reference = document.createElement("span");
          reference.style.color = `var(--project-${appearance.color})`;
          document.body.appendChild(reference);
          const expectedColor = getComputedStyle(reference).color;
          reference.remove();
          expect(getComputedStyle(glyph!).color).toBe(expectedColor);
          expect(row.querySelector("img")).toBeNull();
        }
        expect(row.querySelector('[aria-label="Worktree"]')?.getAttribute("aria-hidden")).not.toBe(
          "true",
        );
      });
      await expect.element(mounted.getByRole("img", { name: "Worktree" })).toBeVisible();
      await mounted.unmount();
    },
  );

  it("keeps mounted rows and navigation order stable until a human sends a new message", async () => {
    const older = makeThread(500, {
      latestHumanMessageAt: "2026-08-02T09:30:00.000Z",
      projectId: PROJECT_B,
    });
    const newer = makeThread(501, {
      latestHumanMessageAt: "2026-08-02T09:45:00.000Z",
      hasLiveTailWork: true,
    });
    const onVisibleThreadIdsChange = vi.fn();
    const input = {
      projects: [makeProject(PROJECT_A, "Project A"), makeProject(PROJECT_B, "Project B")],
      onVisibleThreadIdsChange,
    };
    const mounted = await render(renderActivity({ ...input, threads: [older, newer] }));
    const mountedIds = () =>
      [...document.querySelectorAll('[data-testid^="activity-thread-"]')].map((row) =>
        row.getAttribute("data-testid"),
      );
    const expected = [newer.id, older.id];
    const expectOrder = async (ids: ThreadId[]) => {
      await vi.waitFor(() => {
        expect(mountedIds()).toEqual(ids.map((id) => `activity-thread-${id}`));
        expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith(ids);
      });
    };
    await expectOrder(expected);
    for (const update of [
      {
        latestTurn: { ...older.latestTurn!, completedAt: "2026-08-02T11:00:00.000Z" },
        lastVisitedAt: "2026-08-02T09:00:00.000Z",
      },
      { lastVisitedAt: "2026-08-02T11:01:00.000Z" },
      {
        hasPendingUserInput: true,
        session: {
          provider: "codex" as const,
          status: "running" as const,
          orchestrationStatus: "running" as const,
          createdAt: older.createdAt,
          updatedAt: "2026-08-02T11:02:00.000Z",
        },
      },
      { latestUserMessageAt: "2026-08-02T11:03:00.000Z", updatedAt: "2026-08-02T11:03:00.000Z" },
    ]) {
      await mounted.rerender(
        renderActivity({ ...input, threads: [{ ...older, ...update }, newer] }),
      );
      await expectOrder(expected);
    }
    await page.getByRole("button", { name: "Activity options" }).click();
    await page.getByRole("menuitemradio", { name: "Project", exact: true }).click();
    await expectOrder(expected);
    await mounted.rerender(
      renderActivity({
        ...input,
        threads: [{ ...older, latestHumanMessageAt: "2026-08-02T11:04:00.000Z" }, newer],
      }),
    );
    await expectOrder([older.id, newer.id]);
    await mounted.unmount();
  });

  it("pages project groups, reports only mounted rows, and prefers live PR state", async () => {
    const threads = Array.from({ length: 45 }, (_, index) => makeThread(index));
    threads[44] = makeThread(44, {
      lastKnownPr: {
        number: 42,
        title: "Persisted open PR",
        url: "https://github.com/acme/synara/pull/42",
        baseBranch: "main",
        headBranch: "feature/activity",
        state: "open",
      },
    });
    const livePr: OrchestrationThreadPullRequest = {
      number: 42,
      title: "Live merged PR",
      url: "https://github.com/acme/synara/pull/42",
      baseBranch: "main",
      headBranch: "feature/activity",
      state: "merged",
    };
    const onVisibleThreadIdsChange = vi.fn();
    const mounted = await render(
      renderActivity({
        threads,
        prByThreadId: new Map([[threads[44].id, livePr]]),
        onVisibleThreadIdsChange,
      }),
    );

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-testid^='activity-thread-']")).toHaveLength(20);
      expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toHaveLength(20);
    });
    expect(document.querySelector('[title="#42 PR merged: Live merged PR"]')).not.toBeNull();

    await page.getByRole("button", { name: "Show more" }).click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll("[data-testid^='activity-thread-']")).toHaveLength(40);
      expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toHaveLength(40);
    });
    await mounted.unmount();
  });

  it("renames on row double-click and opens the row/project menus on right-click", async () => {
    const thread = makeThread(0);
    const onRenameThread = vi.fn();
    const onThreadContextMenu = vi.fn();
    const onProjectContextMenu = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [thread],
        onRenameThread,
        onThreadContextMenu,
        onProjectContextMenu,
      }),
    );

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    const row = page.getByTestId(`activity-thread-${thread.id}`).element();
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(onRenameThread).toHaveBeenCalledWith(thread.id);

    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 }),
    );
    expect(onThreadContextMenu).toHaveBeenCalledWith(thread.id, { x: 12, y: 34 });
    // The row menu must not also bubble into the project block it sits under.
    expect(onProjectContextMenu).not.toHaveBeenCalled();

    const projectBlockLabel = document.querySelector('[data-slot="activity-section-label"]');
    expect(projectBlockLabel).not.toBeNull();
    projectBlockLabel?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }),
    );
    expect(onProjectContextMenu).toHaveBeenCalledWith(PROJECT_A, { x: 5, y: 6 });
    await mounted.unmount();
  });

  it("does not forward touch action taps to the row rename gesture", async () => {
    const thread = makeThread(0);
    const onThreadRenamePointerUp = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [thread],
        onThreadRenamePointerUp,
      }),
    );

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    const pinButton = page.getByRole("button", { name: "Pin thread" }).element();
    pinButton.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch" }),
    );
    pinButton.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch" }),
    );
    expect(onThreadRenamePointerUp).not.toHaveBeenCalled();

    page
      .getByTestId(`activity-thread-${thread.id}`)
      .element()
      .dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
        }),
      );
    expect(onThreadRenamePointerUp).toHaveBeenCalledWith(expect.anything(), thread.id);
    await mounted.unmount();
  });

  it("keeps settled pins undoable and marks unseen work read before settling it", async () => {
    const pinned = makeThread(100, { settledAt: "2026-08-02T12:30:00.000Z" });
    const unseen = makeThread(101, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const resumedSettled = makeThread(102, {
      settledAt: "2026-08-02T09:30:00.000Z",
      lastVisitedAt: "2026-08-02T09:00:00.000Z",
    });
    const onSetThreadSettled = vi.fn();
    const onMarkThreadRead = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [pinned, unseen, resumedSettled],
        pinnedThreadIdSet: new Set([pinned.id]),
        onSetThreadSettled,
        onMarkThreadRead,
        resolveThreadStatus: (thread) =>
          thread.id === unseen.id
            ? {
                label: "Completed",
                colorClass: "text-emerald-600",
                dotClass: "bg-emerald-500",
                pulse: false,
              }
            : null,
      }),
    );

    const completedDot = page
      .getByTestId(`activity-thread-${unseen.id}`)
      .element()
      .parentElement?.querySelector('[aria-label="Unread completion"]');
    expect(completedDot).not.toBeNull();
    expect(completedDot?.parentElement?.dataset.slot).toBe("activity-completion-status");
    const completedStatusSlot = completedDot?.parentElement;
    const completedStatusLeft = completedStatusSlot?.getBoundingClientRect().left;

    const pinnedRow = page.getByTestId(`activity-thread-${pinned.id}`).element();
    pinnedRow.focus();
    pinnedRow.parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.click();
    expect(onSetThreadSettled).toHaveBeenCalledWith(pinned.id, false);

    const resumedRow = page.getByTestId(`activity-thread-${resumedSettled.id}`).element();
    expect(resumedRow.parentElement?.querySelector('button[aria-label="Done"]')).not.toBeNull();

    page.getByTestId(`activity-thread-${unseen.id}`).element().focus();
    await vi.waitFor(() => {
      expect(getComputedStyle(completedStatusSlot!).opacity).toBe("0");
    });
    expect(completedStatusSlot?.getBoundingClientRect().left).toBe(completedStatusLeft);
    page
      .getByTestId(`activity-thread-${unseen.id}`)
      .element()
      .parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Done"]')
      ?.click();
    expect(onMarkThreadRead).toHaveBeenCalledWith(
      unseen.id,
      unseen.latestTurn?.completedAt ?? undefined,
    );
    expect(onSetThreadSettled).toHaveBeenCalledWith(unseen.id, true);
    expect(onMarkThreadRead.mock.invocationCallOrder[0]).toBeLessThan(
      onSetThreadSettled.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    await mounted.unmount();
  });

  it("reads a chat back from snooze at its reminder with Mark all as read and Done", async () => {
    // Its last reply was read before the reminder fired.
    const returned = makeThread(104, {
      lastVisitedAt: "2026-08-02T11:00:00.000Z",
      snoozedUntil: null,
      snoozeReminderAt: "2026-08-02T12:01:00.000Z",
    });
    const onMarkThreadRead = vi.fn();
    const mounted = await render(renderActivity({ threads: [returned], onMarkThreadRead }));
    try {
      await page.getByRole("button", { name: "Activity options" }).click();
      await page.getByRole("menuitem", { name: "Mark all as read" }).click();
      page
        .getByTestId(`activity-thread-${returned.id}`)
        .element()
        .parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Done"]')
        ?.click();

      expect(onMarkThreadRead.mock.calls).toEqual([
        [returned.id, returned.snoozeReminderAt],
        [returned.id, returned.snoozeReminderAt],
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it("opens settled rows through the shared thread activation path", async () => {
    const settled = makeThread(103, {
      branch: "feature/finished",
      settledAt: "2026-08-02T12:30:00.000Z",
    });
    const onOpenThread = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [settled],
        pinnedThreadIdSet: new Set([settled.id]),
        onOpenThread,
      }),
    );

    await page.getByTestId(`activity-thread-${settled.id}`).click();
    expect(onOpenThread).toHaveBeenCalledOnce();
    expect(onOpenThread).toHaveBeenCalledWith(settled.id);
    await mounted.unmount();
  });

  it("clears a project scope after that project disappears instead of reviving it later", async () => {
    const projectA = makeProject(PROJECT_A, "Project A");
    const projectB = makeProject(PROJECT_B, "Project B");
    const threadA = makeThread(200);
    const threadB = makeThread(201, { projectId: PROJECT_B });
    const mounted = await render(
      renderActivity({ threads: [threadA, threadB], projects: [projectA, projectB] }),
    );

    await page.getByRole("button", { name: "Filter activity by project" }).click();
    await page.getByRole("menuitemradio", { name: /Project A/u }).click();
    await expect
      .element(page.getByRole("button", { name: "Filter activity by project" }))
      .toHaveTextContent("Project A");

    await mounted.rerender(renderActivity({ threads: [threadB], projects: [projectB] }));
    await expect
      .element(page.getByRole("button", { name: "Filter activity by project" }))
      .toHaveTextContent("All activity");

    await mounted.rerender(
      renderActivity({ threads: [threadA, threadB], projects: [projectA, projectB] }),
    );
    await expect
      .element(page.getByRole("button", { name: "Filter activity by project" }))
      .toHaveTextContent("All activity");
    await mounted.unmount();
  });

  it("keeps a remembered project scope when the view remounts", async () => {
    const projectA = makeProject(PROJECT_A, "Project A");
    const projectB = makeProject(PROJECT_B, "Project B");
    const threads = [makeThread(210), makeThread(211, { projectId: PROJECT_B })];
    const projects = [projectA, projectB];
    // Stands in for the sidebar, which owns the scope across Settings round-trips.
    let selection: ActivityScopeSelection = null;
    const scope = () => ({
      selection,
      onChange: (next: ActivityScopeSelection) => {
        selection = next;
      },
    });
    const first = await render(renderActivity({ threads, projects, scope: scope() }));
    await page.getByRole("button", { name: "Filter activity by project" }).click();
    await page.getByRole("menuitemradio", { name: /Project B/u }).click();
    expect(selection).toBe(PROJECT_B);
    await first.unmount();

    const second = await render(renderActivity({ threads, projects, scope: scope() }));
    await expect
      .element(page.getByRole("button", { name: "Filter activity by project" }))
      .toHaveTextContent("Project B");
    await second.unmount();
  });

  it("does not drop a remembered scope while threads are still hydrating", async () => {
    const projectA = makeProject(PROJECT_A, "Project A");
    const onChange = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [],
        projects: [projectA],
        threadsHydrated: false,
        scope: { selection: PROJECT_A, onChange },
      }),
    );
    await expect.element(page.getByText("Loading activity...")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await mounted.rerender(
      renderActivity({
        threads: [makeThread(220)],
        projects: [projectA],
        scope: { selection: PROJECT_A, onChange },
      }),
    );
    await expect
      .element(page.getByRole("button", { name: "Filter activity by project" }))
      .toHaveTextContent("Project A");
    expect(onChange).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it("moves an unread pin into Priority once and suppresses a stale dot on the open thread", async () => {
    const pinnedUnread = makeThread(300, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const openThread = makeThread(301, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const completedStatus: ThreadStatusPill = {
      label: "Completed",
      colorClass: "text-emerald-600",
      dotClass: "bg-emerald-500",
      pulse: false,
    };
    const mounted = await render(
      renderActivity({
        threads: [pinnedUnread, openThread],
        activeThreadId: openThread.id,
        pinnedThreadIdSet: new Set([pinnedUnread.id]),
        resolveThreadStatus: () => completedStatus,
      }),
    );

    // Priority lists the pin, so Pinned has nothing left to show.
    await expect.element(page.getByText("Priority", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Pinned", exact: true }))
      .not.toBeInTheDocument();
    expect(
      document.querySelectorAll(`[data-testid="activity-thread-${pinnedUnread.id}"]`),
    ).toHaveLength(1);
    expect(
      page
        .getByTestId(`activity-thread-${pinnedUnread.id}`)
        .element()
        .parentElement?.querySelector('[aria-label="Unread completion"]'),
    ).not.toBeNull();
    expect(
      page
        .getByTestId(`activity-thread-${openThread.id}`)
        .element()
        .parentElement?.querySelector('[aria-label="Unread completion"]'),
    ).toBeNull();
    await mounted.unmount();
  });

  it.each(["persisted", "optimistic"] as const)(
    "returns a Done pin from Priority to Pinned (%s)",
    async (mode) => {
      const pinned = makeThread(930, { hasPendingApprovals: true });
      const props = {
        threads: [pinned],
        pinnedThreadIdSet: new Set([pinned.id]),
        resolveThreadStatus: realThreadStatus,
      };
      const mounted = await render(renderActivity(props));
      await expect.poll(activityLayout).toEqual(["# Priority", pinned.id]);
      await mounted.rerender(
        renderActivity({
          ...props,
          threads: [
            {
              ...pinned,
              hasPendingApprovals: false,
              ...(mode === "persisted" ? { settledAt: "2026-08-02T12:00:00.000Z" } : {}),
            },
          ],
          settledOverrideByThreadId:
            mode === "optimistic" ? new Map([[pinned.id, true]]) : new Map(),
        }),
      );
      await expect.poll(activityLayout).toEqual([pinned.id]);
      await expect.element(page.getByRole("button", { name: "Pinned", exact: true })).toBeVisible();
      await mounted.unmount();
    },
  );

  it("shows a preparing first worktree in its project scope while excluding plain drafts and children", async () => {
    const preparing = makeThread(940, { latestTurn: null, latestHumanMessageAt: null });
    const draft = makeThread(941, { latestTurn: null, latestHumanMessageAt: null });
    const child = makeThread(942, { latestTurn: null, parentThreadId: preparing.id });
    const archived = makeThread(943, { latestTurn: null, archivedAt: "2026-08-02T11:00:00.000Z" });
    const onChange = vi.fn();
    const status = (thread: SidebarThreadSummary) =>
      resolveThreadStatusPill({
        thread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        isPreparingWorktree: thread.id !== draft.id,
      });
    const mounted = await render(
      renderActivity({
        threads: [preparing, draft, child, archived],
        resolveThreadStatus: status,
        scope: { selection: PROJECT_A, onChange },
      }),
    );
    await expect.poll(activityLayout).toEqual(["# Priority", preparing.id]);
    expect(onChange).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it("lists every chat that needs the user or is running in Priority, with no cap", async () => {
    const running = Array.from({ length: 6 }, (_, index) =>
      makeThread(900 + index, { hasLiveTailWork: true }),
    );
    const unread = makeThread(910, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const waiting = makeThread(911, { hasPendingApprovals: true });
    const idle = makeThread(912);
    const onVisibleThreadIdsChange = vi.fn();
    const mounted = await render(
      renderActivity({
        threads: [...running, unread, waiting, idle],
        resolveThreadStatus: realThreadStatus,
        onVisibleThreadIdsChange,
      }),
    );
    const priorityOrder = [
      waiting.id,
      unread.id,
      ...running.map((thread) => thread.id).toReversed(),
    ];
    await vi.waitFor(() => {
      expect(activityLayout()).toEqual(["# Priority", ...priorityOrder, "# Today", idle.id]);
      expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith([...priorityOrder, idle.id]);
    });
    await mounted.unmount();
  });

  it.each(["clear read", "eraser", "grouping roundtrip"] as const)(
    "holds Priority still while chats change and resets read rows (%s)",
    async (reset) => {
      const waiting = makeThread(920, { hasPendingApprovals: true });
      const unread = makeThread(921, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
      const running = makeThread(922, { hasLiveTailWork: true });
      const idle = makeThread(923);
      const onOpenThread = vi.fn();
      const mounted = await render(
        renderActivity({
          threads: [waiting, unread, running, idle],
          resolveThreadStatus: realThreadStatus,
          onOpenThread,
        }),
      );
      await vi.waitFor(() => {
        expect(activityLayout()).toEqual([
          "# Priority",
          waiting.id,
          unread.id,
          running.id,
          "# Today",
          idle.id,
        ]);
      });
      await page.getByRole("button", { name: "Activity options" }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Clear read from Priority" }))
        .toHaveAttribute("aria-disabled", "true");
      await userEvent.keyboard("{Escape}");
      // Nothing read yet, so Priority's header offers no eraser.
      expect(
        page.getByRole("button", { name: "Clear read from Priority" }).elements(),
      ).toHaveLength(0);

      // The approval is answered and runs, the unread chat is opened, the running one
      // finishes unseen, and the idle one asks for input: rows keep their places, the
      // read row stays listed, and the newcomer joins at the end.
      const answered = { ...waiting, hasPendingApprovals: false, hasLiveTailWork: true };
      const opened = { ...unread, lastVisitedAt: "2026-08-02T12:00:00.000Z" };
      const finished = {
        ...running,
        hasLiveTailWork: false,
        lastVisitedAt: "2026-08-02T09:00:00.000Z",
      };
      const asking = { ...idle, hasPendingUserInput: true };
      await mounted.rerender(
        renderActivity({
          threads: [answered, opened, finished, asking],
          resolveThreadStatus: realThreadStatus,
          onOpenThread,
        }),
      );
      await vi.waitFor(() => {
        expect(activityLayout()).toEqual([
          "# Priority",
          waiting.id,
          unread.id,
          running.id,
          idle.id,
        ]);
      });

      if (reset === "eraser") {
        await page.getByRole("button", { name: "Clear read from Priority" }).click();
      } else if (reset === "clear read") {
        await page.getByRole("button", { name: "Activity options" }).click();
        await page.getByRole("menuitem", { name: "Clear read from Priority" }).click();
      } else {
        await page.getByRole("button", { name: "Activity options" }).click();
        await page.getByRole("menuitemradio", { name: "Project", exact: true }).click();
        // Radio choices keep the shared menu open; switch back in that same popup.
        await expect.element(page.getByText("Priority", { exact: true })).not.toBeInTheDocument();
        await page.getByRole("menuitemradio", { name: "Time", exact: true }).click();
        await expect
          .element(page.getByRole("menuitemradio", { name: "Time", exact: true }))
          .toHaveAttribute("aria-checked", "true");
      }
      // The menu interaction has committed. A fresh sort returns read rows to Today.
      expect(activityLayout()).toEqual([
        "# Priority",
        idle.id,
        running.id,
        waiting.id,
        "# Today",
        unread.id,
      ]);
      expect(onOpenThread).not.toHaveBeenCalled();
      await mounted.unmount();
    },
  );

  it("reveals a selected Activity row without moving focus or following background updates", async () => {
    const leading = Array.from({ length: 8 }, (_, index) => makeThread(700 + index));
    const old = makeThread(720, {
      title: "Selected conversation",
      latestHumanMessageAt: "2026-05-04T10:00:00.000Z",
      createdAt: "2026-05-04T09:00:00.000Z",
    });
    const layout = (rows: readonly SidebarThreadSummary[], activeThreadId: ThreadId | null) => (
      <section data-testid="activity-reveal-example" className="w-80 bg-background p-3">
        <input aria-label="Composer focus" className="mb-3 w-full" />
        <div data-slot="scroll-area-viewport" className="h-64 overflow-y-auto">
          {renderActivity({ threads: rows, activeThreadId })}
        </div>
      </section>
    );
    const threads = [...leading, old];
    const mounted = await render(layout(threads, null));
    try {
      const composer = page.getByRole("textbox", { name: "Composer focus" }).element();
      composer.focus();
      await mounted.rerender(layout(threads, old.id));
      const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      const row = page.getByTestId(`activity-thread-${old.id}`).element();
      await vi.waitFor(() => {
        expect(row.getAttribute("aria-current")).toBe("page");
        expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          viewport.getBoundingClientRect().top - 1,
        );
        expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          viewport.getBoundingClientRect().bottom + 1,
        );
        expect(viewport.scrollTop).toBeGreaterThan(0);
      });
      expect(document.activeElement).toBe(composer);
      await expect
        .element(page.getByRole("button", { name: "Earlier", exact: true }))
        .toHaveAttribute("aria-expanded", "false");

      // The reader can browse elsewhere after the one-time route reveal.
      viewport.scrollTop = 0;
      await mounted.rerender(
        layout([...leading.slice(1), { ...old, hasLiveTailWork: true }], old.id),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      expect(viewport.scrollTop).toBe(0);
      expect(document.activeElement).toBe(composer);

      // A later route selection reveals it again.
      await mounted.rerender(layout(threads, null));
      await mounted.rerender(layout(threads, old.id));
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    } finally {
      await mounted.unmount();
    }
  });

  it("reveals the active pin after reopening Pinned and changing scope", async () => {
    const threads = Array.from({ length: 10 }, (_, index) => makeThread(740 + index));
    const activeThreadId = threads[0]!.id;
    const layout = (selection: ActivityScopeSelection) => (
      <div data-slot="scroll-area-viewport" className="h-64 w-80 overflow-y-auto">
        {renderActivity({
          threads,
          activeThreadId,
          pinnedThreadIdSet: new Set(threads.map((thread) => thread.id)),
          scope: { selection, onChange: vi.fn() },
        })}
      </div>
    );
    const mounted = await render(layout(null));
    try {
      const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
      const pinned = page.getByRole("button", { name: "Pinned", exact: true });
      await pinned.click();
      await expect.element(pinned).toHaveAttribute("aria-expanded", "false");
      await pinned.click();
      await expect.element(pinned).toHaveAttribute("aria-expanded", "true");
      viewport.scrollTop = 0;
      await mounted.rerender(layout(PROJECT_A));
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps an old open thread on screen under collapsed Earlier until another thread opens", async () => {
    const recent = makeThread(600);
    const old = makeThread(601, {
      latestHumanMessageAt: "2026-05-04T10:00:00.000Z",
      updatedAt: "2026-05-04T10:00:00.000Z",
      createdAt: "2026-05-04T09:00:00.000Z",
    });
    const onVisibleThreadIdsChange = vi.fn();
    const oldRows = () => document.querySelectorAll(`[data-testid="activity-thread-${old.id}"]`);
    const input = { threads: [recent, old], onVisibleThreadIdsChange };
    const mounted = await render(renderActivity({ ...input, activeThreadId: old.id }));

    const earlier = page.getByRole("button", { name: "Earlier", exact: true });
    await expect.element(earlier).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByTestId(`activity-thread-${old.id}`)).toBeVisible();
    expect(oldRows()).toHaveLength(1);
    await vi.waitFor(() =>
      expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith([recent.id, old.id]),
    );

    // Expanding moves the row into the section instead of rendering it twice.
    await earlier.click();
    await expect.element(earlier).toHaveAttribute("aria-expanded", "true");
    expect(oldRows()).toHaveLength(1);
    await earlier.click();
    await expect.element(earlier).toHaveAttribute("aria-expanded", "false");

    await mounted.rerender(renderActivity({ ...input, activeThreadId: recent.id }));
    await vi.waitFor(() => expect(oldRows()).toHaveLength(0));
    await vi.waitFor(() => expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith([recent.id]));
    await mounted.unmount();
  });
});
