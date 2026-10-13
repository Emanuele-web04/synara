import {
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type NativeApi,
  type ServerProviderStatus,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettingsSchema, type AppSettings } from "../appSettings";
import type { Project, Thread } from "../types";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { useThreadHandoff } from "./useThreadHandoff";

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  settings: null as AppSettings | null,
  sticky: {} as Record<string, ModelSelection | undefined>,
  statuses: [] as ServerProviderStatus[],
  sync: vi.fn(),
  navigate: vi.fn(),
  copy: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../appSettings", async (original) => ({
  ...(await original<typeof import("../appSettings")>()),
  useAppSettings: () => ({ settings: state.settings }),
}));
vi.mock("../store", () => ({
  useStore: (
    select: (store: { projects: Project[]; syncServerShellSnapshot: typeof state.sync }) => unknown,
  ) => select({ projects: state.projects, syncServerShellSnapshot: state.sync }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      stickyModelSelectionByProvider: state.sticky,
      copyTransferableComposerState: state.copy,
    }),
  },
}));
vi.mock("./useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => state.statuses,
}));
vi.mock("./useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => state.refresh,
}));

const now = "2026-10-11T12:00:00.000Z";
const projectId = ProjectId.makeUnsafe("handoff-project");
function sourceThread(): Thread {
  return {
    id: ThreadId.makeUnsafe("handoff-source"),
    codexThreadId: null,
    projectId,
    title: "Existing conversation",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    session: null,
    handoff: null,
    branch: "feature/handoff",
    worktreePath: "/worktrees/selected",
    messages: [
      {
        id: MessageId.makeUnsafe("source-message"),
        role: "user",
        text: "Preserve this context",
        createdAt: now,
        streaming: false,
        source: "native",
      },
    ],
    proposedPlans: [],
    turnDiffSummaries: [],
    activities: [],
    latestTurn: null,
    error: null,
    createdAt: now,
  };
}

const clients = new Set<QueryClient>();
function mountHandoff(api: NativeApi) {
  vi.stubGlobal("window", { nativeApi: api });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.add(client);
  client.setQueryData(serverQueryKeys.config(), { cwd: "/server-fallback" });
  const result: { current: ReturnType<typeof useThreadHandoff> | null } = { current: null };
  function Probe() {
    result.current = useThreadHandoff();
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  if (!result.current) throw new Error("Handoff hook did not render");
  return result.current;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.projects = [
    {
      id: projectId,
      kind: "project",
      name: "Project",
      remoteName: "",
      folderName: "project",
      localName: null,
      cwd: "/project",
      defaultModelSelection: null,
      expanded: true,
      scripts: [],
    },
  ];
  state.settings = AppSettingsSchema.makeUnsafe({
    piBinaryPath: "/default/pi",
    piAgentDir: "/default/agent",
    providerInstances: {
      pi_work: {
        driver: "pi",
        displayName: "Pi work",
        config: { binaryPath: "/configured/pi", agentDir: "/configured/agent" },
      },
    },
  });
  state.sticky = {};
  state.statuses = [
    {
      provider: "pi",
      instanceId: "pi_work",
      driver: "pi",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: now,
    },
  ];
});
afterEach(() => {
  for (const client of clients) client.clear();
  clients.clear();
  vi.unstubAllGlobals();
});

function nativeFixture() {
  const listModels = vi.fn<NativeApi["provider"]["listModels"]>().mockResolvedValue({
    models: [{ slug: "vendor/available-model", name: "Available Pi model" }],
    source: "pi.sdk",
    cached: false,
  });
  const dispatchCommand = vi
    .fn<NativeApi["orchestration"]["dispatchCommand"]>()
    .mockResolvedValue({ sequence: 1 });
  const getShellSnapshot = vi
    .fn()
    .mockResolvedValue({ snapshotSequence: 1, projects: [], threads: [], spaces: [] });
  const api = {
    provider: { listModels },
    orchestration: { dispatchCommand, getShellSnapshot },
  } as unknown as NativeApi;
  return { api, listModels, dispatchCommand, getShellSnapshot };
}

describe("useThreadHandoff Pi discovery admission", () => {
  it("discovers the configured target instance in the actual worktree before creating a handoff", async () => {
    const native = nativeFixture();
    const hook = mountHandoff(native.api);
    const thread = sourceThread();
    const original = structuredClone(thread);
    const id = await hook.createThreadHandoff(thread, "pi", "pi_work");
    expect(native.listModels).toHaveBeenCalledExactlyOnceWith({
      provider: "pi",
      instanceId: "pi_work",
      binaryPath: "/configured/pi",
      agentDir: "/configured/agent",
      cwd: "/worktrees/selected",
    });
    expect(native.dispatchCommand).toHaveBeenCalledOnce();
    expect(native.dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.handoff.create",
      threadId: id,
      sourceThreadId: thread.id,
      modelSelection: { provider: "pi", instanceId: "pi_work", model: "vendor/available-model" },
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      importedMessages: [{ role: "user", text: "Preserve this context" }],
    });
    expect(thread).toEqual(original);
    expect(state.copy).toHaveBeenCalledExactlyOnceWith(thread.id, id);
  });

  it.each(["sticky", "project"] as const)(
    "preserves an explicit %s Pi model without discovery",
    async (origin) => {
      const native = nativeFixture();
      if (origin === "sticky")
        state.sticky.pi_work = {
          provider: "pi",
          instanceId: "pi_work",
          model: "vendor/chosen-model",
        };
      else
        state.projects[0]!.defaultModelSelection = { provider: "pi", model: "vendor/chosen-model" };
      await mountHandoff(native.api).createThreadHandoff(sourceThread(), "pi", "pi_work");
      expect(native.listModels).not.toHaveBeenCalled();
      expect(native.dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
        modelSelection: { provider: "pi", instanceId: "pi_work", model: "vendor/chosen-model" },
      });
    },
  );

  it.each([
    { source: "pi.sdk", models: [], cached: false },
    {
      source: "pi.sdk",
      models: [{ slug: "vendor/stale", name: "Stale" }],
      cached: false,
      error: "Credentials unavailable",
    },
  ])(
    "does not create a thread or change drafts after unusable discovery: $error",
    async (catalog) => {
      const native = nativeFixture();
      native.listModels.mockResolvedValue(catalog);
      await expect(
        mountHandoff(native.api).createThreadHandoff(sourceThread(), "pi", "pi_work"),
      ).rejects.toThrow(/No Pi model|Pi model discovery failed/);
      expect(native.dispatchCommand).not.toHaveBeenCalled();
      expect(state.copy).not.toHaveBeenCalled();
      expect(state.navigate).not.toHaveBeenCalled();
    },
  );

  it("refuses a model from another configured Pi account before any command", async () => {
    const native = nativeFixture();
    await expect(
      mountHandoff(native.api).continueThreadHandoff(sourceThread(), "pi", "pi_work", {
        provider: "pi",
        instanceId: "pi_personal",
        model: "vendor/other-account",
      }),
    ).rejects.toThrow(/does not belong to this handoff target/);
    expect(native.listModels).not.toHaveBeenCalled();
    expect(native.dispatchCommand).not.toHaveBeenCalled();
  });
});
