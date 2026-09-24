// FILE: ProjectPanel.browser.tsx
// Purpose: Covers the Group panel's configured state end to end — configuring
//          through the settings dialog while the panel is open flips the panel
//          into the configured layout, loads tasks/threads, and later opens the
//          dialog in edit mode.
// Layer: Chat UI browser tests
// Depends on: ProjectPanel plus GroupSettingsDialog with a stubbed nativeApi.

import "~/index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectAgentConfig, ProjectId, ThreadId, TurnId } from "@synara/contracts";
import type { ProjectAgentOverview, ProjectAgentStreamEvent } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SidebarThreadSummary } from "~/types";

const PROJECT_ID = ProjectId.makeUnsafe("project-group-1");

const harness = vi.hoisted(() => {
  const projectAgentListeners = new Set<(event: unknown) => void>();
  const automationListeners = new Set<(event: unknown) => void>();
  const api = {
    projectAgent: {
      getOverview: vi.fn(),
      listSummaries: vi.fn(async () => ({ summaries: [] })),
      listTasks: vi.fn(async () => ({ tasks: [] })),
      listActivity: vi.fn(async () => ({ activity: [], nextCursor: null })),
      listDocuments: vi.fn(async () => ({ documents: [] })),
      listThreadIndex: vi.fn(async () => ({ threads: [] })),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      onEvent: vi.fn((listener: (event: unknown) => void) => {
        projectAgentListeners.add(listener);
        return () => {
          projectAgentListeners.delete(listener);
        };
      }),
      configure: vi.fn(),
      readDocument: vi.fn(async () => ({
        head: {
          projectId: "project-group-1",
          logicalPath: "instructions.md",
          revision: 1,
          contentHash: "h",
          diskHash: "h",
          conflictPending: false,
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        document: { logicalPath: "instructions.md", content: "", revision: 1 },
        history: [],
      })),
      writeDocument: vi.fn(async (input: { logicalPath: string; content: string }) => ({
        logicalPath: input.logicalPath,
        content: input.content,
        revision: 2,
      })),
      linkProject: vi.fn(),
      unlinkProject: vi.fn(),
    },
    automation: {
      list: vi.fn(async () => ({ definitions: [], runs: [] })),
      onEvent: vi.fn((listener: (event: unknown) => void) => {
        automationListeners.add(listener);
        return () => {
          automationListeners.delete(listener);
        };
      }),
    },
    orchestration: { dispatchCommand: vi.fn(async () => ({ sequence: 1 })) },
    server: { getConfig: vi.fn(async () => ({ cwd: "/srv" })) },
    provider: { listModels: vi.fn(async () => ({ models: [], source: "disabled" })) },
    contextMenu: { show: vi.fn(async () => null) },
    git: {},
    shell: {},
  };
  return { api, projectAgentListeners };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
}));

vi.mock("~/components/PluginLibrary", () => ({
  PluginLibrary: () => <div data-testid="plugin-library-stub">PluginLibrary stub</div>,
}));

import { makeProject } from "~/storeTestFixtures";
import { useStore } from "~/store";
import { useProjectAgentSummariesStore } from "./useProjectAgentSummaries";

import { GroupPanelSectionBar } from "./GroupOverview";
import { GROUP_PANEL_SECTIONS } from "./groupPanelSections";
import { ProjectPanel } from "./ProjectPanel";

function overview(overrides: Partial<ProjectAgentOverview> = {}): ProjectAgentOverview {
  return {
    projectId: PROJECT_ID,
    configured: true,
    config: configPayload(),
    goal: null,
    digest: null,
    linkedProjectIds: [],
    blockers: [],
    recentOutcomes: [],
    coordinatorStatus: "idle",
    ...overrides,
  } as ProjectAgentOverview;
}

function configPayload(projectId: ProjectId = PROJECT_ID): ProjectAgentConfig {
  return ProjectAgentConfig.makeUnsafe({
    projectId,
    coordinatorThreadId: ThreadId.makeUnsafe("thread-coordinator"),
    coordinatorName: "alpha Coordinator",
    coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
    limits: {
      maxConcurrentWorkers: 4,
      maxNewWorkersPerTurn: 2,
      maxWorkerCreationsPerGoal: 12,
      maxAutomaticContinuationsPerGoal: 2,
      maxRepairRoundsPerTask: 2,
    },
    captureEnabled: true,
    enabled: true,
    automationId: null,
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    disabledAt: null,
  });
}

function emitProjectAgentEvent(event: ProjectAgentStreamEvent) {
  harness.projectAgentListeners.forEach((listener) => listener(event));
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectPanel
        open
        variant="docked"
        projectId={PROJECT_ID}
        projectName="alpha"
        workspacePath="/tmp/group"
        defaultModelSelection={{ provider: "codex", model: "gpt-5-codex" }}
        onOpenCoordinator={vi.fn()}
        onOpenThread={vi.fn()}
        onOpenThreadSplit={vi.fn()}
        onOpenAutomation={vi.fn()}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("ProjectPanel configured state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.projectAgentListeners.clear();
    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: false, config: null, coordinatorStatus: "unconfigured" }),
    );
    useStore.setState({
      projects: [makeProject({ id: PROJECT_ID, kind: "group", name: "alpha", cwd: "/tmp/group" })],
      sidebarThreadSummaryById: {},
      threadIds: [],
    });
    useProjectAgentSummariesStore.setState({
      summariesByProjectId: new Map(),
      loaded: false,
    });
  });

  it("shows the configured state after the dialog saves while the panel is open", async () => {
    const saved = overview();
    harness.api.projectAgent.configure.mockImplementation(async () => {
      // The server pushes config-upserted alongside the mutation response; once
      // it accepts the write, getOverview reports the configured overview.
      harness.api.projectAgent.getOverview.mockResolvedValue(saved);
      emitProjectAgentEvent({ type: "config-upserted", config: saved.config! });
      return saved;
    });
    await renderPanel();

    await expect
      .element(page.getByRole("button", { name: "Set up coordinator" }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Set up coordinator" }).click();
    await expect.element(page.getByText("Set up your group")).toBeInTheDocument();

    await page.getByRole("button", { name: "Create group" }).click();
    await vi.waitFor(() => expect(harness.api.projectAgent.configure).toHaveBeenCalledOnce());

    // The panel flips into the configured layout and loads the lists behind it.
    await vi.waitFor(() => {
      expect(harness.api.projectAgent.listTasks).toHaveBeenCalled();
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalled();
    });
    await expect.element(page.getByText("Groups", { exact: true })).toBeInTheDocument();
    // The coordinator row is a single model line: the group name (default
    // coordinator name resolves to it) opens the coordinator thread.
    await expect.element(page.getByRole("button", { name: "Open alpha" })).toBeInTheDocument();
    // The settings dialog closed on save; the edit-mode affordance is up.
    await expect.element(page.getByText("Set up your group")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Group settings" })).toBeInTheDocument();

    // The panel's stream outlives the dialog's subscription — a later task
    // upsert still reaches it and re-lists the thread index.
    const threadIndexCalls = harness.api.projectAgent.listThreadIndex.mock.calls.length;
    emitProjectAgentEvent({
      type: "task-upserted",
      task: {
        id: "task-1",
        projectId: PROJECT_ID,
        goalId: "goal-1",
        title: "write tests",
        description: null,
        acceptanceCriteria: null,
        status: "running",
        dependsOnTaskIds: [],
        assignedThreadId: "thread-worker-1",
        repairCount: 0,
        archivedAt: null,
        revision: 1,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      } as never,
    });
    await vi.waitFor(() =>
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalledTimes(threadIndexCalls + 1),
    );

    // Reopening settings is edit mode — the title is the group name, not onboarding.
    await page.getByRole("button", { name: "Group settings" }).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("General"));
    expect(document.body.textContent).toContain("alpha");
    expect(document.body.textContent).not.toContain("Set up your group");
  });
});

const COORDINATOR_THREAD_ID = ThreadId.makeUnsafe("thread-coordinator");

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeThreadSummary(
  id: ThreadId,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id,
    projectId: PROJECT_ID,
    title: "Worker thread",
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(5),
    latestUserMessageAt: null,
    archivedAt: null,
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasLiveTailWork: false,
    ...overrides,
  } as unknown as SidebarThreadSummary;
}

function runningSession(): NonNullable<SidebarThreadSummary["session"]> {
  return {
    provider: "codex",
    status: "running",
    orchestrationStatus: "running",
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(1),
  } as NonNullable<SidebarThreadSummary["session"]>;
}

function runningTurn(): NonNullable<SidebarThreadSummary["latestTurn"]> {
  return {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "running",
    requestedAt: minutesAgo(10),
    startedAt: minutesAgo(10),
    completedAt: null,
    assistantMessageId: null,
  };
}

function threadIndexEntries(ids: readonly ThreadId[]) {
  return {
    threads: ids.map((threadId) => ({
      projectId: PROJECT_ID,
      threadId,
      excluded: false,
      archived: false,
      summaryStatus: "skipped",
      lastUpdatedAt: null,
      lastSummarizedAt: null,
    })),
  } as unknown as Awaited<ReturnType<typeof harness.api.projectAgent.listThreadIndex>>;
}

function setSidebarSummaries(summaries: readonly SidebarThreadSummary[]) {
  useStore.setState({
    sidebarThreadSummaryById: Object.fromEntries(summaries.map((summary) => [summary.id, summary])),
    threadIds: summaries.map((summary) => summary.id),
  });
}

describe("ProjectPanel polished sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.projectAgentListeners.clear();
    harness.api.projectAgent.getOverview.mockResolvedValue(overview());
    harness.api.projectAgent.listThreadIndex.mockResolvedValue(threadIndexEntries([]));
    useStore.setState({
      projects: [makeProject({ id: PROJECT_ID, kind: "group", name: "alpha", cwd: "/tmp/group" })],
      sidebarThreadSummaryById: {},
      threadIds: [],
    });
    useProjectAgentSummariesStore.setState({
      summariesByProjectId: new Map(),
      loaded: false,
    });
  });

  it("keeps every section-bar button inside the bar from 260px up", async () => {
    for (const width of [260, 290, 360]) {
      const { container, unmount } = await render(
        <div style={{ width: `${width}px` }} data-testid={`bar-${width}`}>
          <GroupPanelSectionBar
            sections={GROUP_PANEL_SECTIONS}
            sectionCounts={{
              threads: { count: 12, waiting: 2 },
              "pull-requests": { count: 3, waiting: 0 },
              automations: { count: 1, waiting: 0 },
              context: { count: 3, waiting: 0 },
            }}
            openSectionId="threads"
            regionId="sections-region"
            onToggle={() => {}}
          />
        </div>,
      );
      const bar = container.querySelector<HTMLElement>("[data-testid^=bar-] > div");
      expect(bar).not.toBeNull();
      const barRect = bar!.getBoundingClientRect();
      const buttons = Array.from(bar!.querySelectorAll("button"));
      expect(buttons).toHaveLength(4);
      let previousRight = barRect.left - 0.5;
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        expect(rect.left + 0.5).toBeGreaterThanOrEqual(previousRight);
        expect(rect.right).toBeLessThanOrEqual(barRect.right + 0.5);
        previousRight = rect.right;
      }
      // Corner badges hang off the icon but must stay inside the bar.
      for (const badge of Array.from(bar!.querySelectorAll("span.absolute"))) {
        const rect = badge.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(barRect.left - 0.5);
        expect(rect.right).toBeLessThanOrEqual(barRect.right + 0.5);
      }
      expect(bar!.scrollWidth).toBeLessThanOrEqual(bar!.clientWidth + 1);
      // The open section keeps its label under the icon; others are reserved
      // (invisible) so the bar height stays fixed.
      const labels = buttons.map((button) =>
        button.querySelector<HTMLElement>(":scope > span:last-child"),
      );
      expect(labels[0]?.classList.contains("invisible")).toBe(false);
      expect(labels[1]?.classList.contains("invisible")).toBe(true);
      await unmount();
    }
  });

  it("lists every group thread by state in the Threads section, not an empty state", async () => {
    const idleOne = makeThreadSummary(ThreadId.makeUnsafe("thread-idle-1"), {
      title: "Idle one",
    });
    const idleTwo = makeThreadSummary(ThreadId.makeUnsafe("thread-idle-2"), {
      title: "Idle two",
    });
    const waiting = makeThreadSummary(ThreadId.makeUnsafe("thread-waiting"), {
      title: "Needs you",
      hasPendingApprovals: true,
    });
    harness.api.projectAgent.listThreadIndex.mockResolvedValue(
      threadIndexEntries([idleOne.id, idleTwo.id, waiting.id]),
    );
    setSidebarSummaries([idleOne, idleTwo, waiting]);
    await renderPanel();

    await page.getByRole("button", { name: /^Threads/ }).click();

    await expect.element(page.getByText("Idle", { exact: true })).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Idle one");
      expect(document.body.textContent).toContain("Idle two");
      expect(document.body.textContent).toContain("Needs you");
    });
    expect(document.body.textContent).not.toContain("No threads in progress or waiting on you.");
    // The body holds Focus only — the Threads section owns the full list.
    expect(document.body.textContent).not.toContain("Other threads");
  });

  it("renders the coordinator model line without repeating the provider name", async () => {
    harness.api.projectAgent.getOverview.mockResolvedValue(
      overview({
        config: {
          ...configPayload(),
          coordinatorModelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-5-5",
            options: { effort: "medium" },
          },
        },
      }),
    );
    await renderPanel();

    const modelButton = await vi.waitFor(() => {
      const found = Array.from(document.querySelectorAll("button")).find((button) =>
        button.getAttribute("aria-label")?.startsWith("Open "),
      );
      expect(found).not.toBeUndefined();
      return found!;
    });
    const text = modelButton.textContent ?? "";
    expect(text).toContain("Claude Opus 5.5");
    expect(text).toContain("Medium");
    expect(text).not.toContain("Claude ·");
  });

  it("shows the activity sparkline once a thread works and hides it while none ever did", async () => {
    // Only idle threads exist → nothing has ever worked → no sparkline.
    const idle = makeThreadSummary(ThreadId.makeUnsafe("thread-idle-1"), { title: "Idle" });
    const idleTwo = makeThreadSummary(ThreadId.makeUnsafe("thread-idle-2"), { title: "Idle two" });
    const coordinator = makeThreadSummary(COORDINATOR_THREAD_ID, { title: "alpha Coordinator" });
    harness.api.projectAgent.listThreadIndex.mockResolvedValue(
      threadIndexEntries([idle.id, idleTwo.id]),
    );
    setSidebarSummaries([idle, idleTwo, coordinator]);
    await renderPanel();

    // Wait for the configured layout before asserting absence — the model line
    // is what the sparkline would sit above.
    await vi.waitFor(() => {
      expect(
        Array.from(document.querySelectorAll("button")).some((button) =>
          button.getAttribute("aria-label")?.startsWith("Open "),
        ),
      ).toBe(true);
    });
    expect(document.querySelector('[role="img"][aria-label*="working now"]')).toBeNull();

    // A thread starts working → the sparkline appears with the live count.
    setSidebarSummaries([
      makeThreadSummary(idle.id, {
        title: "Idle",
        session: runningSession(),
        latestTurn: runningTurn(),
      }),
      idleTwo,
      coordinator,
    ]);
    await vi.waitFor(() => {
      const sparkline = document.querySelector<HTMLElement>(
        '[role="img"][aria-label*="working now"]',
      );
      expect(sparkline).not.toBeNull();
      expect(sparkline!.getAttribute("aria-label")).toContain("1 thread working now");
      expect(sparkline!.getAttribute("aria-label")).toContain("peak 1 in the last hour");
    });

    // A second member thread starts → the count updates without extra polling.
    setSidebarSummaries([
      makeThreadSummary(idle.id, {
        title: "Idle",
        session: runningSession(),
        latestTurn: runningTurn(),
      }),
      makeThreadSummary(idleTwo.id, {
        title: "Idle two",
        session: runningSession(),
        latestTurn: { ...runningTurn(), turnId: TurnId.makeUnsafe("turn-2") },
      }),
      coordinator,
    ]);
    await vi.waitFor(() => {
      const sparkline = document.querySelector<HTMLElement>(
        '[role="img"][aria-label*="working now"]',
      );
      expect(sparkline!.getAttribute("aria-label")).toContain("2 threads working now");
      expect(sparkline!.getAttribute("aria-label")).toContain("peak 2 in the last hour");
    });
  });
});
