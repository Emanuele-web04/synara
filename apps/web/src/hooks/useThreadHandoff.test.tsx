import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type ServerProviderStatus,
  type ModelSelection,
} from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../types";
import { useThreadHandoff } from "./useThreadHandoff";

const fixture = vi.hoisted(() => ({
  thread: undefined as Thread | undefined,
  projects: [] as Array<{ id: string; defaultModelSelection: null }>,
  statuses: [] as ServerProviderStatus[],
  navigate: vi.fn(async () => {}),
  dispatch: vi.fn(async (_command: unknown) => ({ sequence: 1 })),
  getShellSnapshot: vi.fn(async () => ({ threads: [] })),
  syncSnapshot: vi.fn(),
  setModelSelectionAndSticky: vi.fn(),
  copyTransferableComposerState: vi.fn(),
  refreshStatuses: vi.fn(async () => [] as ServerProviderStatus[]),
  subscribe: vi.fn((_listener: () => void) => vi.fn()),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: fixture.dispatch,
      getShellSnapshot: fixture.getShellSnapshot,
    },
  }),
}));
vi.mock("../store", () => ({
  useStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ projects: fixture.projects, syncServerShellSnapshot: fixture.syncSnapshot }),
    { getState: () => ({}), subscribe: fixture.subscribe },
  ),
}));
vi.mock("../threadDerivation", () => ({ getThreadFromState: () => fixture.thread }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      stickyModelSelectionByProvider: {},
      setModelSelectionAndSticky: fixture.setModelSelectionAndSticky,
      copyTransferableComposerState: fixture.copyTransferableComposerState,
    }),
  },
}));
vi.mock("./useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => fixture.statuses,
}));
vi.mock("./useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => fixture.refreshStatuses,
}));

function readyStatus(provider: "codex" | "claudeAgent"): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-10-03T10:00:00.000Z",
  };
}

function mountHook() {
  let handoff!: ReturnType<typeof useThreadHandoff>;
  function Probe() {
    handoff = useThreadHandoff();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return handoff;
}

function complete(command: unknown, failed = false) {
  const id = (command as { commandId: string }).commandId;
  fixture.thread = {
    ...fixture.thread!,
    activities: [
      {
        id: EventId.makeUnsafe(`provider-handoff${failed ? "-failed" : ""}:${id}`),
        kind: failed ? "provider.handoff.failed" : "provider.handoff",
        tone: failed ? "error" : "info",
        summary: "Handoff outcome",
        payload: failed ? { detail: "Target authentication failed" } : {},
        turnId: null,
        createdAt: "2026-10-03T10:00:00.000Z",
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.thread = {
    id: ThreadId.makeUnsafe("source"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project"),
    title: "Review task",
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.4" },
    session: null,
    handoff: null,
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "worktree",
    branch: "review-task",
    worktreePath: "/work/review-task",
    workingDirectory: "/work/review-task",
    messages: [
      {
        id: MessageId.makeUnsafe("message"),
        role: "user",
        text: "Review the changes",
        streaming: false,
        createdAt: "2026-10-03T10:00:00.000Z",
        source: "native",
      },
    ],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    latestTurn: null,
    turnDiffSummaries: [],
  };
  fixture.projects = [{ id: "project", defaultModelSelection: null }];
  fixture.statuses = [readyStatus("codex"), readyStatus("claudeAgent")];
  fixture.dispatch.mockResolvedValue({ sequence: 1 });
  fixture.getShellSnapshot.mockResolvedValue({ threads: [] });
  fixture.subscribe.mockImplementation(() => vi.fn());
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useThreadHandoff compatibility", () => {
  it("preserves the legacy linked new conversation command, workspace and transcript import", async () => {
    const source = fixture.thread!;
    const nextId = await mountHook().createThreadHandoff(source, "claudeAgent", "claudeAgent");
    expect(nextId).not.toBe(source.id);
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({
      type: "thread.handoff.create",
      threadId: nextId,
      sourceThreadId: source.id,
      projectId: source.projectId,
      title: "Review task",
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      envMode: source.envMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
      workingDirectory: source.workingDirectory,
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent" },
      importedMessages: [{ role: "user", text: "Review the changes" }],
    });
    expect(fixture.copyTransferableComposerState).toHaveBeenCalledWith(source.id, nextId);
    expect(fixture.syncSnapshot).toHaveBeenCalledOnce();
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: nextId },
    });
  });

  it("keeps the existing same-thread dispatch usable by ordinary composer switching", async () => {
    // The opt-in belongs to explicit menus, not this shared runtime seam.
    fixture.dispatch.mockImplementation(async (command) => {
      complete(command);
      return { sequence: 1 };
    });
    const explicitSelection = {
      provider: "claudeAgent" as const,
      instanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: { effort: "high" },
    } satisfies ModelSelection;
    await mountHook().continueThreadHandoff(
      fixture.thread!,
      "claudeAgent",
      "claudeAgent",
      explicitSelection,
    );
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({
      type: "thread.meta.update",
      threadId: "source",
      providerHandoff: true,
      modelSelection: explicitSelection,
    });
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.getShellSnapshot).not.toHaveBeenCalled();
    expect(fixture.copyTransferableComposerState).not.toHaveBeenCalled();
  });

  it("reports durable target startup failure without creating or navigating to another thread", async () => {
    fixture.dispatch.mockImplementation(async (command) => {
      complete(command, true);
      return { sequence: 1 };
    });
    await expect(mountHook().continueThreadHandoff(fixture.thread!, "claudeAgent")).rejects.toThrow(
      "Target authentication failed",
    );
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("leaves provider startup pending after the existing timeout rather than claiming success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const pending = mountHook().continueThreadHandoff(fixture.thread!, "claudeAgent");
    const result = expect(pending).rejects.toThrow("Claude is still starting");
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.subscribe.mock.results[0]?.value).toHaveBeenCalledOnce();
  });

  it("retains same-provider account and unavailable-target safeguards", async () => {
    const handoff = mountHook();
    await expect(
      handoff.continueThreadHandoff(fixture.thread!, "codex", "codex_work"),
    ).rejects.toThrow("accounts of the same provider");
    fixture.statuses = [readyStatus("codex")];
    fixture.refreshStatuses.mockResolvedValue([readyStatus("codex")]);
    await expect(mountHook().createThreadHandoff(fixture.thread!, "claudeAgent")).rejects.toThrow();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
