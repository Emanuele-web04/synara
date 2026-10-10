import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectComposerThreadDraft } from "./composerDraftDomain";
import { runComposerSendOnce } from "./lib/composerSendOwnership";
import {
  finalizePromotedDraftThreads,
  markPromotedDraftThreads,
  reclaimUnreachableDetachedDraftThreads,
  useComposerDraftStore,
} from "./composerDraftStore";
import { stageDraftNavigation } from "./lib/stagedDraftNavigation";
import {
  makeImage,
  makeQueuedChatTurn,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";

describe("composerDraftStore stable empty draft identity", () => {
  it("reuses the empty draft sentinel across unrelated store updates", () => {
    resetComposerDraftStore();
    const missingThreadId = ThreadId.makeUnsafe("thread-missing");
    const otherThreadId = ThreadId.makeUnsafe("thread-other");
    const before = selectComposerThreadDraft(useComposerDraftStore.getState(), missingThreadId);

    useComposerDraftStore.getState().setPrompt(otherThreadId, "unrelated");

    const after = selectComposerThreadDraft(useComposerDraftStore.getState(), missingThreadId);
    expect(after).toBe(before);
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.makeUnsafe("thread-clear");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("revokes blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-clear",
      previewUrl: "blob:clear",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:clear");
  });

  it("can preserve blob preview URLs for optimistic message handoff", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId, { preservePreviewUrls: true });

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });
});

describe("composerDraftStore project draft thread mapping", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const otherProjectId = ProjectId.makeUnsafe("project-b");
  const threadId = ThreadId.makeUnsafe("thread-a");
  const otherThreadId = ThreadId.makeUnsafe("thread-b");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByProjectId(projectId)).toBeNull();
    expect(store.getDraftThread(threadId)).toBeNull();

    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toEqual({
      threadId,
      projectId,
      entryPoint: "chat",
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      workingDirectory: null,
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastKnownPr: null,
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toEqual({
      projectId,
      entryPoint: "chat",
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      workingDirectory: null,
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastKnownPr: null,
    });
  });

  it("preserves untouched thread draft identity across unrelated thread updates", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "thread a");
    store.setPrompt(otherThreadId, "thread b");
    const threadADraft = useComposerDraftStore.getState().draftsByThreadId[threadId];

    useComposerDraftStore.getState().setPrompt(otherThreadId, "thread b updated");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBe(threadADraft);
  });

  it("tracks temporary draft metadata and lets context updates clear it", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, { isTemporary: true });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBe(true);

    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/preserve-temp",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBe(true);

    store.setDraftThreadContext(threadId, { isTemporary: false });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBeUndefined();
  });

  it("stages, trims, and clears a draft goal via context updates", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {});
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.goal).toBeUndefined();

    store.setDraftThreadContext(threadId, { goal: "  ship the snake game  " });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.goal).toBe(
      "ship the snake game",
    );

    // Unrelated context updates keep the staged goal.
    store.setDraftThreadContext(threadId, { branch: "feature/goal" });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.goal).toBe(
      "ship the snake game",
    );

    store.setDraftThreadContext(threadId, { goal: "" });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.goal).toBeUndefined();
  });

  it("registers a mapping-less temporary terminal draft for staged navigation", () => {
    const store = useComposerDraftStore.getState();

    store.registerDraftThread(threadId, {
      projectId,
      entryPoint: "terminal",
      isTemporary: true,
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      entryPoint: "terminal",
      isTemporary: true,
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "terminal")).toBe(
      null,
    );
  });

  it("tracks chat and terminal draft threads independently for the same project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, { entryPoint: "chat" });
    store.setProjectDraftThreadId(projectId, otherThreadId, { entryPoint: "terminal" });

    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "chat"),
    ).toMatchObject({
      threadId,
      projectId,
      entryPoint: "chat",
    });
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "terminal"),
    ).toMatchObject({
      threadId: otherThreadId,
      projectId,
      entryPoint: "terminal",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.entryPoint).toBe("chat");
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)?.entryPoint).toBe(
      "terminal",
    );
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");

    store.clearProjectDraftThreadById(projectId, otherThreadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );

    store.clearProjectDraftThreadById(projectId, threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("releases queued preview blobs when clearing a draft by project and thread id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-project-delete",
        makeImage({ id: "queued-image-delete", previewUrl: "blob:queued-project-delete" }),
      ),
    );

    store.clearProjectDraftThreadById(projectId, threadId);

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-project-delete");
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");
    store.clearProjectDraftThreadId(projectId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("clears orphaned composer drafts when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "orphan me");

    store.setProjectDraftThreadId(projectId, otherThreadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("keeps the mapped draft and its text when a detached draft skips the slot claim", () => {
    // preserveProjectDraft callers (bug-report drafting) stage a routable draft
    // via registerDraftThread only — no setProjectDraftThreadId — so the user's
    // unsent project draft must survive untouched.
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "unsent work in progress");

    store.registerDraftThread(otherThreadId, {
      projectId,
      entryPoint: "chat",
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.setPrompt(otherThreadId, "bug-report interview prompt");

    const state = useComposerDraftStore.getState();
    expect(state.getDraftThreadByProjectId(projectId)?.threadId).toBe(threadId);
    expect(state.draftsByThreadId[threadId]?.prompt).toContain("unsent work in progress");
    expect(state.getDraftThread(otherThreadId)).toMatchObject({ projectId, entryPoint: "chat" });
    expect(state.draftsByThreadId[otherThreadId]?.prompt).toContain("bug-report interview prompt");
  });

  it("preserves unmapped task drafts even when their composer is empty", () => {
    const store = useComposerDraftStore.getState();
    const taskId = ThreadId.makeUnsafe("linked-empty-task");
    store.registerDraftThread(taskId, { projectId, entryPoint: "chat" });
    reclaimUnreachableDetachedDraftThreads(new Set());
    expect(store.getDraftThread(taskId)).not.toBeNull();
  });

  it("keeps queued work in a transient draft even with an empty composer", () => {
    const store = useComposerDraftStore.getState();
    const detachedId = ThreadId.makeUnsafe("queued-detached");
    store.registerDraftThread(detachedId, {
      projectId,
      entryPoint: "chat",
      isReclaimableDraft: true,
    });
    store.enqueueQueuedTurn(
      detachedId,
      makeQueuedChatTurn(
        "keep-queued",
        makeImage({ id: "queue-image", previewUrl: "blob:keep-queued" }),
      ),
    );
    reclaimUnreachableDetachedDraftThreads(new Set());
    expect(store.getDraftThread(detachedId)).not.toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[detachedId]?.queuedTurns).toHaveLength(
      1,
    );
  });

  it("never reclaims detached drafts containing unsent work", () => {
    const store = useComposerDraftStore.getState();
    const detachedId = ThreadId.makeUnsafe("unsent-detached");
    store.registerDraftThread(detachedId, {
      projectId,
      entryPoint: "chat",
      isReclaimableDraft: true,
    });
    store.setPrompt(detachedId, "keep my report edits");
    reclaimUnreachableDetachedDraftThreads(new Set());
    expect(store.getDraftThread(detachedId)).not.toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[detachedId]?.prompt).toBe(
      "keep my report edits",
    );
  });

  it("reclaims only detached drafts that are unreachable", () => {
    const store = useComposerDraftStore.getState();
    const detachedId = ThreadId.makeUnsafe("thread-detached");
    const displayedId = ThreadId.makeUnsafe("thread-displayed");
    const promotedId = ThreadId.makeUnsafe("thread-promoted");

    // The mapped project draft keeps its unsent text.
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "unsent");
    // Detached drafts: one abandoned (unreachable), one still displayed, one
    // mid-promotion.
    store.registerDraftThread(detachedId, {
      projectId,
      entryPoint: "chat",
      isReclaimableDraft: true,
    });
    store.setPrompt(detachedId, "");
    store.registerDraftThread(displayedId, { projectId, entryPoint: "chat" });
    store.registerDraftThread(promotedId, { projectId, entryPoint: "chat" });
    store.markDraftThreadPromoting(promotedId);

    reclaimUnreachableDetachedDraftThreads(new Set([displayedId]));

    const state = useComposerDraftStore.getState();
    expect(state.getDraftThreadByProjectId(projectId)?.threadId).toBe(threadId);
    expect(state.draftsByThreadId[threadId]?.prompt).toContain("unsent");
    expect(state.getDraftThread(detachedId)).toBeNull();
    expect(state.draftsByThreadId[detachedId]).toBeUndefined();
    expect(state.getDraftThread(displayedId)).not.toBeNull();
    expect(state.getDraftThread(promotedId)?.promotedTo).toBe(promotedId);
  });

  it("keeps a promoted task's retry prompt when another draft takes its project slot", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "retry failed preparation");
    store.markDraftThreadPromoting(threadId);
    store.setProjectDraftThreadId(projectId, otherThreadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "retry failed preparation",
    );
    store.finalizePromotedDraftThread(threadId);
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
  });

  it("keeps a sending draft and its attachments when a new draft takes the project slot", async () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "retryable prompt");
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "sending-kept-thread",
        makeImage({ id: "sending-image", previewUrl: "blob:sending" }),
      ),
    );
    await runComposerSendOnce(threadId, async () => {
      store.setProjectDraftThreadId(projectId, otherThreadId);
      expect(useComposerDraftStore.getState().getDraftThread(threadId)).not.toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
        "retryable prompt",
      );
      expect(revokeSpy).not.toHaveBeenCalledWith("blob:sending");
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
        otherThreadId,
      );
      return false;
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).not.toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.queuedTurns).toHaveLength(
      1,
    );
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setProjectDraftThreadId(otherProjectId, threadId);
    store.setPrompt(threadId, "keep me");
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-kept-thread",
        makeImage({ id: "queued-image-kept", previewUrl: "blob:queued-kept-thread" }),
      ),
    );

    store.clearProjectDraftThreadId(projectId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId)?.threadId,
    ).toBe(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("keep me");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.queuedTurns).toHaveLength(
      1,
    );
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:queued-kept-thread");
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "remove me");
    store.clearDraftThread(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("retires promoted draft registration without discarding newer composer content", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "keep me while server thread hydrates");

    markPromotedDraftThreads(new Set([threadId]));

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep me while server thread hydrates",
    );

    // The send owner consumes the captured prompt; subsequent edits belong to the server task.
    store.clearComposerContent(threadId);
    store.setPrompt(threadId, "newer unsent edit");
    store.addImage(threadId, makeImage({ id: "newer-image", previewUrl: "blob:newer" }));
    store.enqueueQueuedTurn(threadId, makeQueuedChatTurn("newer-queued-turn"));
    const currentDraft = useComposerDraftStore.getState().draftsByThreadId[threadId];

    finalizePromotedDraftThreads(new Set([threadId]));

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(
      useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectId],
    ).toBeUndefined();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBe(currentDraft);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:newer");
    store.finalizePromotedDraftThread(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBe(currentDraft);
    store.clearDraftThread(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:newer");
  });

  it.each([true, false])(
    "preserves explicit Computer choice %s when a draft becomes a server thread",
    (enabled) => {
      const store = useComposerDraftStore.getState();
      store.setProjectDraftThreadId(projectId, threadId);
      store.setPrompt(threadId, "already sent");
      store.setEnableComputerControl(threadId, enabled);
      store.clearComposerContent(threadId);

      markPromotedDraftThreads(new Set([threadId]));
      finalizePromotedDraftThreads(new Set([threadId]));

      const promoted = useComposerDraftStore.getState();
      expect(promoted.getDraftThread(threadId)).toBeNull();
      expect(promoted.draftsByThreadId[threadId]?.prompt).toBe("");
      expect(promoted.draftsByThreadId[threadId]?.enableComputerControl).toBe(enabled);
      promoted.finalizePromotedDraftThread(threadId);
      expect(
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.enableComputerControl,
      ).toBe(enabled);

      promoted.clearDraftThread(threadId);
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
    },
  );

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: null,
    });
    store.setDraftThreadContext(threadId, {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("moves an empty draft to another project while preserving composer content", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/old",
      worktreePath: "/tmp/old-worktree",
      envMode: "worktree",
    });
    store.setPrompt(threadId, "keep this draft");

    store.moveDraftThreadToProject(threadId, otherProjectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
      lastKnownPr: null,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId),
    ).toMatchObject({
      threadId,
      projectId: otherProjectId,
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep this draft",
    );
  });

  it("clears the replaced target draft when moving a draft to another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/old",
      worktreePath: "/tmp/old-worktree",
      envMode: "worktree",
    });
    store.setPrompt(threadId, "move this draft");
    store.setProjectDraftThreadId(otherProjectId, otherThreadId);
    store.setPrompt(otherThreadId, "replace this draft");
    store.enqueueQueuedTurn(
      otherThreadId,
      makeQueuedChatTurn(
        "queued-target-replaced",
        makeImage({ id: "queued-target-replaced", previewUrl: "blob:queued-target-replaced" }),
      ),
    );

    store.moveDraftThreadToProject(threadId, otherProjectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
      lastKnownPr: null,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId),
    ).toMatchObject({
      threadId,
      projectId: otherProjectId,
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "move this draft",
    );
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-target-replaced");
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
  });

  it("removes standalone Kanban drafts when a project is deleted", () => {
    const store = useComposerDraftStore.getState();
    const kanbanId = ThreadId.makeUnsafe("thread-kanban-delete");

    store.registerDraftThread(kanbanId, {
      projectId,
      entryPoint: "chat",
    });
    store.setPrompt(kanbanId, "kanban task to delete");
    store.setProjectDraftThreadId(otherProjectId, otherThreadId);

    store.clearProjectDraftThreads(projectId);

    expect(store.getDraftThread(kanbanId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[kanbanId]).toBeUndefined();
    expect(store.getDraftThreadByProjectId(otherProjectId)?.threadId).toBe(otherThreadId);
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.makeUnsafe("thread-settings");
  const projectId = ProjectId.makeUnsafe("project-settings");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores AI-reviewed auto mode in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "auto");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe("auto");
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(threadId, "debug");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.interactionMode).toBe(
      "debug",
    );
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");
    store.setInteractionMode(threadId, "plan");
    store.setRuntimeMode(threadId, null);
    store.setInteractionMode(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("preserves Kanban drafts and in-flight staged drafts during reclamation", async () => {
    const store = useComposerDraftStore.getState();
    const kanbanId = ThreadId.makeUnsafe("thread-kanban");
    const stagedId = ThreadId.makeUnsafe("thread-staged");
    const abandonedId = ThreadId.makeUnsafe("thread-abandoned");

    store.registerDraftThread(kanbanId, { projectId, entryPoint: "chat" });
    store.setPrompt(kanbanId, "kanban task");
    store.registerDraftThread(stagedId, {
      projectId,
      entryPoint: "chat",
      isReclaimableDraft: true,
    });
    store.setPrompt(stagedId, "");
    store.registerDraftThread(abandonedId, {
      projectId,
      entryPoint: "chat",
      isReclaimableDraft: true,
    });
    store.setPrompt(abandonedId, "");

    let resolveStagedNavigate!: () => void;
    const stagedNavigate = new Promise<void>((resolve) => {
      resolveStagedNavigate = resolve;
    });

    const stagedStagePromise = stageDraftNavigation({
      draftThreadId: stagedId,
      stage: () => undefined,
      navigate: () => stagedNavigate,
      isDestinationActive: () => true,
      finalize: () => undefined,
      rollback: () => store.clearDraftThread(stagedId),
    });

    // Stage runs synchronously, so the staged draft is in the in-flight set
    // before the navigate promise resolves.
    reclaimUnreachableDetachedDraftThreads(new Set());

    expect(store.getDraftThread(kanbanId)).not.toBeNull();
    expect(store.getDraftThread(stagedId)).not.toBeNull();
    expect(store.getDraftThread(abandonedId)).toBeNull();

    resolveStagedNavigate();
    // Wait for the stage to complete so the in-flight set is cleaned up.
    await stagedStagePromise;
  });
});
