// FILE: fileManagerNaming.test.ts
// Purpose: Locks the pure per-platform file-manager presentation for folders
//          and files on macOS, Windows, Linux, and unknown platforms.
// Layer: Web UI helper tests

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveFileManagerActionLabel,
  resolveFileManagerErrorDescription,
  resolveFileManagerErrorTitle,
  resolveFileManagerName,
  resolveFileManagerPresentation,
} from "./fileManagerNaming";

const MAC = "MacIntel";
const WINDOWS = "Win32";
const LINUX = "Linux x86_64";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveFileManagerPresentation", () => {
  it.each([
    [MAC, "folder", "Finder", "Open in Finder", "Unable to open in Finder"],
    [MAC, "file", "Finder", "Reveal in Finder", "Unable to reveal in Finder"],
    [WINDOWS, "folder", "Explorer", "Open in Explorer", "Unable to open in Explorer"],
    [WINDOWS, "file", "Explorer", "Show in Explorer", "Unable to show in Explorer"],
    [LINUX, "folder", "File manager", "Open folder", "Unable to open folder"],
    [LINUX, "file", "File manager", "Show in folder", "Unable to show in folder"],
    ["Plan9", "folder", "File manager", "Open folder", "Unable to open folder"],
    ["", "file", "File manager", "Show in folder", "Unable to show in folder"],
  ] as const)(
    "%s %s uses the expected application, action, and error copy",
    (platform, kind, managerName, actionLabel, errorTitle) => {
      expect(resolveFileManagerPresentation(kind, platform)).toEqual({
        managerName,
        actionLabel,
        errorTitle,
        fallbackDescription:
          kind === "folder"
            ? "The folder could not be opened."
            : "The file could not be shown in its folder.",
      });
    },
  );

  it("reads navigator.platform when no platform is given", () => {
    vi.stubGlobal("navigator", { platform: WINDOWS });
    expect(resolveFileManagerName()).toBe("Explorer");
  });

  it("falls back safely when navigator is unavailable", () => {
    vi.stubGlobal("navigator", undefined);
    expect(resolveFileManagerName()).toBe("File manager");
    expect(resolveFileManagerActionLabel("file")).toBe("Show in folder");
  });

  it("never mentions Finder off macOS or Explorer off Windows", () => {
    for (const kind of ["file", "folder"] as const) {
      expect(resolveFileManagerActionLabel(kind, WINDOWS)).not.toMatch(/finder/i);
      expect(resolveFileManagerActionLabel(kind, LINUX)).not.toMatch(/finder|explorer/i);
      expect(resolveFileManagerActionLabel(kind, MAC)).not.toMatch(/explorer/i);
      expect(resolveFileManagerErrorTitle(kind, WINDOWS)).not.toMatch(/finder/i);
      expect(resolveFileManagerErrorTitle(kind, LINUX)).not.toMatch(/finder|explorer/i);
      expect(resolveFileManagerErrorTitle(kind, MAC)).not.toMatch(/explorer/i);
    }
  });
});

describe("resolveFileManagerErrorTitle", () => {
  it.each([
    [MAC, "folder", "Unable to open in Finder"],
    [MAC, "file", "Unable to reveal in Finder"],
    [WINDOWS, "folder", "Unable to open in Explorer"],
    [WINDOWS, "file", "Unable to show in Explorer"],
    [LINUX, "folder", "Unable to open folder"],
    [LINUX, "file", "Unable to show in folder"],
  ] as const)("%s %s -> %s", (platform, kind, expected) => {
    expect(resolveFileManagerErrorTitle(kind, platform)).toBe(expected);
  });
});

describe("resolveFileManagerErrorDescription", () => {
  it("preserves useful messages from Error, string, and serialized error objects", () => {
    expect(
      resolveFileManagerErrorDescription(new Error("File or folder not found: /x"), "file"),
    ).toBe("File or folder not found: /x");
    expect(
      resolveFileManagerErrorDescription("The desktop connection is not available yet.", "folder"),
    ).toBe("The desktop connection is not available yet.");
    expect(resolveFileManagerErrorDescription({ message: "Serialized failure" }, "file")).toBe(
      "Serialized failure",
    );
  });

  it.each([
    [new Error("   "), "folder", "The folder could not be opened."],
    ["", "file", "The file could not be shown in its folder."],
    [{ message: "  " }, "file", "The file could not be shown in its folder."],
    [{ custom: 123 }, "folder", "The folder could not be opened."],
    [null, "folder", "The folder could not be opened."],
    [undefined, "file", "The file could not be shown in its folder."],
  ] as const)("uses neutral fallback copy for an unusable error", (error, kind, expected) => {
    expect(resolveFileManagerErrorDescription(error, kind)).toBe(expected);
  });
});
