import "~/index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectId, ThreadId } from "@synara/contracts";
import type { ProjectAgentOverview } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const PROJECT_ID = ProjectId.makeUnsafe("project-group-1");
const LINKED_ID = ProjectId.makeUnsafe("project-linked");
const CANDIDATE_ID = ProjectId.makeUnsafe("project-candidate");

const api = vi.hoisted(() => {
  const readDocumentResult = {
    head: {
      projectId: "project-group-1",
      logicalPath: "instructions.md",
      revision: 1,
      contentHash: "h",
      diskHash: "h",
      conflictPending: false,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    document: {
      logicalPath: "instructions.md",
      content: "Be nice.",
      revision: 1,
    },
    history: [],
  };
  return {
    projectAgent: {
      getOverview: vi.fn(),
      listTasks: vi.fn(async () => ({ tasks: [] })),
      listActivity: vi.fn(async () => ({ activity: [], nextCursor: null })),
      listDocuments: vi.fn(async () => ({ documents: [] })),
      listThreadIndex: vi.fn(async () => ({ threads: [] })),
      subscribe: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
      configure: vi.fn(),
      readDocument: vi.fn(async () => readDocumentResult),
      writeDocument: vi.fn(async (input: { logicalPath: string; content: string }) => ({
        logicalPath: input.logicalPath,
        content: input.content,
        revision: 2,
      })),
      linkProject: vi.fn(),
      unlinkProject: vi.fn(),
    },
    orchestration: { dispatchCommand: vi.fn(async () => ({ sequence: 1 })) },
    server: { getConfig: vi.fn(async () => ({ cwd: "/srv" })) },
    provider: { listModels: vi.fn(async () => ({ models: [], source: "disabled" })) },
  };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => api,
  ensureNativeApi: () => api,
}));

vi.mock("~/components/PluginLibrary", () => ({
  PluginLibrary: () => <div data-testid="plugin-library-stub">PluginLibrary stub</div>,
}));

import { makeProject } from "~/storeTestFixtures";
import { useStore } from "~/store";

import { GroupSettingsDialog } from "./GroupSettingsDialog";

function overview(overrides: Partial<ProjectAgentOverview> = {}): ProjectAgentOverview {
  return {
    projectId: PROJECT_ID,
    configured: true,
    config: {
      projectId: PROJECT_ID,
      coordinatorThreadId: ThreadId.makeUnsafe("thread-1"),
      coordinatorName: "alpha Coordinator",
      coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
      limits: {
        maxConcurrentWorkers: 4,
        maxNewWorkersPerTurn: 2,
        maxWorkerCreationsPerGoal: 16,
        maxAutomaticContinuationsPerGoal: 8,
        maxRepairRoundsPerTask: 2,
      },
      captureEnabled: true,
      enabled: true,
      automationId: null,
      revision: 4,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      disabledAt: null,
      goal: "ship it",
      icon: "🐝",
      autoMemoryEnabled: true,
    },
    goal: null,
    digest: null,
    linkedProjectIds: [],
    blockers: [],
    recentOutcomes: [],
    coordinatorStatus: "idle",
    ...overrides,
  } as ProjectAgentOverview;
}

function renderDialog(props: Partial<Parameters<typeof GroupSettingsDialog>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupSettingsDialog
        open
        mode="edit"
        projectId={PROJECT_ID}
        projectName="alpha"
        workspacePath="/tmp/group"
        defaultModelSelection={{ provider: "codex", model: "gpt-5-codex" }}
        onOpenChange={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("GroupSettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.projectAgent.getOverview.mockResolvedValue(overview());
    api.projectAgent.configure.mockResolvedValue(overview());
    useStore.setState({ projects: [] });
  });

  it("switches between nav sections", async () => {
    await renderDialog();

    await expect.element(page.getByLabelText("Group name")).toBeInTheDocument();

    await page.getByRole("button", { name: "Memory" }).click();
    await expect.element(page.getByLabelText("Group instructions")).toBeInTheDocument();

    await page.getByRole("button", { name: "Environment" }).click();
    expect(document.body.textContent).toContain("Linked repositories");

    await page.getByRole("button", { name: "Plugins" }).click();
    await expect.element(page.getByTestId("plugin-library-stub")).toBeInTheDocument();
  });

  it("opens at initialSection when provided", async () => {
    await renderDialog({ initialSection: "memory" });
    await expect.element(page.getByLabelText("Group instructions")).toBeInTheDocument();
  });

  it("saves General edits through projectAgent.configure", async () => {
    await renderDialog();

    await page.getByLabelText("Group goal").fill("grow the library");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.projectId).toBe(PROJECT_ID);
    expect(payload.goal).toBe("grow the library");
    expect(payload.expectedRevision).toBe(4);
    expect(payload.captureEnabled).toBe(true);
    expect(payload.autoMemoryEnabled).toBe(true);
    expect(payload.coordinatorModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5-codex",
    });
    expect(payload.workerRouting).toMatchObject({
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      environment: "local",
    });
    expect(typeof payload.requestId).toBe("string");
    // Name unchanged: no rename command dispatched.
    expect(api.orchestration.dispatchCommand).not.toHaveBeenCalled();
  });

  it("clears the footer save error when the draft changes", async () => {
    api.projectAgent.configure.mockRejectedValue(new Error("invalid remote URL"));
    await renderDialog();

    await page.getByLabelText("Group goal").fill("first attempt");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("invalid remote URL");
    });

    await page.getByLabelText("Group goal").fill("corrected value");
    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain("invalid remote URL");
    });
  });

  it("saves coordinator icon and color through configure", async () => {
    await renderDialog();

    const brainButton = page.getByRole("button", { name: "Coordinator icon Brain" });
    await brainButton.click();
    await expect.element(brainButton).toHaveAttribute("aria-pressed", "true");

    const violetSwatch = page.getByRole("button", { name: "Coordinator color Violet" });
    await violetSwatch.click();
    await expect.element(violetSwatch).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.coordinatorIcon).toBe("brain");
    expect(payload.coordinatorColor).toBe("violet");
  });

  it("clears stored appearance with Use default", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({
        config: {
          ...(overview().config as object),
          coordinatorIcon: "brain",
          coordinatorColor: "violet",
        } as never,
      }),
    );
    await renderDialog();

    await expect
      .element(page.getByRole("button", { name: "Coordinator icon Brain" }))
      .toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Use default coordinator appearance" }).click();
    await expect
      .element(page.getByRole("button", { name: "Coordinator icon Brain" }))
      .toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.coordinatorIcon).toBeNull();
    expect(payload.coordinatorColor).toBeNull();
  });

  it("dispatches project.meta.update when the group is renamed", async () => {
    await renderDialog();

    await page.getByLabelText("Group name").fill("beta");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await vi.waitFor(() => expect(api.projectAgent.configure).toHaveBeenCalledOnce());
    expect(api.orchestration.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.meta.update", title: "beta" }),
    );
    const payload = api.projectAgent.configure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.coordinatorName).toBe("beta Coordinator");
  });

  it("autosaves Memory instructions to instructions.md", async () => {
    await renderDialog();

    await page.getByRole("button", { name: "Memory" }).click();
    const textarea = page.getByLabelText("Group instructions");
    await textarea.fill("Always write tests first.");
    // Flush the debounced autosave by blurring.
    await page.getByRole("button", { name: "General" }).click();

    await vi.waitFor(() => expect(api.projectAgent.writeDocument).toHaveBeenCalled());
    const write = api.projectAgent.writeDocument.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(write.logicalPath).toBe("instructions.md");
    expect(write.content).toBe("Always write tests first.");
  });

  it("links and unlinks repositories from Environment", async () => {
    useStore.setState({
      projects: [
        makeProject({ id: PROJECT_ID, kind: "group", name: "alpha", cwd: "/tmp/group" }),
        makeProject({ id: LINKED_ID, name: "linked-repo", cwd: "/tmp/linked" }),
        makeProject({ id: CANDIDATE_ID, name: "candidate-repo", cwd: "/tmp/candidate" }),
      ],
    });
    api.projectAgent.getOverview.mockResolvedValue(overview({ linkedProjectIds: [LINKED_ID] }));
    api.projectAgent.linkProject.mockResolvedValue(overview());
    api.projectAgent.unlinkProject.mockResolvedValue(overview());

    await renderDialog();
    await page.getByRole("button", { name: "Environment" }).click();
    expect(document.body.textContent).toContain("linked-repo");

    await page.getByRole("button", { name: "Remove" }).click();
    await vi.waitFor(() =>
      expect(api.projectAgent.unlinkProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT_ID, linkedProjectId: LINKED_ID }),
      ),
    );

    await page.getByRole("button", { name: "Add repository" }).click();
    await page.getByRole("button", { name: /candidate-repo/ }).click();
    await vi.waitFor(() =>
      expect(api.projectAgent.linkProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: PROJECT_ID, linkedProjectId: CANDIDATE_ID }),
      ),
    );
  });

  it("shows the onboarding copy and Create group button", async () => {
    api.projectAgent.getOverview.mockResolvedValue(
      overview({ configured: false, config: null, coordinatorStatus: "unconfigured" }),
    );
    await renderDialog({ mode: "onboarding" });
    expect(document.body.textContent).toContain("Set up your group");
    await expect.element(page.getByRole("button", { name: "Create group" })).toBeInTheDocument();
  });
});
