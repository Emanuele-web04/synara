// FILE: WorkspaceFilePreview.editing.browser.tsx
// Purpose: Browser regressions for guarded Explorer editing and save-state UX.
// Layer: Focused component integration tests

import "../index.css";

import type {
  NativeApi,
  ProjectFileChangeEvent,
  ProjectReadFileResult,
  ProjectWatchFileInput,
} from "@synara/contracts";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent, type Locator } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render, cleanup } from "vitest-browser-react";

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const WORKSPACE_ROOT = "/Users/tester/project";
const FILE_PATH = "src/app.ts";
const LOADED_VERSION = `sha256:${"1".repeat(64)}`;
const SAVED_VERSION = `sha256:${"2".repeat(64)}`;

function installNativeApi(api: NativeApi): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: api,
  });
  return () => {
    if (previousDescriptor) {
      Object.defineProperty(window, "nativeApi", previousDescriptor);
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function loadedFile(overrides: Partial<ProjectReadFileResult> = {}): ProjectReadFileResult {
  return {
    relativePath: FILE_PATH,
    contents: "export const value = 1;\n",
    truncated: false,
    version: LOADED_VERSION,
    encoding: "utf8",
    lineEnding: "lf",
    ...overrides,
  };
}

const primaryModifier = /Mac/.test(navigator.platform) ? "Meta" : "Control";

function shortcut(key: string): string {
  return `{${primaryModifier}>}${key}{/${primaryModifier}}`;
}

async function replaceEditorContents(editor: Locator, contents: string): Promise<void> {
  await editor.click();
  await userEvent.keyboard(shortcut("a"));
  // Fill replaces DOM text without updating Pierre's document; use native input.
  await userEvent.keyboard(
    contents ? contents.replace(/[{[]/g, "$&$&").replace(/\n/g, "{Enter}") : "{Backspace}",
  );
}

function pressKeyboardSave(element: Element): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

afterEach(async () => {
  await cleanup();
});

it("requests only the resolved preview file for gutters and refreshes it on file events", async () => {
  const resolvedPath = "packages/app/src/app.ts";
  const readFile = vi.fn().mockResolvedValue(loadedFile({ relativePath: resolvedPath }));
  const readWorkingTreeDiff = vi.fn().mockResolvedValue({ patch: "" });
  const subscription: { listener?: (event: ProjectFileChangeEvent) => void } = {};
  const onFileChange = vi.fn(
    (_input: ProjectWatchFileInput, listener: (event: ProjectFileChangeEvent) => void) => {
      subscription.listener = listener;
      return () => undefined;
    },
  );
  const restoreNativeApi = installNativeApi({
    projects: { readFile, onFileChange },
    git: { readWorkingTreeDiff },
  } as unknown as NativeApi);
  try {
    const view = await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(readWorkingTreeDiff).toHaveBeenCalledTimes(1));
    expect(readWorkingTreeDiff).toHaveBeenLastCalledWith({
      cwd: WORKSPACE_ROOT,
      scope: "workingTree",
      filePath: resolvedPath,
    });
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));
    subscription.listener?.({ type: "changed", relativePath: resolvedPath, mtimeMs: Date.now() });
    await vi.waitFor(() => expect(readWorkingTreeDiff).toHaveBeenCalledTimes(2));
    expect(readWorkingTreeDiff).toHaveBeenLastCalledWith({
      cwd: WORKSPACE_ROOT,
      scope: "workingTree",
      filePath: resolvedPath,
    });
    await view.unmount();
  } finally {
    restoreNativeApi();
  }
});

it("tracks dirty state and saves the loaded version with Ctrl+S", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedFile());
  const writeFile = vi.fn().mockResolvedValue({ relativePath: FILE_PATH, version: SAVED_VERSION });
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toHaveTextContent("export const value = 1;");
    await replaceEditorContents(editor, "export const value = 2;\n");
    await expect.element(page.getByRole("status", { name: "Unsaved changes" })).toBeVisible();

    pressKeyboardSave(editor.element());

    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith({
        cwd: WORKSPACE_ROOT,
        relativePath: FILE_PATH,
        contents: "export const value = 2;\n",
        expectedVersion: LOADED_VERSION,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Unsaved changes"]')).toBeNull(),
    );
  } finally {
    restoreNativeApi();
  }
});

it("keeps the buffer dirty and shows guarded write failures", async () => {
  const conflictMessage =
    "This file changed on disk after it was opened. Reload it before saving to avoid overwriting those changes.";
  const readFile = vi.fn().mockResolvedValue(loadedFile());
  const writeFile = vi.fn().mockRejectedValue(new Error(conflictMessage));
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await replaceEditorContents(editor, "manual edit\n");
    pressKeyboardSave(editor.element());

    await expect.element(page.getByRole("alert")).toHaveTextContent(conflictMessage);
    await expect.element(page.getByRole("status", { name: "Unsaved changes" })).toBeVisible();
    await expect.element(editor).toHaveTextContent("manual edit");
    expect(writeFile).toHaveBeenCalledTimes(1);
  } finally {
    restoreNativeApi();
  }
});

it("revalidates on file events without overwriting a dirty edit buffer", async () => {
  const externalVersion = `sha256:${"4".repeat(64)}`;
  const externalFile = loadedFile({
    contents: "external edit\n",
    version: externalVersion,
  });
  const readFile = vi.fn().mockResolvedValueOnce(loadedFile()).mockResolvedValue(externalFile);
  const fileChangeSubscription: {
    listener?: (event: ProjectFileChangeEvent) => void;
  } = {};
  const unsubscribe = vi.fn();
  const onFileChange = vi.fn(
    (_input: ProjectWatchFileInput, callback: (event: ProjectFileChangeEvent) => void) => {
      fileChangeSubscription.listener = callback;
      return unsubscribe;
    },
  );
  const writeFile = vi.fn().mockResolvedValue({ relativePath: FILE_PATH, version: SAVED_VERSION });
  const restoreNativeApi = installNativeApi({
    projects: { readFile, onFileChange, writeFile },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toHaveTextContent("export const value = 1;");
    await replaceEditorContents(editor, "manual edit\n");
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));

    fileChangeSubscription.listener?.({
      type: "changed",
      relativePath: FILE_PATH,
      mtimeMs: Date.now(),
    });

    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await expect.element(editor).toHaveTextContent("manual edit");
    await expect
      .element(page.getByText("This file changed on disk. Your unsaved edits are preserved."))
      .toBeVisible();

    const reloadButton = document.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(reloadButton).not.toBeNull();
    reloadButton?.click();
    await expect.element(editor).toHaveTextContent("external edit");
    await replaceEditorContents(editor, "after reload\n");
    pressKeyboardSave(editor.element());
    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith({
        cwd: WORKSPACE_ROOT,
        relativePath: FILE_PATH,
        contents: "after reload\n",
        expectedVersion: externalVersion,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    );
  } finally {
    restoreNativeApi();
  }
});

it("stops revalidation when a kept-mounted preview becomes hidden", async () => {
  const unsubscribe = vi.fn();
  const onFileChange = vi.fn(() => unsubscribe);
  const restoreNativeApi = installNativeApi({
    projects: { readFile: vi.fn().mockResolvedValue(loadedFile()), onFileChange },
  } as unknown as NativeApi);
  const queryClient = makeQueryClient();

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("textbox", { name: `Edit ${FILE_PATH}` }))
      .toHaveTextContent("export const value = 1;");
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));

    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview
          workspaceRoot={WORKSPACE_ROOT}
          filePath={FILE_PATH}
          editable
          liveRevalidationEnabled={false}
        />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  } finally {
    restoreNativeApi();
  }
});

it("switches the watcher to a workspace path resolved by the file read", async () => {
  const resolvedPath = "packages/app/src/app.ts";
  const readFile = vi.fn().mockResolvedValue(loadedFile({ relativePath: resolvedPath }));
  const onFileChange = vi.fn(() => vi.fn());
  const restoreNativeApi = installNativeApi({
    projects: { readFile, onFileChange },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("textbox", { name: `Edit ${FILE_PATH}` }))
      .toHaveTextContent("export const value = 1;");
    await vi.waitFor(() =>
      expect(onFileChange).toHaveBeenLastCalledWith(
        { cwd: WORKSPACE_ROOT, relativePath: resolvedPath },
        expect.any(Function),
      ),
    );
  } finally {
    restoreNativeApi();
  }
});

it("preserves dirty edits when reloading the changed disk version fails", async () => {
  const externalFile = loadedFile({
    contents: "external edit\n",
    version: `sha256:${"5".repeat(64)}`,
  });
  const readFile = vi
    .fn()
    .mockResolvedValueOnce(loadedFile())
    .mockResolvedValueOnce(externalFile)
    .mockRejectedValueOnce(new Error("Transient read failure"));
  const fileChangeSubscription: {
    listener?: (event: ProjectFileChangeEvent) => void;
  } = {};
  const onFileChange = vi.fn(
    (_input: ProjectWatchFileInput, callback: (event: ProjectFileChangeEvent) => void) => {
      fileChangeSubscription.listener = callback;
      return vi.fn();
    },
  );
  const restoreNativeApi = installNativeApi({
    projects: { readFile, onFileChange },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toHaveTextContent("export const value = 1;");
    await replaceEditorContents(editor, "manual edit\n");
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));
    fileChangeSubscription.listener?.({
      type: "changed",
      relativePath: FILE_PATH,
      mtimeMs: Date.now(),
    });

    const reloadButton = page.getByRole("button", { name: "Reload from disk" });
    await expect.element(reloadButton).toBeVisible();
    await reloadButton.click();

    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(3));
    await expect.element(editor).toHaveTextContent("manual edit");
    await expect.element(page.getByText("Transient read failure")).toBeVisible();
    await expect.element(page.getByRole("status", { name: "Unsaved changes" })).toBeVisible();
  } finally {
    restoreNativeApi();
  }
});

it("keeps markdown task previews and guarded versions in sync after an editor save", async () => {
  const markdownPath = "README.md";
  const taskVersion = `sha256:${"3".repeat(64)}`;
  let completeTaskWrite!: (result: { relativePath: string; version: string }) => void;
  const pendingTaskWrite = new Promise<{ relativePath: string; version: string }>((resolve) => {
    completeTaskWrite = resolve;
  });
  const readFile = vi.fn().mockResolvedValue(
    loadedFile({
      relativePath: markdownPath,
      contents: "- [ ] task\n",
    }),
  );
  const writeFile = vi
    .fn()
    .mockResolvedValueOnce({ relativePath: markdownPath, version: SAVED_VERSION })
    .mockReturnValueOnce(pendingTaskWrite);
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={markdownPath} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${markdownPath}` });
    await replaceEditorContents(editor, "- [ ] updated task\n");
    pressKeyboardSave(editor.element());
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    await page.getByRole("radio", { name: "Preview" }).click();

    const checkbox = page.getByRole("checkbox");
    await checkbox.click();
    await expect.element(checkbox).toBeChecked();
    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenNthCalledWith(2, {
        cwd: WORKSPACE_ROOT,
        relativePath: markdownPath,
        contents: "- [x] updated task\n",
        expectedVersion: SAVED_VERSION,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    );
    completeTaskWrite({ relativePath: markdownPath, version: taskVersion });
  } finally {
    restoreNativeApi();
  }
});

it("keeps oversized and mixed-line-ending files read-only", async () => {
  const readFile = vi
    .fn()
    .mockResolvedValueOnce(
      loadedFile({ truncated: true, version: null, encoding: null, lineEnding: null }),
    )
    .mockResolvedValueOnce(loadedFile({ lineEnding: "mixed" }));
  const restoreNativeApi = installNativeApi({
    projects: { readFile },
  } as unknown as NativeApi);
  const queryClient = makeQueryClient();

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(document.body.textContent).toContain("Shown partially"));
    expect(document.querySelector("textarea")).toBeNull();

    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath="src/mixed.ts" editable />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Read-only"));
    expect(document.querySelector("textarea")).toBeNull();
  } finally {
    restoreNativeApi();
  }
});

it("keeps a successful save when an older watcher read resolves afterwards", async () => {
  let completeRead!: (result: ProjectReadFileResult) => void;
  const pendingRead = new Promise<ProjectReadFileResult>((resolve) => {
    completeRead = resolve;
  });
  const readFile = vi.fn().mockResolvedValueOnce(loadedFile()).mockReturnValueOnce(pendingRead);
  const writeFile = vi.fn().mockResolvedValue({ relativePath: FILE_PATH, version: SAVED_VERSION });
  const subscription: { listener?: (event: ProjectFileChangeEvent) => void } = {};
  const onFileChange = vi.fn(
    (_input: ProjectWatchFileInput, callback: (event: ProjectFileChangeEvent) => void) => {
      subscription.listener = callback;
      return vi.fn();
    },
  );
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile, onFileChange },
  } as unknown as NativeApi);
  const queryClient = makeQueryClient();
  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toHaveTextContent("export const value = 1;");
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));
    subscription.listener?.({ type: "changed", relativePath: FILE_PATH, mtimeMs: 1 });
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await replaceEditorContents(editor, "saved contents\n");
    pressKeyboardSave(editor.element());
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Unsaved changes"]')).toBeNull(),
    );
    completeRead(loadedFile());
    await pendingRead;
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await expect.element(editor).toHaveTextContent("saved contents");
    await replaceEditorContents(editor, "next saved contents\n");
    pressKeyboardSave(editor.element());
    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenNthCalledWith(2, {
        cwd: WORKSPACE_ROOT,
        relativePath: FILE_PATH,
        contents: "next saved contents\n",
        expectedVersion: SAVED_VERSION,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    );
  } finally {
    completeRead(loadedFile());
    queryClient.clear();
    restoreNativeApi();
  }
});

it("preserves unsaved Markdown edits across Preview and Source", async () => {
  const readFile = vi
    .fn()
    .mockResolvedValue(loadedFile({ relativePath: "README.md", contents: "original\n" }));
  const writeFile = vi
    .fn()
    .mockResolvedValue({ relativePath: "README.md", version: SAVED_VERSION });
  const restore = installNativeApi({ projects: { readFile, writeFile } } as unknown as NativeApi);
  try {
    await render(
      <StrictMode>
        <QueryClientProvider client={makeQueryClient()}>
          <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath="README.md" editable />
        </QueryClientProvider>
      </StrictMode>,
    );
    const editor = page.getByRole("textbox", { name: "Edit README.md" });
    await editor.click();
    await userEvent.keyboard(shortcut("a") + "unsaved");
    await expect.element(page.getByRole("status", { name: "Unsaved changes" })).toBeVisible();
    await expect.element(editor).toHaveTextContent("unsaved");
    await page.getByRole("radio", { name: "Preview", exact: true }).click();
    const editorShell = document.querySelector<HTMLElement>(".editor-file-editor__pierre")!;
    expect(getComputedStyle(editorShell).display).toBe("none");
    expect(editorShell.getBoundingClientRect().height).toBe(0);
    await page.getByRole("radio", { name: "Source", exact: true }).click();
    await expect.element(editor).toHaveTextContent("unsaved");
  } finally {
    restore();
  }
});

it("preserves edits and focus when a save completes while typing", async () => {
  let complete!: (v: { relativePath: string; version: string }) => void;
  const pending = new Promise<{ relativePath: string; version: string }>((r) => (complete = r));
  const readFile = vi.fn().mockResolvedValue(loadedFile());
  const writeFile = vi.fn().mockReturnValue(pending);
  const restore = installNativeApi({ projects: { readFile, writeFile } } as unknown as NativeApi);
  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await editor.click();
    await userEvent.keyboard(shortcut("a") + "first");
    await userEvent.keyboard(shortcut("s"));
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    await userEvent.keyboard("second");
    await expect.element(editor).toHaveTextContent("firstsecond");
    complete({ relativePath: FILE_PATH, version: SAVED_VERSION });
    await vi.waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    await expect.element(editor).toHaveTextContent("firstsecond");
    expect(editor.element().getRootNode()).toBeInstanceOf(ShadowRoot);
    expect((editor.element().getRootNode() as ShadowRoot).activeElement).toBe(editor.element());
    await userEvent.keyboard(shortcut("z"));
    await expect.element(editor).not.toHaveTextContent("firstsecond");
    await userEvent.keyboard(`{${primaryModifier}>}{Shift>}z{/Shift}{/${primaryModifier}}`);
    await expect.element(editor).toHaveTextContent("firstsecond");
  } finally {
    restore();
  }
});

it("renders numbered source lines without including the gutter in saved text", async () => {
  const contents = "one\ntwo\nthree\n";
  const readFile = vi.fn().mockResolvedValue(loadedFile({ contents }));
  const writeFile = vi.fn().mockResolvedValue({ relativePath: FILE_PATH, version: SAVED_VERSION });
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile },
  } as unknown as NativeApi);
  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toBeVisible();
    const root = editor.element().getRootNode() as ShadowRoot;
    await vi.waitFor(() =>
      expect(
        Array.from(
          root.querySelectorAll("[data-line-number-content]"),
          (number) => number.textContent,
        ),
      ).toEqual(["1", "2", "3", "4"]),
    );
    await replaceEditorContents(editor, `${contents}four`);
    pressKeyboardSave(editor.element());
    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ contents: `${contents}four` }),
      ),
    );
  } finally {
    restoreNativeApi();
  }
});

it("keeps Pierre line one and editor position stable when the buffer is emptied", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedFile({ contents: "" }));
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toBeVisible();
    const root = editor.element().getRootNode() as ShadowRoot;
    const originalLeft = editor.element().getBoundingClientRect().left;
    for (const contents of ["first character", ""]) {
      await replaceEditorContents(editor, contents);
      await vi.waitFor(() => {
        expect(
          Array.from(
            root.querySelectorAll("[data-line-number-content]"),
            (number) => number.textContent,
          ),
        ).toEqual(["1"]);
        expect(editor.element().getBoundingClientRect().left).toBe(originalLeft);
      });
    }
  } finally {
    restoreNativeApi();
  }
});

it("keeps Pierre gutter aligned through horizontal and vertical scrolling", async () => {
  const contents = Array.from({ length: 100 }, (_, i) => `line${i} ${"x".repeat(300)}`).join("\n");
  const readFile = vi.fn().mockResolvedValue(loadedFile({ contents }));
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <div style={{ width: 400, height: 320 }}>
          <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
        </div>
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toBeVisible();
    const root = editor.element().getRootNode() as ShadowRoot;
    const candidates = [
      ...Array.from(root.querySelectorAll<HTMLElement>("pre,code,[data-content]")),
      document.querySelector<HTMLElement>(".editor-file-editor__pierre")!,
    ];
    const horizontal = candidates.find(
      (el) =>
        el.scrollWidth > el.clientWidth &&
        ["auto", "scroll"].includes(getComputedStyle(el).overflowX),
    )!;
    const vertical = candidates.find(
      (el) =>
        el.scrollHeight > el.clientHeight &&
        ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
    )!;
    expect(horizontal).toBeDefined();
    expect(vertical).toBeDefined();
    horizontal.scrollLeft = horizontal.scrollWidth;
    vertical.scrollTop = vertical.scrollHeight;
    expect(horizontal.scrollLeft).toBeGreaterThan(0);
    expect(vertical.scrollTop).toBeGreaterThan(0);
    await vi.waitFor(() => {
      const number = root.querySelector<HTMLElement>('[data-gutter] [data-line-index="99"]')!;
      const line = root.querySelector<HTMLElement>('[data-content] [data-line-index="99"]')!;
      expect(
        Math.abs(number.getBoundingClientRect().top - line.getBoundingClientRect().top),
      ).toBeLessThan(1);
    });
  } finally {
    restoreNativeApi();
  }
});

it("keeps the large-file fallback gutter rows aligned at the bottom of horizontally overflowing files", async () => {
  const lines = Array.from({ length: 1_001 }, (_, index) => `${index + 1} ${"x".repeat(300)}`);
  const readFile = vi.fn().mockResolvedValue(loadedFile({ contents: lines.join("\n") }));
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <div style={{ width: 400, height: 320 }}>
          <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
        </div>
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toBeVisible();
    const area = editor.element() as HTMLTextAreaElement;
    expect(area.scrollWidth).toBeGreaterThan(area.clientWidth);
    // Headless Chromium hides scrollbars. Extra bottom padding exercises the
    // same unequal scroll ranges there; visible scrollbars need no emulation.
    if (area.offsetHeight === area.clientHeight) {
      area.style.paddingBottom = `${Number.parseFloat(getComputedStyle(area).paddingBottom) + 10}px`;
    }
    area.scrollTop = area.scrollHeight;
    area.dispatchEvent(new Event("scroll"));

    await vi.waitFor(() => {
      const lastNumber = document.querySelector(".editor-file-editor__gutter-line:last-child");
      if (!lastNumber) throw new Error("editor line-number gutter not found");
      const metrics = getComputedStyle(area);
      // CSS exposes unrounded line-height; measure native layout to avoid
      // accumulating subpixel rounding across thousands of rows.
      const measure = document.createElement("div");
      Object.assign(measure.style, {
        position: "absolute",
        visibility: "hidden",
        whiteSpace: "pre",
        font: metrics.font,
        lineHeight: metrics.lineHeight,
        padding: "0",
        border: "0",
        margin: "0",
      });
      measure.textContent = "line\nline";
      document.body.append(measure);
      const renderedLineHeight = measure.getBoundingClientRect().height / 2;
      measure.remove();
      const lastTextLineTop =
        area.getBoundingClientRect().top +
        Number.parseFloat(metrics.paddingTop) +
        (lines.length - 1) * renderedLineHeight -
        area.scrollTop;
      expect(Math.abs(lastNumber.getBoundingClientRect().top - lastTextLineTop)).toBeLessThan(1);
    });
  } finally {
    restoreNativeApi();
  }
});

it("preserves the large-file editing engine and line one after clearing and saving", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedFile({ contents: "line\n".repeat(1_000) }));
  const writeFile = vi.fn().mockResolvedValue({ relativePath: FILE_PATH, version: SAVED_VERSION });
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile },
  } as unknown as NativeApi);
  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toBeVisible();
    const original = editor.element();
    expect(original.tagName).toBe("TEXTAREA");
    const left = original.getBoundingClientRect().left;
    for (const contents of ["", "first character", ""]) {
      await editor.fill(contents);
      await vi.waitFor(() => {
        expect(editor.element()).toBe(original);
        expect(document.querySelector(".editor-file-editor__gutter")?.textContent).toBe("1");
        expect(editor.element().getBoundingClientRect().left).toBe(left);
      });
    }
    pressKeyboardSave(editor.element());
    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ contents: "", expectedVersion: LOADED_VERSION }),
      ),
    );
  } finally {
    restoreNativeApi();
  }
});

it("uses the lightweight editor for long single-line files", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedFile({ contents: "x".repeat(250_001) }));
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toBeVisible();
    expect(editor.element().tagName).toBe("TEXTAREA");
    expect(document.querySelector(".editor-file-editor__gutter")?.textContent).toBe("1");
  } finally {
    restoreNativeApi();
  }
});

it("preserves the lightweight Markdown editor while its preview is open", async () => {
  const readFile = vi
    .fn()
    .mockResolvedValue(loadedFile({ relativePath: "README.md", contents: "line\n".repeat(1_000) }));
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath="README.md" editable />
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: "Edit README.md" });
    await expect.element(editor).toBeVisible();
    const original = editor.element();
    await editor.fill("# unsaved draft");
    await page.getByRole("radio", { name: "Preview", exact: true }).click();
    expect(original.getBoundingClientRect().height).toBe(0);
    await page.getByRole("radio", { name: "Source", exact: true }).click();
    await expect.element(editor).toHaveValue("# unsaved draft");
    expect(editor.element()).toBe(original);
  } finally {
    restoreNativeApi();
  }
});
