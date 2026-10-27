import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, type NativeApi } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { setLanguagePreference } from "../../i18n";
import { APP_SETTINGS_STORAGE_KEY } from "../../appSettingsStorage";
import { useDockExplorerBrowseStore } from "../../dockExplorerBrowseStore";
import { DockExplorerPane } from "./DockExplorerPane";
import { monaco } from "../codeEditor/editorRuntime";

let restore: (() => void) | undefined;
let previousSettings: string | null;
beforeEach(() => {
  previousSettings = localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, '{"language":"en"}');
  setLanguagePreference("en");
});
afterEach(async () => {
  await cleanup();
  restore?.();
  useDockExplorerBrowseStore.setState({ browseStateByThreadId: {} });
  if (previousSettings === null) localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  else localStorage.setItem(APP_SETTINGS_STORAGE_KEY, previousSettings);
  setLanguagePreference("system");
});
async function mount(editorLabel = "Edit a.ts") {
  // The lightweight editor accepts native textarea input; persistence is the
  // same shared session used by the intelligent file and diff editors.
  const writeFile = vi.fn().mockResolvedValue({ relativePath: "a.ts", version: "sha256:saved" });
  const readFile = vi
    .fn<NativeApi["projects"]["readFile"]>()
    .mockImplementation(async ({ relativePath }) => ({
      relativePath,
      contents: `${relativePath}\n` + "line\n".repeat(1_001),
      version: "sha256:initial",
      encoding: "utf8",
      lineEnding: "lf",
      truncated: false,
    }));
  const descriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      projects: {
        readFile,
        writeFile,
        listDirectories: vi.fn().mockResolvedValue({
          entries: ["a.ts", "b.ts"].map((name) => ({ name, path: name, kind: "file" })),
        }),
        searchEntries: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
      },
    },
  });
  restore = () => {
    if (descriptor) Object.defineProperty(window, "nativeApi", descriptor);
    else Reflect.deleteProperty(window, "nativeApi");
  };
  await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* The fixture must provide the dimensions normally owned by the dock. */}
      <div style={{ width: 1_000, height: 560, display: "flex" }}>
        <DockExplorerPane
          threadId={ThreadId.makeUnsafe("autosave")}
          workspaceRoot="/repo"
          isVisible
        />
      </div>
    </QueryClientProvider>,
  );
  await page.getByTitle("a.ts", { exact: true }).click();
  const editor = page.getByRole("textbox", { name: editorLabel });
  await expect.element(editor).toBeVisible();
  return { editor, writeFile };
}

it.each([
  ["en", "Edit a.ts", "Saved", "Save"],
  ["zh-CN", "编辑a.ts", "已保存", "保存"],
] as const)(
  "autosaves with localized status in %s without a keyboard shortcut",
  async (locale, editorLabel, savedLabel, saveLabel) => {
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ language: locale }));
    setLanguagePreference(locale);
    const { editor, writeFile } = await mount(editorLabel);
    let finish!: (value: { relativePath: string; version: string }) => void;
    writeFile.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await editor.fill("changed without Cmd+S");
    await expect.poll(() => writeFile.mock.calls.length).toBe(1);
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: "changed without Cmd+S",
        expectedVersion: "sha256:initial",
      }),
    );
    try {
      await expect
        .element(page.getByRole("button", { name: saveLabel, exact: true }))
        .toBeDisabled();
    } finally {
      finish({ relativePath: "a.ts", version: "sha256:saved" });
    }
    await expect.element(page.getByText(savedLabel, { exact: true })).toBeVisible();
  },
);

it("waits for the last edits before switching files", async () => {
  const { editor, writeFile } = await mount();
  let finish!: (value: { relativePath: string; version: string }) => void;
  writeFile.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await editor.fill("first edit");
  await page.getByTitle("b.ts", { exact: true }).click();
  await expect.poll(() => writeFile.mock.calls.length).toBe(1);
  await expect.element(editor).toBeVisible();
  await editor.fill("newest edit");
  finish({ relativePath: "a.ts", version: "sha256:first" });
  await expect.element(page.getByRole("textbox", { name: "Edit b.ts" })).toBeVisible();
  expect(writeFile).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      relativePath: "a.ts",
      contents: "newest edit",
      expectedVersion: "sha256:first",
    }),
  );
  await page.getByTitle("a.ts", { exact: true }).click();
  // The saved document is now small, so reopening uses the intelligent editor.
  // Its accessible input is not the document; inspect the real model and rows.
  await expect.element(page.getByRole("textbox", { name: "Edit a.ts" })).toBeInTheDocument();
  const reopened = () =>
    monaco.editor.getEditors().find((candidate) => {
      const uri = candidate.getModel()?.uri;
      return uri?.scheme === "synara-workspace" && uri.path === "/a.ts";
    });
  await expect.poll(() => reopened()?.getValue()).toBe("newest edit");
  // Monaco renders ordinary spaces as NBSPs; the model assertion above must
  // remain exact so a real change to the saved text cannot pass unnoticed.
  await expect
    .poll(() =>
      reopened()
        ?.getDomNode()
        ?.querySelector(".view-lines")
        ?.textContent?.replaceAll("\u00a0", " "),
    )
    .toContain("newest edit");
});

it("keeps the current file and its draft when a switch encounters a save failure", async () => {
  const { editor, writeFile } = await mount();
  writeFile.mockRejectedValue(new Error("Permission denied"));
  await editor.fill("keep this draft");
  await page.getByTitle("b.ts", { exact: true }).click();
  const failure = page.getByText("Permission denied", { exact: true });
  await expect.element(failure).toBeVisible();
  expect(failure.element().closest('[role="alert"]')).not.toBeNull();
  await expect.element(editor).toHaveValue("keep this draft");
  await expect.element(page.getByRole("textbox", { name: "Edit b.ts" })).not.toBeInTheDocument();
});
