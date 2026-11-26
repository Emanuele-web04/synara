// FILE: composerDropPaths.test.ts
// Purpose: Guard native file classification and editor path payload parsing.
// Layer: Web utility regressions; desktop bridge access is isolated per test.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasDroppedPathReferenceTypes,
  isDroppedComposerDirectory,
  readDroppedPathReferences,
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

const transfer = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (type: string) => data[type] ?? "",
});

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

  describe("editor path-reference drags", () => {
    it("ignores path-reference drags outside the desktop app", () => {
      vi.stubGlobal("window", {});

      expect(hasDroppedPathReferenceTypes(["text/uri-list"])).toBe(false);
      expect(
        readDroppedPathReferences(transfer({ "text/uri-list": "file:///Users/me/a" })),
      ).toEqual([]);
    });

    it("reads folder paths from codefiles before the uri list", () => {
      vi.stubGlobal("window", { desktopBridge: {} });

      expect(
        readDroppedPathReferences(
          transfer({
            codefiles: JSON.stringify(["/Users/me/repo/.codex", "/Users/me/repo/.codex"]),
            "text/uri-list": "file:///ignored",
          }),
        ),
      ).toEqual(["/Users/me/repo/.codex"]);
    });

    it("decodes file URLs from a uri list and skips other schemes", () => {
      vi.stubGlobal("window", { desktopBridge: {} });

      expect(
        readDroppedPathReferences(
          transfer({
            "text/uri-list": [
              "# comment",
              "file:///Users/me/My%20Repo/src",
              "https://example.com/page",
              "file:///C:/work/app",
            ].join("\r\n"),
          }),
        ),
      ).toEqual(["/Users/me/My Repo/src", "C:/work/app"]);
    });

    it("returns nothing for a web link drag", () => {
      vi.stubGlobal("window", { desktopBridge: {} });

      expect(
        readDroppedPathReferences(transfer({ "text/uri-list": "https://example.com" })),
      ).toEqual([]);
    });

    it("accepts only absolute filesystem paths from untrusted editor payloads", () => {
      vi.stubGlobal("window", { desktopBridge: {} });

      expect(
        readDroppedPathReferences(
          transfer({
            codefiles: JSON.stringify([
              "/repo/src",
              "C:\\work\\app",
              "\\\\server\\share\\src",
              "relative/src",
              "C:relative",
              "https://example.com",
              "/repo/invalid\0path",
              42,
            ]),
          }),
        ),
      ).toEqual(["/repo/src", "C:\\work\\app", "\\\\server\\share\\src"]);
    });

    it("rejects malformed editor data and falls back to valid local file URLs", () => {
      vi.stubGlobal("window", { desktopBridge: {} });

      expect(
        readDroppedPathReferences(
          transfer({
            codefiles: "{invalid JSON",
            "text/uri-list":
              "file:///repo/invalid%00path\nfile:///repo/%ZZ\nfile://server/share/src",
          }),
        ),
      ).toEqual(["//server/share/src"]);
    });
  });
});
