import { describe, expect, it, vi, afterEach } from "vitest";

import {
  isLikelyDroppedDirectory,
  resolveDroppedFileAbsolutePath,
  splitDroppedComposerFiles,
} from "./composerDropPaths";

function makeFile(name: string, options?: { type?: string; size?: number }): File {
  const size = options?.size ?? 0;
  const type = options?.type ?? "";
  const blob = new Blob([size > 0 ? "x".repeat(size) : ""], { type });
  return new File([blob], name, { type });
}

describe("composerDropPaths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves absolute paths via the desktop bridge", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getPathForFile: (file: File) => `/Users/me/Mac (2)/${file.name}`,
      },
    });
    const file = makeFile("Docs");
    expect(resolveDroppedFileAbsolutePath(file)).toBe("/Users/me/Mac (2)/Docs");
  });

  it("returns null when the desktop bridge is unavailable", () => {
    vi.stubGlobal("window", {});
    expect(resolveDroppedFileAbsolutePath(makeFile("Docs"))).toBeNull();
  });

  it("treats zero-size empty-type drops with a path as directories (#351)", () => {
    expect(
      isLikelyDroppedDirectory(makeFile("project-space", { size: 0, type: "" }), "/tmp/a b/dir"),
    ).toBe(true);
    expect(
      isLikelyDroppedDirectory(
        makeFile("notes.txt", { size: 12, type: "text/plain" }),
        "/tmp/a b/notes.txt",
      ),
    ).toBe(false);
  });

  it("splits directory drops into path mentions and keeps regular files as attachments", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getPathForFile: (file: File) => {
          if (file.name === "project-space") {
            return "/Users/me/Happy Dropbox/Mac (2)/project-space";
          }
          return `/Users/me/${file.name}`;
        },
      },
    });
    const folder = makeFile("project-space", { size: 0, type: "" });
    const image = makeFile("shot.png", { size: 32, type: "image/png" });
    const doc = makeFile("readme.md", { size: 16, type: "text/markdown" });

    const split = splitDroppedComposerFiles([folder, image, doc]);
    expect(split.pathMentions).toEqual(["/Users/me/Happy Dropbox/Mac (2)/project-space"]);
    expect(split.imageFiles.map((file) => file.name)).toEqual(["shot.png"]);
    expect(split.genericFiles.map((file) => file.name)).toEqual(["readme.md"]);
  });
});
