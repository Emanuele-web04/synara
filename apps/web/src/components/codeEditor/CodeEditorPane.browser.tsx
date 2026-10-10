// Exercise real Pierre editors in Chromium, including rendered rows and edit history.
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CodeEditorPane } from "./CodeEditorPane";
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

it.each([false])(
  "publishes history only when undo/redo availability changes (diff: %s)",
  async (diff) => {
    const historyChanged = vi.fn();
    const view = await mount(diff, undefined, historyChanged);
    await page.getByRole("textbox").click({ position: { x: 15, y: 5 } });
    await expect
      .poll(() => historyChanged.mock.calls)
      .toEqual([[{ canUndo: false, canRedo: false }]]);
    historyChanged.mockClear();
    await userEvent.keyboard("abc");
    await expect
      .poll(() => historyChanged.mock.calls)
      .toEqual([[{ canUndo: true, canRedo: false }]]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true });
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    await view.unmount();
  },
);

// Find the real scroll owner outside Pierre's shadow root, independently of its wrappers.
function editorViewport() {
  const root = page.getByRole("textbox").element().getRootNode() as ShadowRoot;
  for (let node = root.host.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "auto") return node;
  }
  throw new Error("Editor scroll container not found");
}

it.each(["file", "split", "unified"])(
  "keeps %s editing and reload correct beyond the initial viewport",
  async (mode) => {
    await page.viewport(1200, 800);
    const initialValue =
      Array.from({ length: 2000 }, (_, index) => `const line${index} = ${index};`).join("\n") +
      "\n";
    const view = await mount(mode !== "file", initialValue);
    await expect.element(page.getByRole("textbox")).toBeVisible();
    if (mode === "unified") await page.getByRole("button", { name: "Layout", exact: true }).click();
    await expect
      .poll(() => page.getByRole("textbox").element().querySelectorAll("[data-line]").length)
      .toBeLessThan(250);
    const viewport = editorViewport();
    viewport.scrollTop = viewport.scrollHeight;
    await expect.element(page.getByRole("textbox")).toHaveTextContent("const line1999 = 1999;");
    const lastLine = page.getByRole("textbox").element().querySelector('[data-line="2000"]')!;
    await userEvent.click(lastLine.querySelector("span") ?? lastLine);
    await userEvent.keyboard("{End}{Enter}tail");
    const buffer = () => page.getByTestId("buffer").element().textContent;
    await expect.poll(buffer).toBe(initialValue + "tail\n");
    await expect.element(page.getByRole("textbox")).toHaveTextContent("tail");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(buffer).toBe(initialValue + "\n");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect.poll(buffer).toBe(initialValue + "tail\n");

    // Select-all must include unmounted rows, not just the visible tail of the file.
    await userEvent.click(
      page.getByRole("textbox").element().querySelector('[data-line="2001"]')!.firstElementChild!,
    );
    const modifier = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}a{/${modifier}}replacement`);
    await expect.poll(buffer).toBe("replacement");

    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect.element(page.getByRole("textbox")).toHaveTextContent("const reloaded = 42;");
    await expect.poll(buffer).toBe("const reloaded = 42;\n");
    await view.unmount();
  },
);

it.each([false, true])(
  "keeps following rows visible after repeated Enter (diff: %s)",
  async (diff) => {
    const initialValue = "const value = 1;\nconst second = 2;\nconst third = 3;\n";
    const view = await mount(diff, initialValue);
    document.documentElement.classList.add("dark");
    const buffer = () => page.getByTestId("buffer").element().textContent ?? "";
    const renderedText = () =>
      Array.from(page.getByRole("textbox").element().querySelectorAll("[data-line]"))
        .map((line) => line.textContent)
        .join("\n")
        .trimEnd();
    await page.getByRole("textbox").click({ position: { x: 15, y: 5 } });

    // The second Enter used to blank the next source row without changing its buffer.
    for (const keys of ["{End}{Enter}", "{Enter}"]) {
      await userEvent.keyboard(keys);
      await expect.poll(renderedText).toBe(buffer().trimEnd());
    }
    await expect.poll(buffer).toBe(initialValue.replace("1;\n", "1;\n\n\n"));
    await userEvent.keyboard("inserted");
    const edited = initialValue.replace("1;\n", "1;\n\ninserted\n");
    await expect.poll(buffer).toBe(edited);
    await expect.poll(renderedText).toBe(edited.trimEnd());

    await userEvent.keyboard("{Home}{Backspace}");
    const joined = initialValue.replace("1;\n", "1;\ninserted\n");
    await expect.poll(buffer).toBe(joined);
    await expect.poll(renderedText).toBe(joined.trimEnd());
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(buffer).toBe(edited);
    await expect.poll(renderedText).toBe(edited.trimEnd());
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect.poll(buffer).toBe(joined);
    await expect.poll(renderedText).toBe(joined.trimEnd());
    await view.unmount();
  },
);

it("does not mark unchanged CRLF lines as changes alongside a real edit", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
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
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("textbox")).toBeVisible();
  const content = page.getByRole("textbox").element();
  await expect
    .poll(() => content.querySelectorAll('[data-line-type="change-addition"]').length)
    .toBe(1);
  await expect.element(page.getByRole("textbox")).toHaveTextContent("changed");
  await view.unmount();
});

it("real Pierre file editor accepts typing, undo, redo and keeps edits across theme change", async () => {
  const view = await mount();
  await page.getByRole("textbox").click({ position: { x: 15, y: 5 } });
  await userEvent.keyboard("x");
  await expect.poll(() => page.getByTestId("buffer").element().textContent).toContain("x");
  await page.getByRole("button", { name: "Edit via history API" }).click();
  await expect.element(page.getByTestId("buffer")).toHaveTextContent("const value = 999;");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => page.getByTestId("buffer").element().textContent).toContain("x");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.element(page.getByTestId("buffer")).toHaveTextContent("const value = 999;");
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await expect.element(page.getByRole("textbox")).toHaveTextContent("const value = 999;");
  await view.unmount();
});

it("real Pierre diff editor preserves current buffer on split/unified remount", async () => {
  const view = await mount(true);
  await expect.element(page.getByRole("textbox")).toBeVisible();
  await page.getByRole("button", { name: "Edit via history API" }).click();
  await expect.element(page.getByTestId("buffer")).toHaveTextContent("const value = 999;");
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await expect.element(page.getByRole("textbox")).toHaveTextContent("const value = 999;");
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await expect.element(page.getByRole("textbox")).toHaveTextContent("const value = 999;");
  await view.unmount();
});
