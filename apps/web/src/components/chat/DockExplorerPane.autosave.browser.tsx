import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, type NativeApi } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { DockExplorerPane } from "./DockExplorerPane";

let restore: (() => void) | undefined;
afterEach(async () => {
  await cleanup();
  restore?.();
});
async function mount() {
  // The lightweight editor accepts native textarea input; persistence is the same shared session used by Pierre and by the full-screen/diff editors.
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
      <DockExplorerPane
        threadId={ThreadId.makeUnsafe("autosave")}
        workspaceRoot="/repo"
        isVisible
      />
    </QueryClientProvider>,
  );
  await page.getByTitle("a.ts", { exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edit a.ts" });
  await expect.element(editor).toBeVisible();
  return { editor, writeFile };
}

it("autosaves without a keyboard shortcut", async () => {
  const { editor, writeFile } = await mount();
  await editor.fill("changed without Cmd+S");
  await expect.poll(() => writeFile.mock.calls.length).toBe(1);
  expect(writeFile).toHaveBeenCalledWith(
    expect.objectContaining({
      contents: "changed without Cmd+S",
      expectedVersion: "sha256:initial",
    }),
  );
  await expect.element(page.getByText("Saved", { exact: true })).toBeVisible();
});

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
  await expect
    .element(page.getByRole("textbox", { name: "Edit a.ts" }))
    .toHaveTextContent("newest edit");
});

it("keeps the current file and its draft when a switch encounters a save failure", async () => {
  const { editor, writeFile } = await mount();
  writeFile.mockRejectedValue(new Error("Permission denied"));
  await editor.fill("keep this draft");
  await page.getByTitle("b.ts", { exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Permission denied");
  await expect.element(editor).toHaveValue("keep this draft");
  await expect.element(page.getByRole("textbox", { name: "Edit b.ts" })).not.toBeInTheDocument();
});
