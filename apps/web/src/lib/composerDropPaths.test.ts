import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isDroppedComposerDirectory,
  resolveDroppedFileAbsolutePath,
  splitDroppedComposerFiles,
  type ComposerDroppedFileItem,
} from "./composerDropPaths";

function makeFile(name: string, options?: { type?: string; size?: number }): File {
  const size = options?.size ?? 0;
  const type = options?.type ?? "";
  const blob = new Blob([size > 0 ? "x".repeat(size) : ""], { type });
  return new File([blob], name, { type });
}

function makeItem(file: File, options?: { directory?: boolean; entryUnavailable?: boolean }) {
  return {
    kind: "file",
    getAsFile: () => file,
    ...(options?.entryUnavailable
      ? {}
      : { webkitGetAsEntry: () => ({ isDirectory: options?.directory === true }) }),
  } satisfies ComposerDroppedFileItem;
}

describe("composerDropPaths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves absolute paths via the desktop bridge without rewriting path bytes", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getPathForFile: () => " /Users/me/Mac (2)/Docs ",
      },
    });

    expect(resolveDroppedFileAbsolutePath(makeFile("Docs"))).toBe(" /Users/me/Mac (2)/Docs ");
  });

  it("returns null when the desktop bridge is unavailable or returns only whitespace", () => {
    vi.stubGlobal("window", {});
    expect(resolveDroppedFileAbsolutePath(makeFile("Docs"))).toBeNull();

    vi.stubGlobal("window", { desktopBridge: { getPathForFile: () => "   " } });
    expect(resolveDroppedFileAbsolutePath(makeFile("Docs"))).toBeNull();
  });

  it("identifies directories from the drag entry instead of file size or MIME type", () => {
    const emptyFile = makeFile(".gitkeep");

    expect(isDroppedComposerDirectory(makeItem(emptyFile, { directory: true }))).toBe(true);
    expect(isDroppedComposerDirectory(makeItem(emptyFile))).toBe(false);
    expect(isDroppedComposerDirectory(makeItem(emptyFile, { entryUnavailable: true }))).toBe(false);
  });

  it("splits explicit directory drops into mentions and keeps normal files as attachments", () => {
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
    const folder = makeFile("project-space");
    const image = makeFile("shot.png", { size: 32, type: "image/png" });
    const doc = makeFile("readme.md", { size: 16, type: "text/markdown" });

    const split = splitDroppedComposerFiles({
      files: [folder, image, doc],
      items: [makeItem(folder, { directory: true }), makeItem(image), makeItem(doc)],
    });
    expect(split.pathMentions).toEqual(["/Users/me/Happy Dropbox/Mac (2)/project-space"]);
    expect(split.imageFiles).toEqual([image]);
    expect(split.genericFiles).toEqual([doc]);
  });

  it("keeps genuine empty files when directory metadata is absent", () => {
    vi.stubGlobal("window", {
      desktopBridge: { getPathForFile: () => "/Users/me/.gitkeep" },
    });
    const emptyFile = makeFile(".gitkeep");

    expect(
      splitDroppedComposerFiles({
        files: [emptyFile],
        items: [makeItem(emptyFile, { entryUnavailable: true })],
      }),
    ).toEqual({ pathMentions: [], imageFiles: [], genericFiles: [emptyFile] });
  });

  it("falls back to the FileList when drag items are unavailable", () => {
    const emptyFile = makeFile("empty");

    expect(splitDroppedComposerFiles({ files: [emptyFile] })).toEqual({
      pathMentions: [],
      imageFiles: [],
      genericFiles: [emptyFile],
    });
  });
});
