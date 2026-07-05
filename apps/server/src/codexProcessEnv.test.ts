import { describe, expect, it, vi } from "vitest";

import { linkOrCopyCodexOverlayEntry } from "./codexProcessEnv";

describe("linkOrCopyCodexOverlayEntry", () => {
  it("copies auth.json when symlink creation is unavailable", () => {
    const symlink = vi.fn(() => {
      throw new Error("symlinks unavailable");
    });
    const copyFile = vi.fn();

    linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
        type: "file",
      },
      { symlink, copyFile },
    );

    expect(symlink).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
      "file",
    );
    expect(copyFile).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
    );
  });

  it("keeps symlink failures visible for other overlay entries", () => {
    const symlink = vi.fn(() => {
      throw new Error("symlinks unavailable");
    });

    expect(() =>
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn() },
      ),
    ).toThrow("symlinks unavailable");
  });
});
