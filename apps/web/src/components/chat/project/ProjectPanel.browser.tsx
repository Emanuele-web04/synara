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
import type {
  ProjectAgentOverview,
  ProjectAgentStreamEvent,
  ProjectAgentSummary,
} from "@synara/contracts";
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
      listSummaries: vi.fn(async () => ({ summaries: [] as ProjectAgentSummary[] })),
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
    await expect.element(page.getByText("Set up your hub")).toBeInTheDocument();

    await page.getByRole("button", { name: "Create hub" }).click();
    await vi.waitFor(() => expect(harness.api.projectAgent.configure).toHaveBeenCalledOnce());

    // The panel flips into the configured layout and loads the lists behind it.
    await vi.waitFor(() => {
      expect(harness.api.projectAgent.listTasks).toHaveBeenCalled();
      expect(harness.api.projectAgent.listThreadIndex).toHaveBeenCalled();
    });
    await expect.element(page.getByText("Hubs", { exact: true })).toBeInTheDocument();
    // The coordinator row is a single model line: the group name (default
    // coordinator name resolves to it) opens the coordinator thread.
    await expect.element(page.getByRole("button", { name: "Open alpha" })).toBeInTheDocument();
    // The settings dialog closed on save; the edit-mode affordance is up.
    await expect.element(page.getByText("Set up your hub")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Hub settings" })).toBeInTheDocument();

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
    await page.getByRole("button", { name: "Hub settings" }).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("General"));
    expect(document.body.textContent).toContain("alpha");
    expect(document.body.textContent).not.toContain("Set up your hub");
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

  it("shows secondary sections as rows with a plain count that open in place", async () => {
    await renderPanel();

    const contextRow = await vi.waitFor(() => {
      const found = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("Context"),
      );
      expect(found).not.toBeUndefined();
      return found!;
    });
    // Counts sit in the row as text, never as a badge pinned over an icon.
    expect(contextRow.textContent).toMatch(/^Context\d+$/);
    expect(document.querySelector("[data-environment-panel-variant] span.absolute")).toBeNull();
    expect(contextRow.getAttribute("aria-expanded")).toBe("false");
    const tileFill = getComputedStyle(contextRow.parentElement!.parentElement!).backgroundColor;
    await page.getByRole("button", { name: /^Context/ }).hover();
    await expect
      .poll(() => {
        const rowFill = getComputedStyle(contextRow).backgroundColor;
        return (
          contextRow.getAnimations().length === 0 &&
          rowFill !== "rgba(0, 0, 0, 0)" &&
          rowFill !== tileFill
        );
      })
      .toBe(true);

    await page.getByRole("button", { name: /^Context/ }).click();
    expect(contextRow.getAttribute("aria-expanded")).toBe("true");
    await expect.element(page.getByRole("region", { name: "Context" })).toBeInTheDocument();
    // One section open at a time: opening Automations closes Context.
    await page.getByRole("button", { name: /^Automations/ }).click();
    expect(contextRow.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists every hub thread by state in the Threads section, not an empty state", async () => {
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

    // Threads is always shown: the list needs no click.
    await expect.element(page.getByText("Idle", { exact: true })).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Idle one");
      expect(document.body.textContent).toContain("Idle two");
      expect(document.body.textContent).toContain("Needs you");
    });
    expect(document.body.textContent).not.toContain("No threads in progress or waiting on you.");
    expect(document.body.textContent).not.toContain("Other threads");
  });

  it("caps the panel at the overlay height and scrolls inside, keeping the bar pinned", async () => {
    // Enough idle threads that the open Threads section overflows the overlay.
    const threads = Array.from({ length: 60 }, (_, index) =>
      makeThreadSummary(ThreadId.makeUnsafe(`thread-cap-${index}`), { title: `Idle ${index}` }),
    );
    harness.api.projectAgent.listThreadIndex.mockResolvedValue(
      threadIndexEntries(threads.map((thread) => thread.id)),
    );
    setSidebarSummaries(threads);
    await renderPanel();

    const overlay = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-environment-panel-variant]");
      expect(found).not.toBeNull();
      return found!;
    });
    const surface = overlay.firstElementChild as HTMLElement;

    await vi.waitFor(() => expect(document.body.textContent).toContain("Idle 59"));
    // Let the disclosure's open animation settle before measuring.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 350));

    const overlayRect = overlay.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    // The panel grows with content but never past the overlay's inner height —
    // viewport minus the wrapper's top offset and bottom margin.
    expect(surfaceRect.height).toBeLessThanOrEqual(
      overlayRect.height -
        parseFloat(getComputedStyle(overlay).paddingTop) -
        parseFloat(getComputedStyle(overlay).paddingBottom) +
        1,
    );

    // The body scrolls inside; the header (title) stays pinned inside the
    // capped surface.
    const scrollBody = surface.querySelector<HTMLElement>("div.overflow-y-auto");
    expect(scrollBody).not.toBeNull();
    expect(scrollBody!.scrollHeight).toBeGreaterThan(scrollBody!.clientHeight);
    const title = Array.from(surface.querySelectorAll("p")).find(
      (el) => el.textContent === "Hubs",
    )!;
    const titleTopBefore = title.getBoundingClientRect().top;
    expect(titleTopBefore).toBeGreaterThanOrEqual(surfaceRect.top - 0.5);
    scrollBody!.scrollTop = scrollBody!.scrollHeight;
    await vi.waitFor(() => expect(scrollBody!.scrollTop).toBeGreaterThan(0));
    expect(Math.abs(title.getBoundingClientRect().top - titleTopBefore)).toBeLessThanOrEqual(1);
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
    expect(text).toContain("Coordinator");
    expect(text).toContain("Claude Opus 5.5");
    expect(text).toContain("Medium");
    expect(text).not.toContain("Claude ·");
  });

  it("always shows Threads by state, with live threads under Working and no activity chart", async () => {
    const idle = makeThreadSummary(ThreadId.makeUnsafe("thread-idle-1"), { title: "Idle one" });
    const coordinator = makeThreadSummary(COORDINATOR_THREAD_ID, { title: "alpha Coordinator" });
    harness.api.projectAgent.listThreadIndex.mockResolvedValue(
      threadIndexEntries([idle.id, ThreadId.makeUnsafe("thread-working")]),
    );
    setSidebarSummaries([
      idle,
      makeThreadSummary(ThreadId.makeUnsafe("thread-working"), {
        title: "Working one",
        session: runningSession(),
        latestTurn: runningTurn(),
      }),
      coordinator,
    ]);
    await renderPanel();

    await expect.element(page.getByText("Working", { exact: true })).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Working one");
      expect(document.body.textContent).toContain("Idle one");
    });
    expect(document.querySelector('[role="img"][aria-label*="working now"]')).toBeNull();
  });

  it("moves a worker into and out of Waiting on you from live summaries while its overview stays unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const worker = makeThreadSummary(ThreadId.makeUnsafe("worker-recovery"), {
      title: "Recover login",
    });
    harness.api.projectAgent.getOverview.mockResolvedValue(overview({ workers: [] }));
    harness.api.projectAgent.listThreadIndex.mockResolvedValue(threadIndexEntries([worker.id]));
    const initialSummary: ProjectAgentSummary = {
      projectId: PROJECT_ID,
      configured: true,
      coordinatorThreadId: COORDINATOR_THREAD_ID,
      coordinatorName: "alpha Coordinator",
      coordinatorIcon: null,
      coordinatorColor: null,
      coordinatorStatus: "idle",
      revision: 1,
      memberThreadIds: [worker.id],
      needsYouThreadIds: [],
    };
    harness.api.projectAgent.listSummaries.mockResolvedValue({ summaries: [initialSummary] });
    setSidebarSummaries([worker]);
    const screen = await renderPanel();
    const workerSection = () =>
      [...document.querySelectorAll("section")].find((section) =>
        section.textContent?.includes(worker.title),
      );
    try {
      await vi.waitFor(() => expect(workerSection()?.textContent).toContain("Idle"));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      harness.api.projectAgent.listSummaries.mockResolvedValue({
        summaries: [{ ...initialSummary, needsYouThreadIds: [worker.id] }],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(workerSection()?.textContent).toContain("Waiting on you"), {
        timeout: 1_000,
      });

      harness.api.projectAgent.listSummaries.mockResolvedValue({ summaries: [initialSummary] });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(workerSection()?.textContent).toContain("Idle"), {
        timeout: 1_000,
      });
      expect(harness.api.projectAgent.getOverview).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      Reflect.deleteProperty(document, "visibilityState");
      vi.useRealTimers();
      harness.api.projectAgent.listSummaries.mockResolvedValue({ summaries: [] });
    }
  });
});
