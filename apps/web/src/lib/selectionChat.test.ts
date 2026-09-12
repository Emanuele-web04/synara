import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import type { Project, Thread } from "../types";
import { createSidechatThread } from "./sidechatCreation";
import { addSelectionToSide, startSelectionChat } from "./selectionChat";

const status = vi.fn();
const openPane = vi.fn();
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ git: { status } }) }));
vi.mock("./sidechatCreation", () => ({ createSidechatThread: vi.fn() }));
vi.mock("../rightDockStore", () => ({ useRightDockStore: { getState: () => ({ openPane }) } }));

const projectId = ProjectId.makeUnsafe("selection-project");
const threadId = ThreadId.makeUnsafe("selection-thread");
const selection = { assistantMessageId: "assistant-1", text: "Selected\n**text**" };
const modelSelection = { provider: "codex", model: "gpt-5.4" } as const;

function input() {
  return {
    projectId,
    projectCwd: "/repo",
    selection,
    prompt: "Explain this",
    envMode: "local" as const,
    modelSelection,
    selectedPromptEffort: "high",
    runtimeMode: "full-access" as const,
    createThread: vi.fn().mockResolvedValue(threadId),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
});

describe("startSelectionChat", () => {
  it("creates a fresh local draft and queues the prompt with its intact quote and model", async () => {
    const options = input();
    const original = ThreadId.makeUnsafe("original-thread");
    useComposerDraftStore.getState().setPrompt(original, "Keep my draft");
    await startSelectionChat(options);
    expect(status).not.toHaveBeenCalled();
    expect(options.createThread).toHaveBeenCalledWith(projectId, {
      fresh: true,
      entryPoint: "chat",
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: null,
    });
    const drafts = useComposerDraftStore.getState().draftsByThreadId;
    expect(drafts[original]?.prompt).toBe("Keep my draft");
    expect(drafts[threadId]?.queuedTurns).toHaveLength(1);
    expect(drafts[threadId]?.queuedTurns[0]).toMatchObject({
      prompt: "Explain this",
      assistantSelections: [selection],
      modelSelection,
      selectedPromptEffort: "high",
      envMode: "local",
      interactionMode: "default",
    });
  });

  it.each(["", "  Keep the exact draft\nwith more context  "])(
    "opens an editable draft %j with the quote without queueing a send",
    async (prompt) => {
      await startSelectionChat({ ...input(), intent: "compose", prompt });
      const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
      expect(draft?.prompt).toBe(prompt);
      expect(draft?.assistantSelections).toEqual([expect.objectContaining(selection)]);
      expect(draft?.queuedTurns).toHaveLength(0);
      expect(draft?.modelSelectionByProvider.codex).toMatchObject(modelSelection);
    },
  );

  it("resolves the checkout branch for a fresh worktree and remembers the choice", async () => {
    status.mockResolvedValue({ branch: "feature/current" });
    const options = { ...input(), envMode: "worktree" as const };
    await startSelectionChat(options);
    expect(status).toHaveBeenCalledWith({ cwd: "/repo" });
    expect(options.createThread).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        envMode: "worktree",
        branch: "feature/current",
        worktreePath: null,
      }),
    );
    expect(useProjectEnvironmentStore.getState().envModeByProjectId[projectId]).toBe("worktree");
  });

  it("does not create a local fallback when the worktree has no base branch", async () => {
    status.mockResolvedValue({ branch: null });
    const options = { ...input(), envMode: "worktree" as const };
    await expect(startSelectionChat(options)).rejects.toThrow("Check out a branch");
    expect(options.createThread).not.toHaveBeenCalled();
  });

  it("does not queue or remember a choice when navigation is superseded", async () => {
    const options = input();
    options.createThread.mockResolvedValue(null);
    await expect(startSelectionChat(options)).rejects.toThrow("Could not open");
    expect(useComposerDraftStore.getState().draftsByThreadId).toEqual({});
    expect(useProjectEnvironmentStore.getState().envModeByProjectId).toEqual({});
  });

  it("rejects an oversized quote before creating a thread", async () => {
    const options = { ...input(), selection: { ...selection, text: "x".repeat(4001) } };
    await expect(startSelectionChat(options)).rejects.toThrow("4,000");
    expect(options.createThread).not.toHaveBeenCalled();
  });
});

describe("addSelectionToSide", () => {
  it("attaches the quote before opening Side without sending a turn", async () => {
    vi.mocked(createSidechatThread).mockImplementation(async (options) => {
      expect(options.initialPrompt).toBeUndefined();
      options.openSidechat(threadId);
      return { threadId, promptError: null, snapshotError: null };
    });
    const sourceThreadId = ThreadId.makeUnsafe("source-thread");
    useComposerDraftStore.getState().setPrompt(sourceThreadId, "Keep my prompt");
    await addSelectionToSide({
      selection,
      project: { id: projectId, cwd: "/repo" } as Project,
      sourceThread: { id: sourceThreadId } as Thread,
      selectedModelSelection: modelSelection,
    });
    const drafts = useComposerDraftStore.getState().draftsByThreadId;
    expect(drafts[threadId]?.assistantSelections).toEqual([expect.objectContaining(selection)]);
    expect(drafts[threadId]?.queuedTurns).toHaveLength(0);
    expect(drafts[sourceThreadId]?.prompt).toBe("Keep my prompt");
    expect(openPane).toHaveBeenCalledWith(sourceThreadId, { kind: "sidechat", threadId });
  });
});
