import { describe, expect, it, vi } from "vitest";

import { showInFileManager } from "./showInFileManager";

function makeShell(openPathError = "") {
  return {
    openPath: vi.fn(async (_path: string) => openPathError),
    showItemInFolder: vi.fn((_path: string) => {}),
  };
}

describe("showInFileManager", () => {
  it("reveals a macOS app bundle instead of opening it", async () => {
    const shell = makeShell();
    await showInFileManager("/Users/me/build/Report.app", true, "darwin", shell);
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith("/Users/me/build/Report.app");
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("still opens dotted folders and reveals files", async () => {
    const shell = makeShell();
    await showInFileManager("/Users/me/code/next.js", true, "darwin", shell);
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith("/Users/me/code/next.js");
    expect(shell.showItemInFolder).not.toHaveBeenCalled();

    await showInFileManager("/Users/me/code/next.js/package.json", false, "darwin", shell);
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
      "/Users/me/code/next.js/package.json",
    );
    expect(shell.openPath).toHaveBeenCalledOnce();
  });

  it("throws a non-empty openPath error message", async () => {
    const shell = makeShell("No application knows how to open it.");
    await expect(showInFileManager("/Users/me/code", true, "darwin", shell)).rejects.toThrow(
      "No application knows how to open it.",
    );
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("preserves existing whitespace-only openPath success behavior", async () => {
    const shell = makeShell("   ");
    await expect(
      showInFileManager("/Users/me/code", true, "darwin", shell),
    ).resolves.toBeUndefined();
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith("/Users/me/code");
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});
