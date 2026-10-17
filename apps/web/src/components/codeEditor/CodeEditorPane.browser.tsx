// Exercise the real standalone Code-OSS editor inside Synara: buffers, history, layout, and virtualization.
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CodeEditorPane } from "./CodeEditorPane";
import { monaco } from "./editorRuntime";
import { CodeDiffEditorPane } from "./CodeDiffEditorPane";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./pierreEdit";

afterEach(() => document.documentElement.classList.remove("dark"));

function Harness({
  diff = false,
  initialValue = "const value = 1;\n",
  onHistoryChange,
}: {
  diff?: boolean;
  initialValue?: string | undefined;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
}) {
  const [value, setValue] = useState(initialValue);
  const [version, setVersion] = useState(0);
  const [split, setSplit] = useState(true);
  const [dark, setDark] = useState(true);
  const [saved, setSaved] = useState(0);
  const [controls] = useState(() => createRef<CodeEditHistoryControls>());
  const common = {
    fileName: "sample.ts",
    resolvedTheme: dark ? ("dark" as const) : ("light" as const),
    onChange: setValue,
    onSave: () => setSaved((n) => n + 1),
    historyControlsRef: controls,
    onHistoryChange,
  };
  return (
    <div style={{ width: 900, height: 500, display: "flex", flexDirection: "column" }}>
      <div>
        <button onClick={() => controls.current?.revertTo("const value = 999;\n")}>
          Edit via history API
        </button>
        <button onClick={() => controls.current?.undo()}>Undo</button>
        <button onClick={() => controls.current?.redo()}>Redo</button>
        <button onClick={() => setSplit((v) => !v)}>Layout</button>
        <button onClick={() => setDark((v) => !v)}>Theme</button>
        <button
          onClick={() => {
            setValue("const reloaded = 42;\n");
            setVersion((v) => v + 1);
          }}
        >
          Reload
        </button>
        <output hidden data-testid="buffer">
          {value}
        </output>
        <output hidden data-testid="saved">
          {saved}
        </output>
      </div>
      {diff ? (
        <CodeDiffEditorPane
          {...common}
          original="const value = 0;\n"
          originalVersion={0}
          modified={value}
          modifiedVersion={version}
          renderSideBySide={split}
        />
      ) : (
        <CodeEditorPane {...common} value={value} valueVersion={version} />
      )}
    </div>
  );
}

function mount(
  diff = false,
  initialValue?: string,
  onHistoryChange?: (history: CodeEditHistoryState) => void,
) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness diff={diff} initialValue={initialValue} onHistoryChange={onHistoryChange} />
    </QueryClientProvider>,
  );
}

function activeEditor() {
  const editor = monaco.editor
    .getEditors()
    .find((item) => item.getModel()?.uri.scheme === "synara-standalone");
  if (!editor) throw new Error("The real editable surface has not mounted.");
  return editor;
}
async function ready() {
  await expect
    .poll(
      () =>
        monaco.editor
          .getEditors()
          .some((item) => item.getModel()?.uri.scheme === "synara-standalone"),
      { timeout: 10_000 },
    )
    .toBe(true);
  const editor = activeEditor();
  editor.focus();
  return editor;
}
const buffer = () => page.getByTestId("buffer").element().textContent ?? "";
// Inline diffs include an original-lines view zone before the editable lines.
// Inspect all rendered rows, not the first (potentially original) view-lines node.
const rendered = () =>
  Array.from(activeEditor().getDomNode()?.querySelectorAll(".view-lines") ?? [])
    .map((lines) => lines.textContent ?? "")
    .join("\n");

it.each([false, true])(
  "publishes history only when undo/redo availability changes (diff: %s)",
  async (diff) => {
    const historyChanged = vi.fn();
    const view = await mount(diff, undefined, historyChanged);
    await ready();
    await expect
      .poll(() => historyChanged.mock.calls)
      .toEqual([[{ canUndo: false, canRedo: false }]]);
    historyChanged.mockClear();
    await userEvent.keyboard("abc");
    await expect
      .poll(() => historyChanged.mock.calls)
      .toEqual([[{ canUndo: true, canRedo: false }]]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect
      .poll(() => historyChanged.mock.calls.at(-1))
      .toEqual([{ canUndo: false, canRedo: true }]);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect
      .poll(() => historyChanged.mock.calls.at(-1))
      .toEqual([{ canUndo: true, canRedo: false }]);
    await view.unmount();
  },
);

it.each(["file", "split", "unified"])(
  "keeps %s editing, select-all and reload correct beyond the initial viewport",
  async (mode) => {
    await page.viewport(1200, 800);
    const initialValue =
      Array.from({ length: 2000 }, (_, index) => `const line${index} = ${index};`).join("\n") +
      "\n";
    const view = await mount(mode !== "file", initialValue);
    const editor = await ready();
    if (mode === "unified") await page.getByRole("button", { name: "Layout", exact: true }).click();
    expect(editor.getDomNode()?.querySelectorAll(".view-line").length).toBeLessThan(250);
    editor.setPosition({ lineNumber: 2001, column: 1 });
    editor.revealLineInCenter(2001);
    editor.focus();
    await expect.poll(rendered).toContain("line1999");
    await userEvent.keyboard("tail");
    await expect.poll(buffer).toBe(initialValue + "tail");
    await expect.poll(rendered).toContain("tail");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(buffer).toBe(initialValue);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect.poll(buffer).toBe(initialValue + "tail");
    editor.focus();
    const modifier = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}a{/${modifier}}replacement`);
    await expect.poll(buffer).toBe("replacement");
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.poll(() => editor.getModel()?.getValue()).toBe("const reloaded = 42;\n");
    await expect.poll(rendered).toContain("reloaded");
    await expect.poll(buffer).toBe("const reloaded = 42;\n");
    await view.unmount();
  },
);

it.each([false, true])(
  "keeps following rows visible after repeated Enter and joining lines (diff: %s)",
  async (diff) => {
    const initialValue = "const value = 1;\nconst second = 2;\nconst third = 3;\n";
    const view = await mount(diff, initialValue);
    const editor = await ready();
    editor.setPosition({ lineNumber: 1, column: 17 });
    editor.focus();
    for (const keys of ["{End}{Enter}", "{Enter}"]) {
      await userEvent.keyboard(keys);
      await expect.poll(rendered).toContain("second");
      await expect.poll(rendered).toContain("third");
      expect(editor.getModel()?.getValue()).toBe(buffer());
    }
    await expect.poll(buffer).toBe(initialValue.replace("1;\n", "1;\n\n\n"));
    await userEvent.keyboard("inserted");
    const edited = initialValue.replace("1;\n", "1;\n\ninserted\n");
    await expect.poll(buffer).toBe(edited);
    editor.getModel()?.pushStackElement();
    await userEvent.keyboard("{Home}{Backspace}");
    const joined = initialValue.replace("1;\n", "1;\ninserted\n");
    await expect.poll(buffer).toBe(joined);
    await expect.poll(rendered).toContain("third");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(buffer).toBe(edited);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect.poll(buffer).toBe(joined);
    await view.unmount();
  },
);

it("does not mark unchanged CRLF lines as changes alongside a real edit", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <div style={{ width: 900, height: 500, display: "flex", flexDirection: "column" }}>
        <CodeDiffEditorPane
          original={"one\r\ntwo\r\nthree\r\n"}
          originalVersion={0}
          modified={"one\nchanged\nthree\n"}
          modifiedVersion={0}
          fileName="same.txt"
          resolvedTheme="light"
          renderSideBySide
          onChange={() => {}}
          onSave={() => {}}
        />
      </div>
    </QueryClientProvider>,
  );
  await ready();
  await expect
    .poll(() => monaco.editor.getDiffEditors()[0]?.getLineChanges())
    .toEqual([
      expect.objectContaining({
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      }),
    ]);
  await expect.poll(rendered).toContain("changed");
  await view.unmount();
  client.clear();
});

it("accepts typing, undo, redo and retains selection, scroll and edits across theme changes", async () => {
  const view = await mount();
  const editor = await ready();
  await userEvent.keyboard("x");
  await expect.poll(buffer).toContain("x");
  await page.getByRole("button", { name: "Edit via history API" }).click();
  await expect.poll(buffer).toBe("const value = 999;\n");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(buffer).toContain("x");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(buffer).toBe("const value = 999;\n");
  editor.setSelection(new monaco.Selection(1, 2, 1, 6));
  const selection = editor.getSelection();
  const model = editor.getModel();
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  expect(activeEditor()).toBe(editor);
  expect(editor.getModel()).toBe(model);
  expect(editor.getSelection()).toEqual(selection);
  await expect.poll(rendered).toContain("999");
  await view.unmount();
});

it("retains the same diff model, buffer and undo stack when switching split/unified", async () => {
  const view = await mount(true);
  const editor = await ready();
  const model = editor.getModel();
  await page.getByRole("button", { name: "Edit via history API" }).click();
  await expect.poll(buffer).toBe("const value = 999;\n");
  for (let index = 0; index < 2; index++) {
    await page.getByRole("button", { name: "Layout", exact: true }).click();
    expect(activeEditor().getModel()).toBe(model);
    await expect.poll(rendered).toContain("999");
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(buffer).toBe("const value = 1;\n");
  await view.unmount();
});

it("opens Synara's native command picker without a workbench or second navigation", async () => {
  const view = await mount();
  await ready();
  await userEvent.keyboard("{F1}");
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByText("Find in file", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await view.unmount();
});

it("keeps the editor mounted while typing a new symbol name", async () => {
  const view = await mount();
  const editor = await ready();
  editor.setPosition({ lineNumber: 1, column: 8 });
  await userEvent.keyboard("{F2}");
  const name = page.getByRole("textbox", { name: "New symbol name", exact: true });
  await expect.element(name).toHaveValue("value");
  await userEvent.keyboard("{End}{Backspace}{Backspace}");
  await expect.element(name).toHaveValue("val");
  await userEvent.keyboard("ueRenamed");
  await expect.element(name).toHaveValue("valueRenamed");
  expect(activeEditor()).toBe(editor);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(activeEditor()).toBe(editor);
  await view.unmount();
});

it("keeps both diff inputs labelled after layout and theme updates", async () => {
  const view = await mount(true);
  await ready();
  const labels = () => {
    const diff = monaco.editor.getDiffEditors()[0];
    return [diff?.getOriginalEditor(), diff?.getModifiedEditor()].map((editor) => ({
      option: editor?.getOption(monaco.editor.EditorOption.ariaLabel),
      input: editor?.getDomNode()?.querySelector('[role="textbox"]')?.getAttribute("aria-label"),
    }));
  };
  const expected = [
    { option: "Original sample.ts", input: "Original sample.ts" },
    { option: "Edit sample.ts", input: "Edit sample.ts" },
  ];
  await expect.poll(labels).toEqual(expected);
  for (const action of ["Layout", "Theme", "Layout"]) {
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(labels).toEqual(expected);
  }
  await view.unmount();
});
