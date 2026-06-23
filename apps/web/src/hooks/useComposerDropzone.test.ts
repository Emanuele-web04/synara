// FILE: useComposerDropzone.test.ts
// Purpose: Covers file capability decisions for shared composer paste/drop handling.
// Layer: Web hook tests

import { describe, expect, it } from "vitest";

import {
  shouldPreventDefaultForUnhandledFileDrop,
  shouldResetComposerDropzoneAfterUnhandledFileDrop,
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

  it("resets drag state for unusable file drops", () => {
    const files = splitComposerDropzoneFiles([]);

    expect(shouldResetComposerDropzoneAfterUnhandledFileDrop(files, "accept")).toBe(true);
  });

  it("prevents default for claimed unusable file drops", () => {
    const files = splitComposerDropzoneFiles([]);

    expect(shouldPreventDefaultForUnhandledFileDrop(files, "accept")).toBe(true);
    expect(shouldPreventDefaultForUnhandledFileDrop(files, "reject")).toBe(true);
    expect(shouldPreventDefaultForUnhandledFileDrop(files, "fallthrough")).toBe(false);
  });
});
