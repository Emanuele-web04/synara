import { describe, expect, it } from "vitest";

import {
  SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX,
  SUPPORTED_LOCAL_VIDEO_EXTENSIONS,
  SUPPORTED_LOCAL_VIDEO_EXTENSION_REGEX,
  isSupportedLocalImagePath,
  isSupportedLocalPdfPath,
  isSupportedLocalPreviewFilePath,
  isSupportedLocalVideoPath,
} from "./localPreviewFiles";

describe("local preview file allowlist", () => {
  it("accepts every supported video container case-insensitively", () => {
    for (const extension of SUPPORTED_LOCAL_VIDEO_EXTENSIONS) {
      expect(isSupportedLocalVideoPath(`/tmp/clip${extension}`)).toBe(true);
      expect(isSupportedLocalVideoPath(`/tmp/CLIP${extension.toUpperCase()}`)).toBe(true);
      expect(SUPPORTED_LOCAL_VIDEO_EXTENSION_REGEX.test(`out/clip${extension}`)).toBe(true);
      expect(isSupportedLocalPreviewFilePath(`out/clip${extension}`)).toBe(true);
    }
    expect(isSupportedLocalVideoPath("clip.mkv")).toBe(false);
    expect(isSupportedLocalVideoPath("clip.mp4.txt")).toBe(false);
    expect(SUPPORTED_LOCAL_VIDEO_EXTENSION_REGEX.test("clip.mp4.txt")).toBe(false);
  });

  it("keeps images, videos and PDFs disjoint", () => {
    expect(isSupportedLocalImagePath("clip.mp4")).toBe(false);
    expect(SUPPORTED_LOCAL_IMAGE_EXTENSION_REGEX.test("clip.mp4")).toBe(false);
    expect(isSupportedLocalVideoPath("shot.png")).toBe(false);
    expect(isSupportedLocalVideoPath("spec.pdf")).toBe(false);
    expect(isSupportedLocalPdfPath("clip.mov")).toBe(false);
  });

  it("serves only the allowlisted preview kinds", () => {
    expect(isSupportedLocalPreviewFilePath("shot.png")).toBe(true);
    expect(isSupportedLocalPreviewFilePath("spec.pdf")).toBe(true);
    expect(isSupportedLocalPreviewFilePath("notes.txt")).toBe(false);
    expect(isSupportedLocalPreviewFilePath("/etc/hosts")).toBe(false);
  });
});
