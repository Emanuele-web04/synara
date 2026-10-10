import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { configure, renderHook } from "vitest-browser-react/pure";

import type { ComposerImageAttachment } from "../composerDraftStore";
import { useComposerImageIntake } from "./useComposerImageIntake";

describe("composer image intake lifecycle", () => {
  it("accepts clipboard images after the StrictMode mount cleanup", async () => {
    const images: ComposerImageAttachment[] = [];
    const errors: Array<string | null> = [];
    configure({ reactStrictMode: true });
    const hook = await renderHook(() =>
      useComposerImageIntake({
        threadId: ThreadId.makeUnsafe("hub-coordinator"),
        existingAttachmentCount: () => images.length,
        commitImages: (prepared) => {
          images.push(...prepared);
          return prepared.length;
        },
        onError: (error) => errors.push(error),
      }),
    );
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG encode failed"))));
      });
      const file = new File([blob], "clipboard.png", { type: "image/png" });
      hook.result.current.addImages([file]);
      await hook.result.current.waitForPending();

      expect(images.map((image) => image.name)).toEqual(["clipboard.png"]);
      expect(images[0]?.file).toBe(file);
      expect(errors).toEqual([null]);
      expect(hook.result.current.pendingImageCount).toBe(0);
    } finally {
      await hook.unmount();
      configure({ reactStrictMode: false });
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
    }
  });
});
