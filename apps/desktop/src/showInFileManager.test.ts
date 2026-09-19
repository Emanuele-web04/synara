// FILE: showInFileManager.test.ts
// Purpose: Proves the desktop:show-in-folder handler opens folders with
//          shell.openPath and reveals files with shell.showItemInFolder, and that
//          failures surface as user-readable errors.
// Layer: Desktop main-process helper tests

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showPathInFileManager, type FileManagerShell } from "./showInFileManager";

let tempDir = "";
let shell: { openPath: ReturnType<typeof vi.fn>; showItemInFolder: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  tempDir = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "synara-show-in-file-manager-"));
  shell = {
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
  };
});

afterEach(async () => {
  await FS.promises.rm(tempDir, { recursive: true, force: true });
});

function asShell(): FileManagerShell {
  return shell as unknown as FileManagerShell;
}

describe("showPathInFileManager", () => {
  it("opens an existing folder with shell.openPath and never reveals it", async () => {
    const folderPath = Path.join(tempDir, "Project Folder");
    await FS.promises.mkdir(folderPath);

    await expect(showPathInFileManager(folderPath, asShell())).resolves.toBeUndefined();

    expect(shell.openPath).toHaveBeenCalledTimes(1);
    expect(shell.openPath).toHaveBeenCalledWith(Path.resolve(folderPath));
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals an existing file with shell.showItemInFolder instead of launching it", async () => {
    const filePath = Path.join(tempDir, "output video.mp4");
    await FS.promises.writeFile(filePath, "");

    await expect(showPathInFileManager(filePath, asShell())).resolves.toBeUndefined();

    expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(Path.resolve(filePath));
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("resolves relative paths before handing them to the shell", async () => {
    const folderPath = Path.join(tempDir, "relative folder");
    await FS.promises.mkdir(folderPath);
    const relativePath = Path.relative(process.cwd(), folderPath);

    await showPathInFileManager(relativePath, asShell());

    const expected = Path.resolve(relativePath);
    expect(shell.openPath).toHaveBeenCalledWith(expected);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reports a missing path with the resolved location", async () => {
    const missingPath = Path.join(tempDir, "does-not-exist");

    await expect(showPathInFileManager(missingPath, asShell())).rejects.toThrow(
      `File or folder not found: ${Path.resolve(missingPath)}`,
    );

    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, "", "   "])(
    "rejects an empty or non-string path (%j)",
    async (rawPath) => {
      await expect(showPathInFileManager(rawPath, asShell())).rejects.toThrow(
        "Missing file or folder path.",
      );

      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it("surfaces the shell's own message when opening a folder fails", async () => {
    const folderPath = Path.join(tempDir, "locked");
    await FS.promises.mkdir(folderPath);
    shell.openPath.mockResolvedValue("Failed to open path");

    await expect(showPathInFileManager(folderPath, asShell())).rejects.toThrow(
      "Failed to open path",
    );

    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("preserves HEAD semantics by treating a whitespace-only shell message as failure", async () => {
    const folderPath = Path.join(tempDir, "whitespace-failure");
    await FS.promises.mkdir(folderPath);
    shell.openPath.mockResolvedValue("   ");

    await expect(showPathInFileManager(folderPath, asShell())).rejects.toMatchObject({
      message: "   ",
    });
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("propagates a file reveal failure without trying to open the file", async () => {
    const filePath = Path.join(tempDir, "locked.txt");
    await FS.promises.writeFile(filePath, "");
    shell.showItemInFolder.mockImplementation(() => {
      throw new Error("Reveal failed");
    });

    await expect(showPathInFileManager(filePath, asShell())).rejects.toThrow("Reveal failed");

    expect(shell.openPath).not.toHaveBeenCalled();
  });
});
