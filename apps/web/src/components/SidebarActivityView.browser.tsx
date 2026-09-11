// FILE: SidebarActivityView.browser.tsx
// Purpose: Browser regressions for Activity paging, stateful actions, scope fallback, and live PR data.
// Layer: Sidebar Activity UI test

import "../index.css";

import { ProjectId, ThreadId, type OrchestrationThreadPullRequest } from "@synara/contracts";
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { Project, SidebarThreadSummary } from "../types";
import { hasUnseenCompletion, type ThreadStatusPill } from "./Sidebar.logic";
import { SidebarActivityView } from "./SidebarActivityView";

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
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

function makeRunningThread(index: number, turnId: string): SidebarThreadSummary {
  return makeThread(index, {
    hasLiveTailWork: true,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: "2026-08-02T10:01:00.000Z",
      startedAt: "2026-08-02T10:01:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    } as SidebarThreadSummary["latestTurn"],
  });
}

function renderActivity(input: {
  threads: readonly SidebarThreadSummary[];
  projects?: readonly Project[];
  activeThreadId?: ThreadId | null;
  pinnedThreadIdSet?: ReadonlySet<ThreadId>;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  prByThreadId?: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  onVisibleThreadIdsChange?: (threadIds: readonly ThreadId[]) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onSetThreadSettled?: (threadId: ThreadId, settled: boolean) => void;
  onMarkThreadRead?: (threadId: ThreadId, completedAt?: string) => void;
  onRenameThread?: (threadId: ThreadId) => void;
  onThreadRenamePointerUp?: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onThreadContextMenu?: (threadId: ThreadId, position: { x: number; y: number }) => void;
  onProjectContextMenu?: (projectId: ProjectId, position: { x: number; y: number }) => void;
  resolveThreadStatus?: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
}) {
  const projects = input.projects ?? [makeProject(PROJECT_A, "Project A")];
  return (
    <SidebarActivityView
      threads={input.threads}
      projectById={new Map(projects.map((project) => [project.id, project]))}
      activeThreadId={input.activeThreadId ?? null}
      pinnedThreadIdSet={input.pinnedThreadIdSet ?? new Set()}
      settledOverrideByThreadId={input.settledOverrideByThreadId ?? new Map()}
      threadsHydrated
      prByThreadId={input.prByThreadId ?? new Map()}
      onVisibleThreadIdsChange={input.onVisibleThreadIdsChange ?? (() => {})}
      resolveThreadStatus={input.resolveThreadStatus ?? (() => null)}
      onOpenThread={input.onOpenThread ?? (() => {})}
      onOpenThreadPullRequest={() => {}}
      onSetThreadSettled={input.onSetThreadSettled ?? (() => {})}
      onToggleThreadPinned={() => {}}
      onArchiveThread={() => {}}
      onMarkThreadRead={input.onMarkThreadRead ?? (() => {})}
      onRenameThread={input.onRenameThread ?? (() => {})}
      onThreadRenamePointerUp={input.onThreadRenamePointerUp ?? (() => {})}
      onThreadContextMenu={input.onThreadContextMenu ?? (() => {})}
      onProjectContextMenu={input.onProjectContextMenu ?? (() => {})}
      renderThreadHoverCard={() => null}
      onCreateChat={() => {}}
      onAddProject={() => {}}
    />
  );
}

function StatefulReadOrderActivity({
  initialThreads,
}: {
  initialThreads: readonly SidebarThreadSummary[];
}) {
  const [threads, setThreads] = useState(initialThreads);
  const [activeThreadId, setActiveThreadId] = useState<ThreadId | null>(null);
  const [settledOverrideByThreadId, setSettledOverrideByThreadId] = useState<
    ReadonlyMap<ThreadId, boolean>
  >(() => new Map());
  const markRead = (threadId: ThreadId, completedAt?: string) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId && thread.latestTurn?.completedAt === completedAt
          ? { ...thread, lastVisitedAt: new Date().toISOString() }
          : thread,
      ),
    );
  };

  return (
    <SidebarActivityView
      threads={threads}
      projectById={new Map([[PROJECT_A, makeProject(PROJECT_A, "Project A")]])}
      activeThreadId={activeThreadId}
      pinnedThreadIdSet={new Set()}
      settledOverrideByThreadId={settledOverrideByThreadId}
      threadsHydrated
      prByThreadId={new Map()}
      onVisibleThreadIdsChange={() => {}}
      resolveThreadStatus={(thread) =>
        hasUnseenCompletion(thread)
          ? {
              label: "Completed",
              colorClass: "text-emerald-600",
              dotClass: "bg-emerald-500",
              pulse: false,
            }
          : null
      }
      onOpenThread={(threadId) => {
        const thread = threads.find((candidate) => candidate.id === threadId);
        setActiveThreadId(threadId);
        markRead(threadId, thread?.latestTurn?.completedAt ?? undefined);
      }}
      onOpenThreadPullRequest={() => {}}
      onSetThreadSettled={(threadId, settled) => {
        setSettledOverrideByThreadId((current) => {
          const next = new Map(current);
          next.set(threadId, settled);
          return next;
        });
      }}
      onToggleThreadPinned={() => {}}
      onArchiveThread={() => {}}
      onMarkThreadRead={markRead}
      onRenameThread={() => {}}
      onThreadRenamePointerUp={() => {}}
      onThreadContextMenu={() => {}}
      onProjectContextMenu={() => {}}
      renderThreadHoverCard={() => null}
      onCreateChat={() => {}}
      onAddProject={() => {}}
    />
  );
}

function renderedActivityThreadIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='activity-thread-']"))
    .map((element) => element.dataset.testid)
    .filter((testId): testId is string => testId !== undefined)
    .map((testId) => testId.replace("activity-thread-", ""));
}

describe("SidebarActivityView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reveals the active thread from collapsed Earlier with current-page semantics", async () => {
    const completedAt = "2000-01-02T10:00:00.000Z";
    const active = makeThread(490, {
      title: "المحادثة الحالية https://example.com/a/very/long/path",
      updatedAt: completedAt,
      lastVisitedAt: "2000-01-02T11:00:00.000Z",
      latestTurn: {
        turnId: "activity-turn-active-earlier",
        state: "completed",
        requestedAt: completedAt,
        startedAt: completedAt,
        completedAt,
        assistantMessageId: null,
      } as SidebarThreadSummary["latestTurn"],
    });
    const leadingRows = Array.from({ length: 5 }, (_, index) =>
      makeRunningThread(600 + index, `activity-turn-leading-${index}`),
    );
    const activity = renderActivity({
      threads: [...leadingRows, active],
      activeThreadId: active.id,
    });
    const mounted = await render(
      <>
        <button type="button" data-testid="focus-sentinel">
          Keep focus
        </button>
        <div data-slot="scroll-area-viewport" className="h-32 overflow-y-auto">
          {activity}
        </div>
      </>,
    );
    const focusSentinel = page.getByTestId("focus-sentinel").element();
    focusSentinel.focus();

    await vi.waitFor(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-testid='activity-thread-${active.id}']`,
      );
      const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      expect(row).not.toBeNull();
      expect(viewport).not.toBeNull();
      expect(row?.getAttribute("aria-current")).toBe("page");
      expect(row?.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(row!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        viewport!.getBoundingClientRect().top - 1,
      );
      expect(row!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        viewport!.getBoundingClientRect().bottom + 1,
      );
      expect(viewport!.scrollTop).toBeGreaterThan(0);
    });
    expect(document.activeElement).toBe(focusSentinel);

    await page.getByRole("button", { name: "Earlier", exact: true }).click();
    await mounted.rerender(
      <>
        <button type="button" data-testid="focus-sentinel">
          Keep focus
        </button>
        <div data-slot="scroll-area-viewport" className="h-32 overflow-y-auto">
          {activity}
        </div>
      </>,
    );
    expect(
      page
        .getByRole("button", { name: "Earlier", exact: true })
        .element()
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await mounted.unmount();
  });

  it("retains a deep active project row without mounting the skipped middle page", async () => {
    const threads = Array.from({ length: 25 }, (_, index) => makeThread(700 + index));
    const active = threads[24]!;
    const onVisibleThreadIdsChange = vi.fn();
    const mounted = await render(
      renderActivity({
        threads,
        activeThreadId: active.id,
        onVisibleThreadIdsChange,
      }),
    );

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      const renderedIds = renderedActivityThreadIds();
      expect(renderedIds).toHaveLength(21);
      expect(renderedIds.at(-1)).toBe(active.id);
      expect(new Set(renderedIds).size).toBe(renderedIds.length);
      expect(onVisibleThreadIdsChange.mock.lastCall?.[0]).toEqual(renderedIds);
      expect(
        page.getByTestId(`activity-thread-${active.id}`).element().getAttribute("aria-current"),
      ).toBe("page");
    });
    await mounted.unmount();
  });

  it("opens Done when it owns the active thread", async () => {
    const active = makeThread(750, { settledAt: "2026-08-02T12:30:00.000Z" });
    const mounted = await render(renderActivity({ threads: [active], activeThreadId: active.id }));

    await vi.waitFor(() => {
      expect(
        page
          .getByRole("button", { name: "Done", exact: true })
          .element()
          .getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        page.getByTestId(`activity-thread-${active.id}`).element().getAttribute("aria-current"),
      ).toBe("page");
    });
    await mounted.unmount();
  });

  it("keeps an opened unread completion ahead of running work until another thread opens", async () => {
    const unread = makeThread(500, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const running = makeRunningThread(501, "activity-turn-running");
    const mounted = await render(<StatefulReadOrderActivity initialThreads={[running, unread]} />);

    expect(renderedActivityThreadIds()).toEqual([unread.id, running.id]);
    expect(
      page
        .getByTestId(`activity-thread-${unread.id}`)
        .element()
        .parentElement?.querySelector('[aria-label="Unread completion"]'),
    ).not.toBeNull();

    await page.getByTestId(`activity-thread-${unread.id}`).click();
    await vi.waitFor(() => {
      expect(renderedActivityThreadIds()).toEqual([unread.id, running.id]);
      expect(
        page
          .getByTestId(`activity-thread-${unread.id}`)
          .element()
          .parentElement?.querySelector('[aria-label="Unread completion"]'),
      ).toBeNull();
    });

    await page.getByTestId(`activity-thread-${running.id}`).click();
    await vi.waitFor(() => {
      expect(renderedActivityThreadIds()).toEqual([running.id, unread.id]);
    });
    await mounted.unmount();
  });

  it("preserves the same read-order hold for keyboard activation in project grouping", async () => {
    const unread = makeThread(510, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const running = makeRunningThread(511, "activity-turn-project-running");
    const mounted = await render(<StatefulReadOrderActivity initialThreads={[running, unread]} />);

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Project" }).click();
    await userEvent.keyboard("{Escape}");
    const unreadRow = page.getByTestId(`activity-thread-${unread.id}`).element();
    unreadRow.focus();
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => {
      expect(renderedActivityThreadIds()).toEqual([unread.id, running.id]);
      expect(unreadRow.parentElement?.querySelector('[aria-label="Unread completion"]')).toBeNull();
    });
    await mounted.unmount();
  });

  it("releases the read-order hold when the opened thread is explicitly marked done", async () => {
    const unread = makeThread(520, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const running = makeRunningThread(521, "activity-turn-done-running");
    const mounted = await render(<StatefulReadOrderActivity initialThreads={[running, unread]} />);

    await page.getByTestId(`activity-thread-${unread.id}`).click();
    await vi.waitFor(() => {
      expect(renderedActivityThreadIds()).toEqual([unread.id, running.id]);
    });

    const unreadRow = page.getByTestId(`activity-thread-${unread.id}`).element();
    unreadRow.parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Done"]')?.click();
    await vi.waitFor(() => {
      expect(renderedActivityThreadIds()).toEqual([running.id, unread.id]);
    });
    await mounted.unmount();
  });

  it("releases the read-order hold when all activity is explicitly marked read", async () => {
    const openedUnread = makeThread(530, { lastVisitedAt: "2026-08-02T09:00:00.000Z" });
    const backgroundUnread = makeThread(529, {
      lastVisitedAt: "2026-08-02T09:00:00.000Z",
    });
    const running = makeRunningThread(531, "activity-turn-mark-all-running");
    const mounted = await render(
      <StatefulReadOrderActivity initialThreads={[running, backgroundUnread, openedUnread]} />,
    );

    await page.getByTestId(`activity-thread-${openedUnread.id}`).click();
    await vi.waitFor(() => {
      expect(renderedActivityThreadIds()).toEqual([
        openedUnread.id,
        backgroundUnread.id,
        running.id,
      ]);
    });

    await page.getByRole("button", { name: "Activity options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Mark all as read" }).click();
    await vi.waitFor(() => {
      expect(renderedActivityThreadIds()[0]).toBe(running.id);
      expect(document.querySelector('[aria-label="Unread completion"]')).toBeNull();
    });
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
    expect(resumedRow.parentElement?.querySelector('button[aria-label="Undo"]')).not.toBeNull();

    page.getByTestId(`activity-thread-${unseen.id}`).element().focus();
    await vi.waitFor(() => {
      expect(getComputedStyle(completedStatusSlot!).opacity).toBe("0");
    });
    expect(completedStatusSlot?.getBoundingClientRect().left).toBe(completedStatusLeft);
    await page.getByRole("button", { name: "Done" }).click();
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

  it("shows unread pins once in open Pinned and suppresses a stale dot on the open thread", async () => {
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

    await expect
      .element(page.getByRole("button", { name: "Pinned", exact: true }))
      .toHaveAttribute("aria-expanded", "true");
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

  it("gives pulsing status glyphs an accessible name", async () => {
    const running = makeThread(400, { hasLiveTailWork: true });
    const mounted = await render(
      renderActivity({
        threads: [running],
        resolveThreadStatus: () => ({
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        }),
      }),
    );

    expect(
      page
        .getByTestId(`activity-thread-${running.id}`)
        .element()
        .parentElement?.querySelector('[role="img"][aria-label="Working"]'),
    ).not.toBeNull();
    await mounted.unmount();
  });
});
