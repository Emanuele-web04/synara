import {
  type ModelSelection,
  type ProjectAgentConfig,
  type ProjectAgentOverview,
  ProjectId,
  type ServerProviderStatus,
  ThreadId,
} from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import type { Project } from "../types";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import {
  applyGroupWorkerRoutingDefaults,
  resolveGroupContainerThreadDefaults,
  resolveGroupWorkerRoutingDefaults,
} from "./groupWorkerRouting";

const nativeApiMocks = vi.hoisted(() => ({
  getOverview: vi.fn(async () => ({})),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    projectAgent: {
      getOverview: nativeApiMocks.getOverview,
    },
  }),
}));

const GROUP_ID = ProjectId.makeUnsafe("project-group");
const ORDINARY_ID = ProjectId.makeUnsafe("project-ordinary");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const GROUPS_ROOT = "/Users/tester/Groups";

const PATHS = {
  homeDir: "/Users/tester",
  chatWorkspaceRoot: "/Users/tester/Chats",
  studioWorkspaceRoot: "/Users/tester/Studio",
  groupsWorkspaceRoot: GROUPS_ROOT,
};

const GROUP_MODEL: ModelSelection = { provider: "claudeAgent", model: "claude-opus-4-5" };
const GROUP_PROVIDER_OPTIONS = { claudeAgent: { enableArtifacts: true } };

function makeProject(input: { id: ProjectId; kind: Project["kind"]; cwd: string }): Project {
  return {
    id: input.id,
    kind: input.kind,
    name: "project",
    remoteName: "project",
    folderName: "project",
    localName: null,
    cwd: input.cwd,
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
  };
}

function makeOverview(overrides: Partial<ProjectAgentOverview> = {}): ProjectAgentOverview {
  return {
    projectId: GROUP_ID,
    configured: true,
    config: makeConfig(),
    linkedProjectIds: [],
    goal: null,
    digest: null,
    blockers: [],
    recentOutcomes: [],
    coordinatorStatus: "idle",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ProjectAgentConfig> = {}): ProjectAgentConfig {
  return {
    projectId: GROUP_ID,
    coordinatorThreadId: ThreadId.makeUnsafe("thread-coordinator"),
    coordinatorName: "Lead",
    coordinatorModelSelection: { provider: "codex", model: "gpt-5.4" },
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
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    disabledAt: null,
    ...overrides,
  };
}

function installMemoryLocalStorage() {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    clear: vi.fn(() => {
      entries.clear();
    }),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    get length() {
      return entries.size;
    },
  });
}

beforeEach(() => {
  installMemoryLocalStorage();
  resetComposerDraftStore();
  nativeApiMocks.getOverview.mockReset();
  useStore.setState({ projects: [], threadsHydrated: true });
  useWorkspacePathsStore.setState(PATHS);
});

describe("resolveGroupContainerThreadDefaults", () => {
  it("returns the group's workerRouting for a chat thread minted in a group", async () => {
    const group = makeProject({ id: GROUP_ID, kind: "group", cwd: `${GROUPS_ROOT}/team` });
    useStore.setState({ projects: [group] });
    nativeApiMocks.getOverview.mockResolvedValue(
      makeOverview({
        config: makeConfig({
          workerRouting: {
            modelSelection: GROUP_MODEL,
            providerOptions: GROUP_PROVIDER_OPTIONS,
          },
        }),
      }),
    );

    const defaults = await resolveGroupContainerThreadDefaults({
      projectId: GROUP_ID,
      entryPoint: "chat",
    });

    expect(defaults).toEqual({
      modelSelection: GROUP_MODEL,
      providerOptions: GROUP_PROVIDER_OPTIONS,
    });
    expect(nativeApiMocks.getOverview).toHaveBeenCalledWith({ projectId: GROUP_ID });
  });

  it("resolves null for a group without workerRouting or config", async () => {
    const group = makeProject({ id: GROUP_ID, kind: "group", cwd: `${GROUPS_ROOT}/team` });
    useStore.setState({ projects: [group] });
    nativeApiMocks.getOverview.mockResolvedValue(makeOverview());
    await expect(
      resolveGroupContainerThreadDefaults({ projectId: GROUP_ID, entryPoint: "chat" }),
    ).resolves.toBeNull();

    nativeApiMocks.getOverview.mockResolvedValue(
      makeOverview({ configured: false, config: null, coordinatorStatus: "unconfigured" }),
    );
    await expect(
      resolveGroupContainerThreadDefaults({ projectId: GROUP_ID, entryPoint: "chat" }),
    ).resolves.toBeNull();
  });

  it("skips terminal threads and ordinary projects without an RPC", async () => {
    const group = makeProject({ id: GROUP_ID, kind: "group", cwd: `${GROUPS_ROOT}/team` });
    const ordinary = makeProject({ id: ORDINARY_ID, kind: "project", cwd: "/repo/app" });
    useStore.setState({ projects: [group, ordinary] });

    await expect(
      resolveGroupContainerThreadDefaults({ projectId: GROUP_ID, entryPoint: "terminal" }),
    ).resolves.toBeNull();
    await expect(
      resolveGroupContainerThreadDefaults({ projectId: ORDINARY_ID, entryPoint: "chat" }),
    ).resolves.toBeNull();
    await expect(
      resolveGroupContainerThreadDefaults({
        projectId: ProjectId.makeUnsafe("project-missing"),
        entryPoint: "chat",
      }),
    ).resolves.toBeNull();
    expect(nativeApiMocks.getOverview).not.toHaveBeenCalled();
  });

  it("resolves null when the overview request fails", async () => {
    const group = makeProject({ id: GROUP_ID, kind: "group", cwd: `${GROUPS_ROOT}/team` });
    useStore.setState({ projects: [group] });
    nativeApiMocks.getOverview.mockRejectedValue(new Error("offline"));

    await expect(
      resolveGroupContainerThreadDefaults({ projectId: GROUP_ID, entryPoint: "chat" }),
    ).resolves.toBeNull();
  });
});

describe("resolveGroupWorkerRoutingDefaults", () => {
  it("reads workerRouting off the group overview config", async () => {
    nativeApiMocks.getOverview.mockResolvedValue(
      makeOverview({
        config: makeConfig({ workerRouting: { modelSelection: GROUP_MODEL } }),
      }),
    );

    await expect(resolveGroupWorkerRoutingDefaults({ groupProjectId: GROUP_ID })).resolves.toEqual({
      modelSelection: GROUP_MODEL,
      providerOptions: undefined,
    });
  });
});

const GROUP_PROVIDER_STATUS: ServerProviderStatus = {
  provider: "claudeAgent",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-09-01T00:00:00.000Z",
};

const FALLBACK_PROVIDER_STATUS: ServerProviderStatus = {
  provider: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-09-01T00:00:00.000Z",
};

describe("applyGroupWorkerRoutingDefaults", () => {
  it("seeds the draft's model selection and dispatch provider options", () => {
    applyGroupWorkerRoutingDefaults({
      threadId: THREAD_ID,
      defaults: {
        modelSelection: GROUP_MODEL,
        providerOptions: GROUP_PROVIDER_OPTIONS,
      },
      providerStatuses: [GROUP_PROVIDER_STATUS, FALLBACK_PROVIDER_STATUS],
    });

    const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
    expect(draft?.activeProvider).toBe("claudeAgent");
    expect(draft?.modelSelectionByProvider.claudeAgent?.model).toBe("claude-opus-4-5");
    expect(draft?.providerOptionsForDispatch).toEqual(GROUP_PROVIDER_OPTIONS);
  });

  it("pins the group's model optimistically while provider statuses are still loading", () => {
    applyGroupWorkerRoutingDefaults({
      threadId: THREAD_ID,
      defaults: { modelSelection: GROUP_MODEL },
      providerStatuses: [],
    });

    const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
    expect(draft?.activeProvider).toBe("claudeAgent");
    expect(draft?.modelSelectionByProvider.claudeAgent?.model).toBe("claude-opus-4-5");
  });

  it("keeps the usable fallback active when the group's provider is not installed", () => {
    // The composer's usable-provider fallback already ran (sticky mint): the
    // draft is on codex because claudeAgent is not installed.
    useComposerDraftStore
      .getState()
      .setModelSelection(THREAD_ID, { provider: "codex", model: "gpt-5.4" });
    applyGroupWorkerRoutingDefaults({
      threadId: THREAD_ID,
      defaults: {
        modelSelection: GROUP_MODEL,
        providerOptions: GROUP_PROVIDER_OPTIONS,
      },
      providerStatuses: [
        {
          provider: "claudeAgent",
          status: "error",
          available: false,
          authStatus: "unknown",
          checkedAt: "2026-09-01T00:00:00.000Z",
          message: "Claude Code is not installed.",
        },
        FALLBACK_PROVIDER_STATUS,
      ],
    });

    const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
    // The configured model stays as the per-provider default, but the active
    // provider is not pinned to an unusable one — a send would dispatch codex.
    expect(draft?.activeProvider).toBe("codex");
    expect(draft?.modelSelectionByProvider.codex?.model).toBe("gpt-5.4");
    expect(draft?.modelSelectionByProvider.claudeAgent?.model).toBe("claude-opus-4-5");
    expect(draft?.providerOptionsForDispatch).toEqual(GROUP_PROVIDER_OPTIONS);
  });

  it("keeps the usable fallback active when the group's provider is signed out", () => {
    useComposerDraftStore
      .getState()
      .setModelSelection(THREAD_ID, { provider: "codex", model: "gpt-5.4" });
    applyGroupWorkerRoutingDefaults({
      threadId: THREAD_ID,
      defaults: { modelSelection: GROUP_MODEL },
      providerStatuses: [
        {
          provider: "claudeAgent",
          status: "warning",
          available: true,
          authStatus: "unauthenticated",
          checkedAt: "2026-09-01T00:00:00.000Z",
        },
        FALLBACK_PROVIDER_STATUS,
      ],
    });

    const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
    expect(draft?.activeProvider).toBe("codex");
    expect(draft?.modelSelectionByProvider.claudeAgent?.model).toBe("claude-opus-4-5");
  });
});
