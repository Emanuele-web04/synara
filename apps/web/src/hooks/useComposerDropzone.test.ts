// FILE: useComposerDropzone.test.ts
// Purpose: Covers file capability decisions for shared composer paste/drop handling.
// Layer: Web hook tests

import { describe, expect, it } from "vitest";

import {
  shouldHandleComposerDropzoneFiles,
  splitComposerDropzoneFiles,
} from "./useComposerDropzone";

describe("useComposerDropzone file capability helpers", () => {
  it("splits image files from generic files", () => {
    const image = new File(["image"], "image.png", { type: "image/png" });
    const generic = new File(["text"], "notes.txt", { type: "text/plain" });

    expect(splitComposerDropzoneFiles([image, generic])).toEqual({
      imageFiles: [image],
      genericFiles: [generic],
    });
  });

  it("lets unsupported generic-only files fall through when requested", () => {
    const generic = new File(["text"], "notes.txt", { type: "text/plain" });
    const files = splitComposerDropzoneFiles([generic]);

    expect(shouldHandleComposerDropzoneFiles(files, "fallthrough")).toBe(false);
  });

  it("handles generic-only files when the consumer rejects them visibly", () => {
    const generic = new File(["text"], "notes.txt", { type: "text/plain" });
    const files = splitComposerDropzoneFiles([generic]);

    expect(shouldHandleComposerDropzoneFiles(files, "reject")).toBe(true);
  });
});
