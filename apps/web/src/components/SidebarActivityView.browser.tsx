// FILE: SidebarActivityView.browser.tsx
// Purpose: Browser regressions for Activity paging, stateful actions, scope fallback, and live PR data.
// Layer: Sidebar Activity UI test

import "../index.css";

import { ProjectId, ThreadId, type OrchestrationThreadPullRequest } from "@synara/contracts";
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { Project, SidebarThreadSummary } from "../types";
import { useComposerDraftStore } from "../composerDraftStore";
import { DEFAULT_PROJECT_ICON, type ProjectAppearance } from "../lib/projectAppearance";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { SidebarActivityView } from "./SidebarActivityView";
import type { ActivityScopeSelection } from "./SidebarActivityView.logic";
import { Sidebar, SidebarContent, SidebarProvider, SidebarTrigger, useSidebar } from "./ui/sidebar";

const projectFavicon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="red"/></svg>',
)}`;

vi.mock("~/lib/wsHttpUrl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/wsHttpUrl")>()),
  resolveWsHttpUrl: () => projectFavicon,
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
  compact?: boolean;
  projects?: readonly Project[];
  activeThreadId?: ThreadId | null;
  pinnedThreadIdSet?: ReadonlySet<ThreadId>;
  settledOverrideByThreadId?: ReadonlyMap<ThreadId, boolean>;
  prByThreadId?: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest | null>;
  onVisibleThreadIdsChange?: (threadIds: readonly ThreadId[]) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onSetThreadSettled?: (threadId: ThreadId, settled: boolean) => void;
  onReturnSnoozedThread?: (threadId: ThreadId) => void;
  onMarkThreadRead?: (threadId: ThreadId, completedAt?: string) => void;
  onRenameThread?: (threadId: ThreadId) => void;
  onThreadRenamePointerUp?: (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => void;
  onThreadContextMenu?: (threadId: ThreadId, position: { x: number; y: number }) => void;
  onProjectContextMenu?: (projectId: ProjectId, position: { x: number; y: number }) => void;
  resolveThreadStatus?: (thread: SidebarThreadSummary) => ThreadStatusPill | null;
  threadJumpLabelByThreadId?: ReadonlyMap<ThreadId, string>;
  snoozedRevealRequest?: number;
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
  const [groupMode, setGroupMode] = useState<"time" | "project">("time");
  return (
    <SidebarActivityView
      compact={input.compact ?? false}
      snoozedRevealRequest={input.snoozedRevealRequest ?? 0}
      threads={input.threads}
      projectById={new Map(projects.map((project) => [project.id, project]))}
      activeThreadId={input.activeThreadId ?? null}
      pinnedThreadIdSet={input.pinnedThreadIdSet ?? new Set()}
      settledOverrideByThreadId={input.settledOverrideByThreadId ?? new Map()}
      threadsHydrated={input.threadsHydrated ?? true}
      groupMode={groupMode}
      onGroupModeChange={setGroupMode}
      scopeSelection={input.scope ? input.scope.selection : localScope}
      onScopeSelectionChange={input.scope ? input.scope.onChange : setLocalScope}
      prByThreadId={input.prByThreadId ?? new Map()}
      threadJumpLabelByThreadId={input.threadJumpLabelByThreadId ?? new Map()}
      onVisibleThreadIdsChange={input.onVisibleThreadIdsChange ?? (() => {})}
      resolveThreadStatus={input.resolveThreadStatus ?? (() => null)}
      onOpenThread={input.onOpenThread ?? (() => {})}
      onOpenThreadPullRequest={() => {}}
      onSetThreadSettled={input.onSetThreadSettled ?? (() => {})}
      onReturnSnoozedThread={input.onReturnSnoozedThread ?? (() => {})}
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

function CollapsibleActivityHarness(input: Parameters<typeof renderActivity>[0]) {
  const { state, isMobile } = useSidebar();
  return renderActivity({ ...input, compact: !isMobile && state === "collapsed" });
}

describe("SidebarActivityView", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-02T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("excludes Done and archived chats from compact rows and navigation while keeping Done in the full list", async () => {
    await page.viewport(1280, 800);
    const active = makeThread(81);
    const done = makeThread(82, { settledAt: "2026-08-02T12:00:00.000Z" });
    const archived = makeThread(83, { archivedAt: "2026-08-02T12:00:00.000Z" });
    const unpinnedDone = makeThread(84, { settledAt: "2026-08-02T12:00:00.000Z" });
    const onVisibleThreadIdsChange = vi.fn();
    const mounted = await render(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="compact">
          <SidebarContent>
            <CollapsibleActivityHarness
              threads={[archived, done, active, unpinnedDone]}
              pinnedThreadIdSet={new Set([done.id])}
              activeThreadId={unpinnedDone.id}
              onVisibleThreadIdsChange={onVisibleThreadIdsChange}
            />
          </SidebarContent>
        </Sidebar>
        <main>
          <SidebarTrigger aria-label="Toggle filtered activity" />
        </main>
      </SidebarProvider>,
    );
    try {
      const doneRow = mounted.getByTestId(`activity-thread-${done.id}`);
      const archivedRow = mounted.getByTestId(`activity-thread-${archived.id}`);
      const unpinnedDoneRow = mounted.getByTestId(`activity-thread-${unpinnedDone.id}`);
      await expect.element(doneRow).not.toBeInTheDocument();
      await expect.element(unpinnedDoneRow).not.toBeInTheDocument();
      await expect.element(archivedRow).not.toBeInTheDocument();
      await expect.poll(() => onVisibleThreadIdsChange.mock.calls.at(-1)?.[0]).toEqual([active.id]);
      await mounted.getByRole("button", { name: "Toggle filtered activity" }).click();
      await expect.element(doneRow).toBeVisible();
      await expect.element(unpinnedDoneRow).toBeVisible();
      await expect.element(archivedRow).not.toBeInTheDocument();
      await mounted.getByRole("button", { name: "Toggle filtered activity" }).click();
      await expect.element(doneRow).not.toBeInTheDocument();
      await expect.element(unpinnedDoneRow).not.toBeInTheDocument();
      await expect.poll(() => onVisibleThreadIdsChange.mock.calls.at(-1)?.[0]).toEqual([active.id]);
    } finally {
      await mounted.unmount();
    }
  });

  it("scrolls the first snoozed conversation into view when requested from the rail", async () => {
    const snoozed = makeThread(55, { snoozedUntil: "2026-08-02T13:00:00.000Z" });
    const threads = [...Array.from({ length: 12 }, (_, index) => makeThread(index)), snoozed];
    const view = (request: number) => (
      <div data-testid="snoozed-scroll-container" style={{ height: 160, overflowY: "auto" }}>
        {renderActivity({ threads, snoozedRevealRequest: request })}
      </div>
    );
    const mounted = await render(view(0));
    try {
      await mounted.rerender(view(1));
      await expect.element(mounted.getByTestId(`activity-thread-${snoozed.id}`)).toBeVisible();
      const viewport = mounted.getByTestId("snoozed-scroll-container").element() as HTMLElement;
      const row = mounted.getByTestId(`activity-thread-${snoozed.id}`).element() as HTMLElement;
      await expect
        .poll(
          () => row.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom + 1,
        )
        .toBe(true);
      expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        viewport.getBoundingClientRect().top,
      );
      expect(viewport.scrollTop).toBeGreaterThan(0);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps Activity order, identities, status markers and snooze actions when expanding the compact list", async () => {
    await page.viewport(1280, 800);
    const running = makeThread(41);
    const review = makeThread(42, { modelSelection: { provider: "claudeAgent", model: "sonnet" } });
    const draft = makeThread(44);
    useComposerDraftStore.getState().setPrompt(draft.id, "Unsent draft");
    const snoozed = makeThread(43, { snoozedUntil: "2026-08-02T13:00:00.000Z" });
    const onReturnSnoozedThread = vi.fn();
    const onOpenThread = vi.fn();
    const mounted = await render(
      <SidebarProvider defaultOpen={false} className="h-svh">
        <Sidebar collapsible="compact">
          <SidebarContent>
            {renderActivity({
              threads: [running, review, draft, snoozed],
              activeThreadId: draft.id,
              pinnedThreadIdSet: new Set([running.id]),
              onOpenThread,
              onReturnSnoozedThread,
              threadJumpLabelByThreadId: new Map([[running.id, "⌘1"]]),
              resolveThreadStatus: (thread) =>
                thread.id === running.id
                  ? {
                      label: "Working",
                      pulse: true,
                      dotClass: "bg-sky-500",
                      colorClass: "text-sky-500",
                    }
                  : thread.id === review.id
                    ? {
                        label: "Pending Approval",
                        pulse: false,
                        dismissible: true,
                        dotClass: "bg-amber-500",
                        colorClass: "text-amber-500",
                      }
                    : null,
            })}
          </SidebarContent>
        </Sidebar>
        <main className="flex-1" data-testid="activity-compact-main">
          <SidebarTrigger aria-label="Toggle activity list" />
          Conversation
        </main>
      </SidebarProvider>,
    );
    try {
      const first = mounted.getByTestId(`activity-thread-${running.id}`);
      const button = first.element() as HTMLElement;
      const title = button.querySelector<HTMLElement>('[data-slot="sidebar-thread-title"]')!;
      const provider = button.querySelector<HTMLElement>('[data-slot="sidebar-thread-provider"]')!;
      expect(getComputedStyle(title).visibility).toBe("hidden");
      expect(provider.getBoundingClientRect().width).toBe(20);
      for (const thread of [running, review, draft]) {
        const row = mounted.getByTestId(`activity-thread-${thread.id}`).element();
        const bounds = row.getBoundingClientRect();
        const logo = row
          .querySelector<HTMLElement>('[data-slot="sidebar-thread-provider"]')!
          .getBoundingClientRect();
        expect(bounds.height).toBeCloseTo(bounds.width, 1);
        expect(bounds.height).toBe(36);
        expect(logo.left - bounds.left).toBeCloseTo(bounds.right - logo.right, 1);
        expect(logo.top - bounds.top).toBeCloseTo(bounds.bottom - logo.bottom, 1);
      }
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
        mounted.container
          .querySelector<HTMLElement>('[data-slot="sidebar-container"]')!
          .getBoundingClientRect().right,
      );
      await expect
        .element(mounted.getByRole("img", { name: "Working", exact: true }))
        .toBeVisible();
      await expect
        .element(mounted.getByRole("img", { name: "Pending Approval", exact: true }))
        .toBeVisible();
      await expect
        .element(mounted.getByRole("img", { name: "Unsent draft", exact: true }))
        .toBeVisible();
      const renderedOrder = () =>
        Array.from(
          mounted.container.querySelectorAll('[data-slot="activity-thread-button"]'),
          (row) => row.getAttribute("data-testid"),
        );
      const expectedOrder = [running, draft, review, snoozed].map(
        (thread) => `activity-thread-${thread.id}`,
      );
      expect(renderedOrder()).toEqual(expectedOrder);
      await mounted.getByRole("button", { name: "Toggle activity list" }).click();
      await expect.poll(() => getComputedStyle(title).visibility).toBe("visible");
      expect(renderedOrder()).toEqual(expectedOrder);
      await mounted.getByRole("button", { name: "Toggle activity list" }).click();
      await expect.poll(() => getComputedStyle(title).visibility).toBe("hidden");
      expect(renderedOrder()).toEqual(expectedOrder);
      await first.click();
      expect(onOpenThread).toHaveBeenCalledWith(running.id);
      await mounted.getByRole("button", { name: "Toggle activity list" }).click();
      await mounted.getByRole("button", { name: "Snoozed", exact: true }).click();
      await expect.element(mounted.getByTestId(`activity-thread-${snoozed.id}`)).toBeVisible();
      await expect.element(mounted.getByText(/^Returns /)).toBeVisible();
      await mounted.getByTestId(`activity-thread-${snoozed.id}`).hover();
      await mounted.getByRole("button", { name: "Return now", exact: true }).click();
      expect(onReturnSnoozedThread).toHaveBeenCalledWith(snoozed.id);
    } finally {
      await mounted.unmount();
      useComposerDraftStore.getState().setPrompt(draft.id, "");
    }
  }, 20_000);

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
