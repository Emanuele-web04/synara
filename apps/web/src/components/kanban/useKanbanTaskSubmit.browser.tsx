import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react/pure";

import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { ComposerImageIntakeQueue } from "../../hooks/useComposerImageIntake";
import { createAndSendKanbanTask } from "../../lib/kanbanTaskCreate";
import { createBrowserTestServerConfig } from "../../test/browserHarness";
import { useKanbanTaskSubmit } from "./useKanbanTaskSubmit";

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => async () => null,
}));
vi.mock("~/lib/kanbanTaskCreate", () => ({
  createAndSendKanbanTask: vi.fn(),
  createKanbanDraftTask: vi.fn(),
}));

beforeEach(() => {
  resetComposerDraftStore();
  vi.clearAllMocks();
});

it.each([false, true])(
  "keeps a failed photo send unsent, then admits a valid photo (failure completed before send=%s)",
  async (failureCompletedBeforeSend) => {
    const scratchThreadId = ThreadId.makeUnsafe("pending-photo-task");
    const prompt = "Inspect the photo I selected";
    const queue = new ComposerImageIntakeQueue();
    const errors: Array<string | null> = [];
    useComposerDraftStore.getState().setPrompt(scratchThreadId, prompt);
    const sentImageCounts: number[] = [];
    vi.mocked(createAndSendKanbanTask).mockImplementation(async () => {
      sentImageCounts.push(
        useComposerDraftStore.getState().draftsByThreadId[scratchThreadId]?.images.length ?? 0,
      );
      return { threadId: scratchThreadId, result: { kind: "dispatched" } };
    });
    const onOpenChange = vi.fn();
    const hook = await renderHook(() =>
      useKanbanTaskSubmit({
        selectedProjectId: ProjectId.makeUnsafe("photo-project"),
        hasSendableContent: true,
        selectedProvider: "codex",
        selectedProviderInstanceId: "codex",
        selectedModel: "gpt-5.5",
        selectedModelSupportsAutoMode: false,
        taskPreview: prompt,
        trimmedPrompt: prompt,
        scratchThreadId,
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
        sendAsDraft: false,
        defaultProvider: "codex",
        assistantDeliveryMode: "streaming",
        providerOptionsForDispatch: undefined,
        providerInstances: [],
        providerStatuses: createBrowserTestServerConfig("2026-11-01T12:00:00.000Z").providers,
        // The Send callback can have been captured before the pending state rendered.
        isPreparingImages: false,
        waitForPendingImages: () => queue.waitForPending(),
        onOpenChange,
      }),
    );
    try {
      let fail!: () => void;
      const job = queue.enqueue({
        files: [new File(["unreadable"], "first.png", { type: "image/png" })],
        existingAttachmentCount: () => 0,
        commitImages: () => 0,
        onError: (error) => errors.push(error),
        prepareFiles: () =>
          new Promise((_resolve, reject) => {
            fail = () => reject(new Error("The selected photo could not be read"));
          }),
      });
      const firstSend = failureCompletedBeforeSend ? null : hook.result.current.handleCreate();
      await Promise.resolve();
      await Promise.resolve();
      fail();
      await job;
      if (firstSend) await firstSend;
      else await hook.result.current.handleCreate();
      expect(createAndSendKanbanTask).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(useComposerDraftStore.getState().draftsByThreadId[scratchThreadId]?.prompt).toBe(
        prompt,
      );
      expect(errors.at(-1)).toBe("The selected photo could not be read");

      const file = new File(["prepared"], "ready.png", { type: "image/png" });
      const ready = queue.enqueue({
        files: [file],
        existingAttachmentCount: () => 0,
        commitImages: (images) =>
          useComposerDraftStore.getState().addImages(scratchThreadId, images),
        onError: (error) => errors.push(error),
        prepareFiles: async () => ({
          images: [
            {
              type: "image",
              id: "ready-image",
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              previewUrl: "blob:ready-image",
              file,
            },
          ],
          error: null,
        }),
      });
      await Promise.all([ready, hook.result.current.handleCreate()]);
      expect(createAndSendKanbanTask).toHaveBeenCalledOnce();
      expect(sentImageCounts).toEqual([1]);
    } finally {
      queue.dispose();
      await hook.unmount();
    }
  },
);
