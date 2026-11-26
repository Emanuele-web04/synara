import { describe, expect, it, vi } from "vitest";

import type { ComposerImageAttachment } from "../composerDraftStore";
import { ComposerImageIntakeQueue } from "./useComposerImageIntake";

function preparedImage(id: string): ComposerImageAttachment {
  const file = new File([id], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

describe("ComposerImageIntakeQueue", () => {
  it("waits for preparation and commits before reporting an empty queue", async () => {
    const queue = new ComposerImageIntakeQueue();
    let releasePreparation:
      | ((value: { images: ComposerImageAttachment[]; error: null }) => void)
      | undefined;
    const prepareFiles = vi.fn(
      () =>
        new Promise<{ images: ComposerImageAttachment[]; error: null }>((resolve) => {
          releasePreparation = resolve;
        }),
    );
    const commitImages = vi.fn(() => 1);
    const job = queue.enqueue({
      files: [new File(["image"], "image.png", { type: "image/png" })],
      existingAttachmentCount: () => 0,
      commitImages,
      onError: vi.fn(),
      prepareFiles,
    });

    expect(queue.pendingCount()).toBe(1);
    const waiting = queue.waitForPending();
    await Promise.resolve();
    await Promise.resolve();
    releasePreparation?.({ images: [preparedImage("ready")], error: null });
    await Promise.all([job, waiting]);

    expect(commitImages).toHaveBeenCalledOnce();
    expect(queue.pendingCount()).toBe(0);
  });

  it.each(["rejected result", "thrown read"] as const)(
    "does not admit a send waiting on a %s, then allows a valid intake",
    async (failure) => {
      const queue = new ComposerImageIntakeQueue();
      const errors: Array<string | null> = [];
      let finish!: () => void;
      const prepareFiles = () =>
        new Promise<{ images: ComposerImageAttachment[]; error: string | null }>(
          (resolve, reject) => {
            finish = () =>
              failure === "thrown read"
                ? reject(new Error("Photo could not be read"))
                : resolve({ images: [], error: "Photo could not be prepared" });
          },
        );
      const job = queue.enqueue({
        files: [new File(["image"], "image.png", { type: "image/png" })],
        existingAttachmentCount: () => 0,
        commitImages: () => 0,
        onError: (error) => errors.push(error),
        prepareFiles,
      });
      const waitingSend = queue.waitForPending();
      await Promise.resolve();
      await Promise.resolve();
      finish();
      await job;
      expect(await waitingSend).toBe(false);
      expect(errors.at(-1)).toMatch(/Photo could not be/);
      const valid = queue.enqueue({
        files: [new File(["valid"], "ready.png", { type: "image/png" })],
        existingAttachmentCount: () => 0,
        commitImages: () => 1,
        onError: (error) => errors.push(error),
        prepareFiles: async () => ({ images: [preparedImage("ready")], error: null }),
      });
      const nextSend = queue.waitForPending();
      await valid;
      expect(await nextSend).toBe(true);
      expect(errors.at(-1)).toBeNull();
    },
  );

  it("does not let a retired wait acknowledge a replacement draft's failed photo", async () => {
    const queue = new ComposerImageIntakeQueue();
    let finishOld!: (value: { images: ComposerImageAttachment[]; error: null }) => void;
    const retiredJob = queue.enqueue({
      files: [new File(["old"], "old.png", { type: "image/png" })],
      existingAttachmentCount: () => 0,
      commitImages: () => 1,
      onError: () => {},
      prepareFiles: () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    });
    const retiredSend = queue.waitForPending();
    await Promise.resolve();
    await Promise.resolve();
    queue.dispose();
    queue.activate();
    await queue.enqueue({
      files: [new File(["new"], "new.png", { type: "image/png" })],
      existingAttachmentCount: () => 0,
      commitImages: () => 0,
      onError: () => {},
      prepareFiles: async () => ({ images: [], error: "New photo could not be read" }),
    });
    finishOld({ images: [preparedImage("retired")], error: null });
    await retiredJob;
    expect(await retiredSend).toBe(false);
    expect(await queue.waitForPending()).toBe(false);
    expect(await queue.waitForPending()).toBe(true);
  });

  it("revokes prepared previews and skips commit after disposal", async () => {
    const queue = new ComposerImageIntakeQueue();
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeObjectUrl = vi.fn();
    URL.revokeObjectURL = revokeObjectUrl;
    let releasePreparation:
      | ((value: { images: ComposerImageAttachment[]; error: null }) => void)
      | undefined;
    const commitImages = vi.fn(() => 1);
    const job = queue.enqueue({
      files: [new File(["image"], "image.png", { type: "image/png" })],
      existingAttachmentCount: () => 0,
      commitImages,
      onError: vi.fn(),
      prepareFiles: () =>
        new Promise((resolve) => {
          releasePreparation = resolve;
        }),
    });
    await Promise.resolve();
    await Promise.resolve();
    queue.dispose();
    releasePreparation?.({ images: [preparedImage("stale")], error: null });
    await job;

    expect(commitImages).not.toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:stale");
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("accepts a new image after reactivation without committing the cancelled preparation", async () => {
    const queue = new ComposerImageIntakeQueue();
    const images: ComposerImageAttachment[] = [];
    let releasePreparation!: (value: { images: ComposerImageAttachment[]; error: null }) => void;
    const staleJob = queue.enqueue({
      files: [new File(["old"], "old.png", { type: "image/png" })],
      existingAttachmentCount: () => images.length,
      commitImages: (prepared) => {
        images.push(...prepared);
        return prepared.length;
      },
      onError: () => {},
      prepareFiles: () => new Promise((resolve) => (releasePreparation = resolve)),
    });
    await Promise.resolve();
    await Promise.resolve();
    queue.dispose();
    queue.activate();
    let releaseCurrentPreparation!: (value: {
      images: ComposerImageAttachment[];
      error: null;
    }) => void;
    const currentJob = queue.enqueue({
      files: [new File(["new"], "new.png", { type: "image/png" })],
      existingAttachmentCount: () => images.length,
      commitImages: (prepared) => {
        images.push(...prepared);
        return prepared.length;
      },
      onError: () => {},
      prepareFiles: () => new Promise((resolve) => (releaseCurrentPreparation = resolve)),
    });
    await Promise.resolve();
    await Promise.resolve();

    releasePreparation({ images: [preparedImage("old")], error: null });
    await staleJob;
    expect(images).toEqual([]);
    expect(queue.pendingCount()).toBe(1);

    releaseCurrentPreparation({ images: [preparedImage("new")], error: null });
    await Promise.all([currentJob, queue.waitForPending()]);
    expect(images.map((image) => image.name)).toEqual(["new.png"]);
    expect(queue.pendingCount()).toBe(0);
  });
});
