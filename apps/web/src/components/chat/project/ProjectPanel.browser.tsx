// FILE: ProjectPanel.browser.tsx
// Purpose: Covers the Group panel's configured state end to end — configuring
//          through the settings dialog while the panel is open flips the panel
//          into the configured layout, loads tasks/threads, and later opens the
//          dialog in edit mode.
// Layer: Chat UI browser tests
// Depends on: ProjectPanel plus GroupSettingsDialog with a stubbed nativeApi.

import "~/index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectAgentConfig, ProjectId, ThreadId } from "@synara/contracts";
import type { ProjectAgentOverview, ProjectAgentStreamEvent } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

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
