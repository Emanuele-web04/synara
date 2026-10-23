// FILE: fileReferenceContextMenu.test.ts
// Purpose: Verifies file-reference menu labels and desktop reveal/copy actions.
// Layer: Web UI helper tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clicked: null as string | null,
  copyText: vi.fn(),
  showContextMenu: vi.fn(),
  showInFolder: vi.fn(),
  readFile: vi.fn(),
  copyContents: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: harness.copyText,
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    contextMenu: { show: harness.showContextMenu },
    shell: { showInFolder: harness.showInFolder },
    projects: { readFile: harness.readFile },
  }),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toast },
}));

import { showFileReferenceContextMenu } from "./fileReferenceContextMenu";

beforeEach(() => {
  vi.stubGlobal("window", { desktopBridge: {} });
  vi.stubGlobal("navigator", { platform: "Win32" });
  harness.clicked = null;
  harness.copyText.mockReset();
  harness.showContextMenu.mockReset();
  harness.showInFolder.mockReset();
  harness.readFile.mockReset();
  harness.copyContents.mockReset();
  harness.toast.mockReset();
  harness.showContextMenu.mockImplementation(async () => harness.clicked);
  harness.copyText.mockResolvedValue(undefined);
  harness.showInFolder.mockResolvedValue(undefined);
  harness.readFile.mockResolvedValue({ contents: "export const answer = 42;\n", truncated: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("showFileReferenceContextMenu", () => {
  it("offers reveal before copy when an absolute reveal path is available", async () => {
    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [
        { id: "reveal-in-folder", label: "Open in Explorer" },
        { id: "copy-path", label: "Copy path" },
      ],
      { x: 12, y: 34 },
    );
  });

  it("hides the desktop-only reveal action in the browser", async () => {
    vi.stubGlobal("window", {});

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [{ id: "copy-path", label: "Copy path" }],
      { x: 12, y: 34 },
    );
  });

  it("reveals the requested file through the desktop shell", async () => {
    harness.clicked = "reveal-in-folder";

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.showInFolder).toHaveBeenCalledWith("/repo/output/video.mp4");
    expect(harness.copyText).not.toHaveBeenCalled();
  });

  it("reports a stale file without leaking the shell rejection", async () => {
    harness.clicked = "reveal-in-folder";
    harness.showInFolder.mockRejectedValue(new Error("Folder not found: /repo/output/video.mp4"));

    await expect(
      showFileReferenceContextMenu({
        path: "/repo/output/video.mp4",
        revealPath: "/repo/output/video.mp4",
        position: { x: 12, y: 34 },
        onReferenceInChat: undefined,
      }),
    ).resolves.toBeUndefined();

    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to reveal file",
      description: "Folder not found: /repo/output/video.mp4",
    });
  });

  it("copies the displayed filesystem path with the shared clipboard fallback", async () => {
    harness.clicked = "copy-path";

    await showFileReferenceContextMenu({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 12, y: 34 },
      onReferenceInChat: undefined,
    });

    expect(harness.copyText).toHaveBeenCalledWith("/repo/output/video.mp4");
    expect(harness.showInFolder).not.toHaveBeenCalled();
  });

  it("groups explorer copy variants without reading a file just to open the menu", async () => {
    vi.stubGlobal("window", {});
    await showFileReferenceContextMenu({
      path: "src/app.ts",
      workspaceRoot: "/repo",
      kind: "file",
      onCopyFileContents: harness.copyContents,
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.showContextMenu).toHaveBeenCalledWith(
      [
        {
          id: "copy",
          label: "Copy",
          children: [
            { id: "copy-path", label: "Relative path" },
            { id: "copy-absolute-path", label: "Absolute path" },
            { id: "copy-file-content", label: "File content" },
          ],
        },
      ],
      { x: 1, y: 2 },
    );
    expect(harness.readFile).not.toHaveBeenCalled();
  });

  it.each([
    ["/repo/", "/repo/src/app.ts"],
    ["/", "/src/app.ts"],
    ["C:\\repo\\", "C:\\repo\\src\\app.ts"],
    ["\\\\server\\share", "\\\\server\\share\\src\\app.ts"],
  ])(
    "copies an absolute path with the workspace's separator style: %s",
    async (workspaceRoot, expected) => {
      harness.clicked = "copy-absolute-path";
      await showFileReferenceContextMenu({
        path: "src/app.ts",
        workspaceRoot,
        kind: "file",
        position: { x: 1, y: 2 },
        onReferenceInChat: undefined,
      });
      expect(harness.copyText).toHaveBeenCalledWith(expected);
      expect(harness.readFile).not.toHaveBeenCalled();
    },
  );

  it("keeps relative path copy unchanged inside the submenu", async () => {
    harness.clicked = "copy-path";
    await showFileReferenceContextMenu({
      path: "src/app.ts",
      workspaceRoot: "/repo",
      kind: "file",
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.copyText).toHaveBeenCalledWith("src/app.ts");
  });

  it("copies fresh file contents through the workspace-scoped secure read API", async () => {
    harness.clicked = "copy-file-content";
    await showFileReferenceContextMenu({
      path: "src/app.ts",
      workspaceRoot: "/repo",
      kind: "file",
      onCopyFileContents: harness.copyContents,
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.readFile).toHaveBeenCalledWith({ cwd: "/repo", relativePath: "src/app.ts" });
    expect(harness.copyContents).toHaveBeenCalledWith("export const answer = 42;\n", "src/app.ts", {
      partial: false,
    });
  });

  it("passes truncation through to the existing partial-copy warning", async () => {
    harness.clicked = "copy-file-content";
    harness.readFile.mockResolvedValue({ contents: "first bytes", truncated: true });
    await showFileReferenceContextMenu({
      path: "large.txt",
      workspaceRoot: "/repo",
      kind: "file",
      onCopyFileContents: harness.copyContents,
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.copyContents).toHaveBeenCalledWith("first bytes", "large.txt", {
      partial: true,
    });
  });

  it("reports permission, missing-file, and binary read failures without copying", async () => {
    harness.clicked = "copy-file-content";
    harness.readFile.mockRejectedValue(new Error("File is not a readable workspace text file."));
    await expect(
      showFileReferenceContextMenu({
        path: "src/app.ts",
        workspaceRoot: "/repo",
        kind: "file",
        onCopyFileContents: harness.copyContents,
        position: { x: 1, y: 2 },
        onReferenceInChat: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(harness.copyContents).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to copy file content",
      description: "File is not a readable workspace text file.",
    });
  });

  it("offers only path copy for folders, even if content-copy is requested by the API", async () => {
    harness.clicked = "copy-file-content";
    await showFileReferenceContextMenu({
      path: "src",
      workspaceRoot: "/repo",
      kind: "directory",
      onCopyFileContents: harness.copyContents,
      position: { x: 1, y: 2 },
      onReferenceInChat: undefined,
    });
    expect(harness.showContextMenu.mock.calls[0]?.[0][0].children).toEqual([
      { id: "copy-path", label: "Relative path" },
      { id: "copy-absolute-path", label: "Absolute path" },
    ]);
    expect(harness.readFile).not.toHaveBeenCalled();
  });

  it.each(["../outside.txt", "src/../../outside.txt", "/outside.txt", "C:\\outside.txt"])(
    "does not offer workspace read or derive an absolute path for unsafe references: %s",
    async (path) => {
      harness.clicked = "copy-file-content";
      await showFileReferenceContextMenu({
        path,
        workspaceRoot: "/repo",
        kind: "file",
        onCopyFileContents: harness.copyContents,
        position: { x: 1, y: 2 },
        onReferenceInChat: undefined,
      });
      expect(harness.showContextMenu.mock.calls[0]?.[0]).toEqual([
        { id: "copy-path", label: "Copy path" },
      ]);
      expect(harness.readFile).not.toHaveBeenCalled();
    },
  );

  it("preserves file-reference selections and Ask why actions", async () => {
    const onReferenceInChat = vi.fn();
    const onAskWhyInChat = vi.fn();
    const input = {
      path: "src/app.ts",
      workspaceRoot: "/repo",
      kind: "file" as const,
      selection: { startLine: 3, endLine: 4, startColumn: 1, endColumn: 8 },
      position: { x: 1, y: 2 },
      onReferenceInChat,
      onAskWhyInChat,
    };
    harness.clicked = "reference-in-chat";
    await showFileReferenceContextMenu(input);
    expect(onReferenceInChat).toHaveBeenCalledWith({ path: input.path, ...input.selection });
    harness.clicked = "ask-why-in-chat";
    await showFileReferenceContextMenu(input);
    expect(onAskWhyInChat).toHaveBeenCalledWith({ path: input.path, ...input.selection });
    expect(harness.readFile).not.toHaveBeenCalled();
  });

  it("reports clipboard rejection rather than leaking an unhandled menu action", async () => {
    harness.clicked = "copy-path";
    harness.copyText.mockRejectedValue(new Error("Clipboard blocked"));
    await expect(
      showFileReferenceContextMenu({
        path: "src/app.ts",
        position: { x: 1, y: 2 },
        onReferenceInChat: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to copy path",
      description: "Clipboard blocked",
    });
  });
});
