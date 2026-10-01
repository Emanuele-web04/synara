import { ProjectId, type ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { makeFile, resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import type { SidebarThreadSummary } from "../types";
import { dispatchDraftThread } from "./draftThreadDispatch";
import { createAndDispatchDraftThread, createDraftThread } from "./draftThreadCreate";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async (_command: unknown) => undefined),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
    },
  }),
}));

describe("draft thread creation", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    nativeApiMocks.dispatchCommand.mockClear();
  });

  it("preserves Debug in the draft and dispatched turn", async () => {
    const projectId = ProjectId.makeUnsafe("project-draft-debug");
    const threadId = createDraftThread({
      projectId,
      prompt: "Investigate the failing task",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "debug",
      envMode: "local",
    });

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.interactionMode).toBe(
      "debug",
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.interactionMode).toBe(
      "debug",
    );

    const result = await dispatchDraftThread({
      threadId,
      projectId,
      thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result).toEqual({ kind: "dispatched" });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "").toBe("");
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        interactionMode: "debug",
      }),
    );
  });

  it("creates the thread in the chosen folder before sending the first turn", async () => {
    const projectId = ProjectId.makeUnsafe("project-home");
    const linked: string[] = [];

    const { threadId, result } = await createAndDispatchDraftThread({
      projectId,
      prompt: "Clean up my Downloads folder",
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "local",
      workingDirectory: "/Users/test/Downloads",
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
      beforeDispatch: async (id) => {
        linked.push(id);
      },
    });

    expect(result).toEqual({ kind: "dispatched" });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "").toBe("");
    expect(linked).toEqual([threadId]);
    const commandTypes = nativeApiMocks.dispatchCommand.mock.calls.map(
      ([command]) => (command as { type: string }).type,
    );
    expect(commandTypes).toEqual(["thread.create", "thread.turn.start"]);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.create",
        threadId,
        projectId,
        workingDirectory: "/Users/test/Downloads",
      }),
    );
  });

  it("drops the draft without sending when linking fails", async () => {
    const projectId = ProjectId.makeUnsafe("project-link-failure");

    await expect(
      createAndDispatchDraftThread({
        projectId,
        prompt: "Renew the domain",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
        beforeDispatch: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");

    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
    expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId)).toEqual([]);
  });
  it.each(
    (["dispatch", "link"] as const).flatMap((stage) =>
      (["text", "file", "model", "deferred-attachment", "same-prompt", "persistence"] as const).map(
        (change) => ({ stage, change }),
      ),
    ),
  )(
    "cleans up $stage after $change updates without losing user edits",
    async ({ stage, change }) => {
      const projectId = ProjectId.makeUnsafe(`project-concurrent-${stage}-${change}`);
      let editedId: ThreadId | undefined;
      const editWhilePending = (id: ThreadId) => {
        editedId = id;
        const store = useComposerDraftStore.getState();
        if (change === "text") store.setPrompt(id, "My next message");
        else if (change === "file") store.addFiles(id, [makeFile({ id: "next-file" })]);
        else if (change === "model") store.setRuntimeMode(id, "full-access");
        else if (change === "deferred-attachment") {
          // Restored persistence can contain an image that has not hydrated to a File yet.
          useComposerDraftStore.setState({
            draftsByThreadId: {
              ...store.draftsByThreadId,
              [id]: {
                ...store.draftsByThreadId[id]!,
                persistedAttachments: [
                  {
                    id: "deferred",
                    name: "later.png",
                    mimeType: "image/png",
                    sizeBytes: 12,
                    blobKey: "later-image",
                  },
                ],
              },
            },
          });
        } else if (change === "same-prompt") store.setPrompt(id, "Original task");
        // This action runs on composer mount even when no images exist.
        else store.clearPersistedAttachments(id);
      };
      if (stage === "dispatch") {
        nativeApiMocks.dispatchCommand.mockImplementationOnce(async () => undefined);
        nativeApiMocks.dispatchCommand.mockImplementationOnce(async (command) => {
          editWhilePending((command as { threadId: ThreadId }).threadId);
        });
      }
      const pending = createAndDispatchDraftThread({
        projectId,
        prompt: "Original task",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
        beforeDispatch: async (id) => {
          if (stage !== "link") return;
          editWhilePending(id);
          throw new Error("Link refused");
        },
      });
      if (stage === "link") await expect(pending).rejects.toThrow("Link refused");
      else expect((await pending).result).toEqual({ kind: "dispatched" });
      const store = useComposerDraftStore.getState();
      const draft = store.draftsByThreadId[editedId!];
      const substantive =
        change === "text" ||
        change === "file" ||
        change === "model" ||
        change === "deferred-attachment";
      expect(draft?.prompt ?? "").toBe(
        substantive ? (change === "text" ? "My next message" : "Original task") : "",
      );
      if (change === "file") expect(draft?.files.map((file) => file.id)).toEqual(["next-file"]);
      if (change === "model") expect(draft?.runtimeMode).toBe("full-access");
      if (change === "deferred-attachment")
        expect(draft?.persistedAttachments.map((attachment) => attachment.id)).toEqual([
          "deferred",
        ]);
      if (stage === "link") expect(store.getDraftThread(editedId!) !== null).toBe(substantive);
    },
  );
});
