import { describe, expect, it } from "vitest";

import {
  buildProjectThreadTree,
  deriveSidebarProjectData,
  describeAddProjectError,
  extractDuplicateProjectCreateProjectId,
  findWorkspaceRootMatch,
  getFallbackThreadIdAfterDelete,
  getVisibleSidebarEntriesForPreview,
  getPinnedThreadsForSidebar,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdForJumpCommand,
  getSidebarThreadIdsToPrewarm,
  getRenderedThreadsForSidebarProject,
  groupSidebarThreadsByProjectId,
  getUnpinnedThreadsForSidebar,
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  isDuplicateProjectCreateError,
  pruneExpandedProjectThreadListsForCollapsedProjects,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type SidebarThreadSummary,
  type Thread,
} from "../types";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        proposedPlans: [],
        session: null,
      }),
    ).toBe(true);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("pruneExpandedProjectThreadListsForCollapsedProjects", () => {
  it("clears remembered show-more state when a project is collapsed", () => {
    const current = new Set(["/Users/tester/Code/one", "/Users/tester/Code/two"]);

    const next = pruneExpandedProjectThreadListsForCollapsedProjects({
      expandedProjectThreadListCwds: current,
      projects: [
        { cwd: "/Users/tester/Code/one", expanded: false },
        { cwd: "/Users/tester/Code/two", expanded: true },
      ],
      normalizeProjectCwd: (cwd) => cwd.replace(/\/+$/, ""),
    });

    expect([...next]).toEqual(["/Users/tester/Code/two"]);
  });

  it("preserves the existing set when no collapsed project needs pruning", () => {
    const current = new Set(["/Users/tester/Code/one"]);

    const next = pruneExpandedProjectThreadListsForCollapsedProjects({
      expandedProjectThreadListCwds: current,
      projects: [{ cwd: "/Users/tester/Code/one", expanded: true }],
      normalizeProjectCwd: (cwd) => cwd.replace(/\/+$/, ""),
    });

    expect(next).toBe(current);
  });
});

describe("add-project error helpers", () => {
  it("finds an existing project by workspace root", () => {
    expect(
      findWorkspaceRootMatch(
        [
          { id: "project-1", cwd: "/Users/tester/Code/one" },
          { id: "project-2", cwd: "/Users/tester/Code/two" },
        ],
        "/Users/tester/Code/two/",
        (project) => project.cwd,
      )?.id,
    ).toBe("project-2");
  });

  it("detects duplicate project.create errors", () => {
    expect(
      isDuplicateProjectCreateError(
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root 'C:\\Labs\\influenzo'.",
      ),
    ).toBe(true);
  });

  it("extracts the existing project id from duplicate project.create errors", () => {
    expect(
      extractDuplicateProjectCreateProjectId(
        "Orchestration command invariant failed (project.create): Project 'project-123' already uses workspace root '/Users/tester/Code/one'.",
      ),
    ).toBe("project-123");
  });

  it("does not classify unrelated errors as duplicate project.create failures", () => {
    expect(
      isDuplicateProjectCreateError("Project directory does not exist: C:\\Labs\\influenzo"),
    ).toBe(false);
  });

  it("returns null when extracting from unrelated add-project errors", () => {
    expect(
      extractDuplicateProjectCreateProjectId(
        "Project directory does not exist: C:\\Labs\\influenzo",
      ),
    ).toBeNull();
  });

  it("adds a readable explanation for duplicate workspace-root errors", () => {
    expect(
      describeAddProjectError(
        "Orchestration command invariant failed (project.create): Project 'project-duplicate' already uses workspace root 'C:\\Labs\\influenzo'.",
      ),
    ).toContain("already linked to an existing project");
  });

  it("returns no explanation for unrelated add-project errors", () => {
    expect(describeAddProjectError("Project directory does not exist: C:\\Labs\\influenzo")).toBe(
      null,
    );
  });
});

describe("pin helpers", () => {
  const makeThread = (id: string): Thread =>
    ({
      id: id as ThreadId,
      codexThreadId: null,
      projectId: "project-1" as ProjectId,
      title: id,
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      session: null,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-09T10:00:00.000Z",
      latestTurn: null,
      turnDiffSummaries: [],
      activities: [],
      branch: null,
      worktreePath: null,
    }) satisfies Thread;

  it("returns pinned threads in persisted pin order", () => {
    const threads = [makeThread("thread-1"), makeThread("thread-2"), makeThread("thread-3")];

    expect(
      getPinnedThreadsForSidebar(threads, ["thread-3" as ThreadId, "thread-1" as ThreadId]),
    ).toEqual([threads[2], threads[0]]);
  });

  it("filters pinned threads out of project lists", () => {
    const threads = [makeThread("thread-1"), makeThread("thread-2"), makeThread("thread-3")];

    expect(
      getUnpinnedThreadsForSidebar(threads, ["thread-2" as ThreadId, "thread-3" as ThreadId]),
    ).toEqual([threads[0]]);
  });

  it("waits for thread hydration before pruning persisted pins", () => {
    expect(shouldPrunePinnedThreads({ threadsHydrated: false })).toBe(false);
    expect(shouldPrunePinnedThreads({ threadsHydrated: true })).toBe(true);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    dismissedStatusKey: undefined,
    proposedPlans: [],
    hasLiveTailWork: false,
    updatedAt: "2026-03-09T10:05:00.000Z",
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("keeps showing working when late turn activity arrives after the session looks ready", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasLiveTailWork: true,
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
              implementedAt: null,
              implementationThreadId: null,
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not show plan ready after the proposed plan was implemented elsewhere", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
              implementedAt: "2026-03-09T10:06:00.000Z",
              implementationThreadId: "thread-implement" as never,
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("hides a dismissible status when its dismissal key matches", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          dismissedStatusKey:
            "Plan Ready:2026-03-09T10:05:00.000Z:turn-1:2026-03-09T10:05:00.000Z:2026-03-09T10:00:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadRowClassName", () => {
  it("keeps selected active rows on the selected sidebar background", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-[var(--color-background-button-secondary)]");
    expect(className).toContain("hover:bg-[var(--color-background-button-secondary)]");
    expect(className).toContain("text-[var(--color-text-foreground)]");
    expect(className).not.toContain("hover:bg-[var(--color-background-button-secondary-hover)]");
  });

  it("keeps selected rows visually stable on hover", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-[var(--color-background-elevated-secondary)]");
    expect(className).toContain("hover:bg-[var(--color-background-elevated-secondary)]");
    expect(className).toContain("text-[var(--color-text-foreground)]");
    expect(className).not.toContain("hover:bg-[var(--color-background-button-secondary-hover)]");
  });

  it("uses the selected sidebar background for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-[var(--color-background-button-secondary)]");
    expect(className).toContain("hover:bg-[var(--color-background-button-secondary)]");
  });

  it("matches hover-only rows to the selected active background", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: false });
    expect(className).toContain("hover:bg-[var(--color-background-button-secondary)]");
    expect(className).not.toContain("hover:bg-[var(--color-background-button-secondary-hover)]");
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-8"),
    ]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
  });
});

describe("getRenderedThreadsForSidebarProject", () => {
  it("pins only the active thread when the parent project is collapsed", () => {
    const threads = Array.from({ length: 4 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getRenderedThreadsForSidebarProject({
      project: makeProject({ expanded: false }),
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-4"),
      isThreadListExpanded: false,
      previewLimit: 2,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.renderedThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });
});

describe("buildProjectThreadTree", () => {
  it("keeps child threads hidden until their parent is expanded", () => {
    const rows = buildProjectThreadTree({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        thread: expect.objectContaining({ id: ThreadId.makeUnsafe("thread-parent") }),
        depth: 0,
        childCount: 1,
        isExpanded: false,
      }),
    ]);
  });

  it("auto-reveals the selected child thread by expanding its ancestors", () => {
    const rows = buildProjectThreadTree({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-grandchild"),
          parentThreadId: ThreadId.makeUnsafe("thread-child"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      forceVisibleThreadId: ThreadId.makeUnsafe("thread-grandchild"),
    });

    expect(rows.map((row) => [row.thread.id, row.depth, row.isExpanded])).toEqual([
      [ThreadId.makeUnsafe("thread-parent"), 0, true],
      [ThreadId.makeUnsafe("thread-child"), 1, true],
      [ThreadId.makeUnsafe("thread-grandchild"), 2, false],
    ]);
  });
});

describe("getVisibleSidebarEntriesForPreview", () => {
  it("caps project preview by root rows, not flattened child rows", () => {
    const visibleEntries = getVisibleSidebarEntriesForPreview({
      entries: [
        {
          rowId: ThreadId.makeUnsafe("thread-parent"),
          rootRowId: ThreadId.makeUnsafe("thread-parent"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-child"),
          rootRowId: ThreadId.makeUnsafe("thread-parent"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-second-root"),
          rootRowId: ThreadId.makeUnsafe("thread-second-root"),
        },
        {
          rowId: ThreadId.makeUnsafe("thread-third-root"),
          rootRowId: ThreadId.makeUnsafe("thread-third-root"),
        },
      ],
      activeEntryId: undefined,
      isExpanded: false,
      previewLimit: 2,
    }).visibleEntries;

    expect(visibleEntries.map((entry) => entry.rowId)).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
      ThreadId.makeUnsafe("thread-second-root"),
    ]);
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("flattens only the sidebar-visible threads in render order", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-1"), expanded: true }),
      makeProject({ id: ProjectId.makeUnsafe("project-2"), expanded: false }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ProjectId.makeUnsafe("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-3"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:03:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-4"),
        projectId: ProjectId.makeUnsafe("project-2"),
        createdAt: "2026-03-09T10:04:00.000Z",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-5"),
        projectId: ProjectId.makeUnsafe("project-2"),
        createdAt: "2026-03-09T10:05:00.000Z",
      }),
    ];

    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects,
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-4"),
      expandedThreadListsByProject: new Set<ProjectId>([ProjectId.makeUnsafe("project-1")]),
      previewLimit: 2,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });

  it("reveals selected subagent children even when only the parent is expanded implicitly", () => {
    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects: [makeProject({ id: ProjectId.makeUnsafe("project-1"), expanded: true })],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          projectId: ProjectId.makeUnsafe("project-1"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      activeThreadId: ThreadId.makeUnsafe("thread-child"),
      expandedThreadListsByProject: new Set<ProjectId>([ProjectId.makeUnsafe("project-1")]),
      expandedSubagentParentIds: new Set<ThreadId>([ThreadId.makeUnsafe("thread-parent")]),
      previewLimit: 6,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-child"),
      ThreadId.makeUnsafe("thread-other"),
    ]);
  });

  it("respects manual subagent collapse even when a child thread is active", () => {
    const visibleThreadIds = getVisibleSidebarThreadIds({
      projects: [makeProject({ id: ProjectId.makeUnsafe("project-1"), expanded: true })],
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-parent"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:03:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-child"),
          projectId: ProjectId.makeUnsafe("project-1"),
          parentThreadId: ThreadId.makeUnsafe("thread-parent"),
          createdAt: "2026-03-09T10:02:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:01:00.000Z",
        }),
      ],
      activeThreadId: ThreadId.makeUnsafe("thread-child"),
      expandedThreadListsByProject: new Set<ProjectId>([ProjectId.makeUnsafe("project-1")]),
      expandedSubagentParentIds: new Set<ThreadId>(),
      previewLimit: 6,
      threadSortOrder: "created_at",
    });

    expect(visibleThreadIds).toEqual([
      ThreadId.makeUnsafe("thread-parent"),
      ThreadId.makeUnsafe("thread-other"),
    ]);
  });
});

describe("getNextVisibleSidebarThreadId", () => {
  const visibleThreadIds = [
    ThreadId.makeUnsafe("thread-1"),
    ThreadId.makeUnsafe("thread-2"),
    ThreadId.makeUnsafe("thread-3"),
  ];

  it("advances to the next visible thread and wraps at the end", () => {
    expect(
      getNextVisibleSidebarThreadId({
        visibleThreadIds,
        activeThreadId: ThreadId.makeUnsafe("thread-3"),
        direction: "forward",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-1"));
  });

  it("moves backward through the visible list and wraps at the start", () => {
    expect(
      getNextVisibleSidebarThreadId({
        visibleThreadIds,
        activeThreadId: ThreadId.makeUnsafe("thread-1"),
        direction: "backward",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-3"));
  });
});

describe("getSidebarThreadIdForJumpCommand", () => {
  const visibleThreadIds = [
    ThreadId.makeUnsafe("thread-1"),
    ThreadId.makeUnsafe("thread-2"),
    ThreadId.makeUnsafe("thread-3"),
  ];

  it("resolves numbered jump commands against the visible sidebar order", () => {
    expect(
      getSidebarThreadIdForJumpCommand({
        visibleThreadIds,
        command: "thread.jump.2",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-2"));
  });

  it("returns null when a jump command points past the visible rows", () => {
    expect(
      getSidebarThreadIdForJumpCommand({
        visibleThreadIds,
        command: "thread.jump.9",
      }),
    ).toBeNull();
  });
});

describe("getSidebarThreadIdsToPrewarm", () => {
  it("returns the first visible sidebar rows up to the requested limit", () => {
    expect(
      getSidebarThreadIdsToPrewarm({
        visibleThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
        ],
        limit: 2,
      }),
    ).toEqual([ThreadId.makeUnsafe("thread-1"), ThreadId.makeUnsafe("thread-2")]);
  });

  it("prioritizes the active thread neighborhood before filling the limit", () => {
    expect(
      getSidebarThreadIdsToPrewarm({
        visibleThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
          ThreadId.makeUnsafe("thread-4"),
          ThreadId.makeUnsafe("thread-5"),
          ThreadId.makeUnsafe("thread-6"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-5"),
        limit: 5,
        neighborRadius: 1,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.makeUnsafe("project-1"),
    kind: "project",
    name: "Project",
    remoteName: "Project",
    folderName: "project",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    expanded: true,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

describe("deriveSidebarProjectData", () => {
  it("shows split member threads as normal project rows", () => {
    const project = makeProject();
    const sourceThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-source"),
      title: "Source",
    });
    const droppedThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-dropped"),
      title: "Dropped",
      createdAt: "2026-03-09T10:05:00.000Z",
      updatedAt: "2026-03-09T10:05:00.000Z",
    });
    const standaloneThread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-standalone"),
      title: "Standalone",
      createdAt: "2026-03-09T10:10:00.000Z",
      updatedAt: "2026-03-09T10:10:00.000Z",
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([
        sourceThread,
        droppedThread,
        standaloneThread,
      ]),
      pinnedThreadIds: [],
      expandedParentThreadIds: new Set(),
      expandedThreadListProjectCwds: new Set(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
    });

    expect(data.get(project.id)?.visibleEntries).toEqual([
      expect.objectContaining({ kind: "thread", rowId: sourceThread.id }),
      expect.objectContaining({ kind: "thread", rowId: droppedThread.id }),
      expect.objectContaining({ kind: "thread", rowId: standaloneThread.id }),
    ]);
  });

  it("keeps the active thread visible when its project is collapsed", () => {
    const project = makeProject({ expanded: false });
    const threadOne = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-1"),
      title: "One",
    });
    const threadTwo = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-2"),
      title: "Two",
      createdAt: "2026-03-09T10:01:00.000Z",
      updatedAt: "2026-03-09T10:01:00.000Z",
    });
    const threadThree = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-3"),
      title: "Three",
      createdAt: "2026-03-09T10:02:00.000Z",
      updatedAt: "2026-03-09T10:02:00.000Z",
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([
        threadOne,
        threadTwo,
        threadThree,
      ]),
      pinnedThreadIds: [],
      expandedParentThreadIds: new Set(),
      expandedThreadListProjectCwds: new Set(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: threadThree.id,
      previewLimit: 1,
    });

    expect(data.get(project.id)).toMatchObject({
      activeEntryId: threadThree.id,
      visibleEntries: [
        expect.objectContaining({
          kind: "thread",
          rowId: threadThree.id,
        }),
      ],
    });
  });

  it("uses the provided thread-status resolver for project status", () => {
    const project = makeProject();
    const threadOne = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-1"),
      title: "One",
      hasPendingApprovals: true,
    });

    const data = deriveSidebarProjectData({
      projects: [project],
      sortedSidebarThreadsByProjectId: groupSidebarThreadsByProjectId([threadOne]),
      pinnedThreadIds: [],
      expandedParentThreadIds: new Set(),
      expandedThreadListProjectCwds: new Set(),
      normalizeProjectCwd: (cwd) => cwd,
      activeSidebarThreadId: undefined,
      previewLimit: 5,
      resolveThreadStatus: () => null,
    });

    expect(data.get(project.id)?.projectStatus).toBeNull();
  });
});

describe("sortThreadsForSidebar", () => {
  it("sorts threads by the latest user message in recency mode", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-09T10:01:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:01:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [
            {
              id: "message-2" as never,
              role: "user",
              text: "newer",
              createdAt: "2026-03-09T10:06:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:06:00.000Z",
            },
          ],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("falls back to thread timestamps when there is no user message", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "assistant only",
              createdAt: "2026-03-09T10:02:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:02:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("falls back to id ordering when threads have no sortable timestamps", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("can sort threads by createdAt when configured", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "created_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });
});

describe("getFallbackThreadIdAfterDelete", () => {
  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-oldest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other-project"),
          projectId: ProjectId.makeUnsafe("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-next"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      deletedThreadIds: new Set([
        ThreadId.makeUnsafe("thread-active"),
        ThreadId.makeUnsafe("thread-newest"),
      ]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-next"));
  });
});

describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-1"), name: "Older project" }),
      makeProject({ id: ProjectId.makeUnsafe("project-2"), name: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.makeUnsafe("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            createdAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:01:00.000Z",
          },
        ],
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            createdAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:05:00.000Z",
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Beta",
          createdAt: undefined,
          updatedAt: undefined,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Alpha",
          createdAt: undefined,
          updatedAt: undefined,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-2"), name: "Second" }),
      makeProject({ id: ProjectId.makeUnsafe("project-1"), name: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});
