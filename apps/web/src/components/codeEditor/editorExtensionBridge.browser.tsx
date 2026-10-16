import "../../index.css";
import { QueryClient } from "@tanstack/react-query";
import type {
  EditorExtensionRuntimeInput,
  EditorExtensionRuntimeResult,
  ProjectReadFileResult,
} from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { acquireEditorModel, replaceEditorText } from "./editorModels";
import { EditorExtensionBridge, extensionTextEdits } from "./editorExtensionBridge";
import { EditorExtensionInteraction } from "./EditorExtensionInteraction";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});
const before = "const n={x:1}";
const after = "const n = { x: 1 };\n";
const edit = {
  text: after,
  range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: before.length + 1 },
};
async function fixture(editable = true, events: EditorExtensionRuntimeResult["events"] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const file: ProjectReadFileResult = {
    relativePath: "a.js",
    contents: before,
    version: "sha256:initial",
    encoding: "utf8",
    lineEnding: "lf",
    truncated: false,
  };
  const writeFile = vi.fn().mockResolvedValue({ relativePath: "a.js", version: "sha256:saved" });
  const format = vi.fn<() => Promise<unknown>>().mockResolvedValue([edit]);
  const extensionRuntime = vi.fn(
    async (input: EditorExtensionRuntimeInput): Promise<EditorExtensionRuntimeResult> => ({
      hostId: "fixture-host",
      status: input.operation === "stop" ? "stopped" : "running",
      sequence: events.length,
      events: input.operation === "start" ? events : [],
      ...(input.method === "language" ? { resultJson: JSON.stringify(await format()) } : {}),
    }),
  );
  const descriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      editor: { extensionRuntime },
      projects: { readFile: vi.fn().mockResolvedValue(file), writeFile },
    },
  });
  cleanups.push(() => {
    if (descriptor) Object.defineProperty(window, "nativeApi", descriptor);
    else Reflect.deleteProperty(window, "nativeApi");
    client.clear();
  });
  const handle = acquireEditorModel(client, "/repo", "a.js", before, 1);
  handle.entry.session!.load(file);
  const bridge = new EditorExtensionBridge(client, "/repo");
  const release = bridge.retain(handle.entry, editable);
  cleanups.push(async () => {
    await bridge.stop();
    release();
    handle.release();
    handle.entry.dispose();
  });
  await bridge.start();
  return { bridge, entry: handle.entry, writeFile, extensionRuntime, format };
}

it("routes extension formatting through native shared buffers, undo and version-checked persistence", async () => {
  const { bridge, entry, writeFile, extensionRuntime } = await fixture();
  await bridge.format(entry, 7);
  expect(entry.model.getValue()).toBe(after);
  expect(entry.session!.getSnapshot().value).toBe(after);
  expect(await entry.session!.flush()).toBe(true);
  expect(writeFile).toHaveBeenCalledWith(
    expect.objectContaining({ contents: after, expectedVersion: "sha256:initial" }),
  );
  await entry.model.undo();
  expect(entry.model.getValue()).toBe(before);
  expect(entry.session!.getSnapshot().value).toBe(before);
  expect(extensionRuntime.mock.calls.filter(([input]) => input.operation === "start")).toHaveLength(
    1,
  );
});

it("rejects an extension formatter result after a newer user edit", async () => {
  const { bridge, entry, format } = await fixture();
  let resolve!: (value: unknown) => void;
  format.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = bridge.format(entry, 7);
  await expect.poll(() => format.mock.calls.length).toBe(1);
  replaceEditorText(entry.model, "newer user draft");
  resolve([edit]);
  await expect(pending).rejects.toThrow("document changed");
  expect(entry.model.getValue()).toBe("newer user draft");
});

it("refuses extension writes from a read-only surface", async () => {
  const { bridge, entry, format } = await fixture(false);
  await expect(bridge.format(entry, 7)).rejects.toThrow("read-only");
  expect(format).not.toHaveBeenCalled();
  expect(entry.model.getValue()).toBe(before);
});

it("rejects clamped and overlapping edit ranges without changing the model", async () => {
  const { entry } = await fixture();
  expect(() =>
    extensionTextEdits(entry.model, [{ ...edit, range: { ...edit.range, endColumn: 100_000 } }]),
  ).toThrow("invalid edit range");
  expect(() => extensionTextEdits(entry.model, [edit, edit])).toThrow("overlapping edits");
  expect(entry.model.getValue()).toBe(before);
});

it("renders extension messages with Synara controls and returns the explicit choice", async () => {
  const { bridge, entry, extensionRuntime } = await fixture(true, [
    {
      sequence: 1,
      event: "nativeRequest",
      bodyJson: JSON.stringify({
        id: 9,
        method: "ui.message",
        params: {
          message: "Formatter configuration changed",
          options: {},
          items: [{ title: "Review changes", handle: 4 }],
        },
      }),
    },
  ]);
  await render(<EditorExtensionInteraction bridge={bridge} entry={entry} />);
  await expect.element(page.getByText("Formatter configuration changed")).toBeVisible();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect
    .poll(() =>
      extensionRuntime.mock.calls.some(
        ([input]) =>
          input.operation === "respond" && input.requestId === 9 && input.responseJson === "4",
      ),
    )
    .toBe(true);
  expect(bridge.getSnapshot().interactions).toHaveLength(0);
});
