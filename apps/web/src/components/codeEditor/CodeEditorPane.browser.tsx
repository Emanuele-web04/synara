// The editable surface inside Synara: shared buffers, history, layout changes, and the native pickers.
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CodeEditorPane } from "./CodeEditorPane";
import { monaco } from "./editorRuntime";
import { CodeDiffEditorPane } from "./CodeDiffEditorPane";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./codeEditHistory";

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
      <div style={{ position: "relative", zIndex: 1, background: "var(--background)" }}>
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

it.each(
  [false, true].flatMap((diff) =>
    ["Close", "Previous Match", "Next Match", "Find"].map((name) => ({ diff, name })),
  ),
)(
  "keeps Find's $name tooltip visible and stable at the editor edge (diff: $diff)",
  async ({ diff, name }) => {
    await page.viewport(1200, 800);
    const view = await mount(diff, "const value = 1;\nconsole.log(value);\n");
    const editor = await ready();
    await editor.getAction("actions.find")?.run();
    await page.getByRole("textbox", { name: "Find", exact: true }).fill("value");
    const close = page.getByRole("button", { name: /^Close(?:\s|$)/ });
    await expect.element(close).toBeVisible();
    const trigger =
      name === "Find"
        ? page.getByRole("textbox", { name: "Find", exact: true })
        : page.getByRole("button", { name: new RegExp(`^${name}(?:\\s|$)`) });
    const button = trigger.element();
    const widget = button.closest(".find-widget");
    const label = button.getAttribute("aria-label");
    try {
      await page.getByRole("button", { name: "Theme", exact: true }).hover();
      await trigger.hover();
      const tooltip = () =>
        Array.from(document.querySelectorAll<HTMLElement>(".workbench-hover")).find(
          (node) =>
            (node.textContent === label ||
              (name === "Find" && node.textContent?.startsWith("Find ("))) &&
            node.getBoundingClientRect().height > 0,
        );
      await expect.poll(tooltip).toBeDefined();
      const original = tooltip();
      if (!original) throw new Error("Find's close tooltip did not open.");
      // Hold the physical pointer still long enough to catch a hide/reopen loop.
      const deadline = performance.now() + 1200;
      while (performance.now() < deadline) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(tooltip()).toBe(original);
        const bounds = original.getBoundingClientRect();
        const target = button.getBoundingClientRect();
        expect(bounds.bottom <= target.top || bounds.top >= target.bottom).toBe(true);
        // A DOM-visible tooltip can still be clipped by the editor or covered by its header.
        for (const [x, y] of [
          [bounds.left + 8, bounds.top + bounds.height / 2],
          [bounds.right - 8, bounds.top + bounds.height / 2],
          [bounds.left + bounds.width / 2, bounds.top + 4],
          [bounds.left + bounds.width / 2, bounds.bottom - 4],
        ] as const) {
          expect(original.contains(document.elementFromPoint(x, y))).toBe(true);
        }
      }
      await page.getByRole("button", { name: "Theme", exact: true }).hover();
      await expect.poll(tooltip).toBeUndefined();
      await close.click();
      await expect.poll(() => widget?.getAttribute("aria-hidden")).toBe("true");
    } finally {
      await view.unmount();
    }
  },
  15_000,
);

it.each([false, true].flatMap((replace) => [13, 18].map((fontSize) => ({ replace, fontSize }))))(
  "centers and scales Find controls (replace: $replace, UI: $fontSize)",
  async ({ replace, fontSize }) => {
    const view = await mount(false, "const value = 1;\nconsole.log(value);\n");
    const editor = await ready();
    editor
      .getDomNode()
      ?.closest<HTMLElement>(".synara-code-editor")
      ?.style.setProperty("--app-font-size-ui", `${fontSize}px`);
    try {
      await editor
        .getAction(replace ? "editor.action.startFindReplaceAction" : "actions.find")
        ?.run();
      const find = page.getByRole("textbox", { name: "Find", exact: true });
      await expect.element(find).toBeVisible();
      for (const query of ["value", "value\nconsole"]) {
        await find.fill(query);
        const input = find.element();
        const box = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        expect(parseFloat(style.fontSize)).toBe(fontSize);
        const firstLineCenter =
          box.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
        const widget = input.closest(".find-widget");
        const counter = widget?.querySelector(".matchesCount");
        if (!counter) throw new Error("Find's match counter did not mount.");
        const range = document.createRange();
        range.selectNodeContents(counter);
        const text = range.getBoundingClientRect();
        // Compare actual glyphs: fractional line heights and font ascenders can
        // put their optical center slightly away from the line box center.
        const mirror = input.closest(".monaco-inputbox")?.querySelector(".mirror");
        if (!mirror) throw new Error("Find's measuring mirror did not mount.");
        range.selectNodeContents(mirror);
        const glyphs = range.getClientRects()[0];
        if (!glyphs) throw new Error("Find's query glyphs were not measured.");
        expect(
          Math.abs(text.top + text.height / 2 - glyphs.top - glyphs.height / 2),
          JSON.stringify({
            text: text.toJSON(),
            glyphs: glyphs.toJSON(),
            box: box.toJSON(),
            lineHeight: style.lineHeight,
          }),
        ).toBeLessThanOrEqual(0.25);
        const controls = input.closest(".monaco-findInput")?.querySelector(".controls");
        for (const name of [
          '[aria-label^="Previous Match"]',
          '[aria-label^="Next Match"]',
          ".button.codicon-widget-close",
        ]) {
          const button = widget?.querySelector(name);
          if (!button) throw new Error(`Find's ${name} did not mount.`);
          const bounds = button.getBoundingClientRect();
          expect(Math.abs(bounds.top + bounds.height / 2 - firstLineCenter)).toBeLessThanOrEqual(
            0.25,
          );
        }
        for (const toggle of controls?.children ?? []) {
          const bounds = toggle.getBoundingClientRect();
          expect(Math.abs(bounds.top + bounds.height / 2 - firstLineCenter)).toBeLessThanOrEqual(
            0.25,
          );
        }
        if (replace) {
          const replacement = page.getByRole("textbox", { name: "Replace", exact: true }).element();
          const replacementBox = replacement.getBoundingClientRect();
          const replacementStyle = getComputedStyle(replacement);
          expect(parseFloat(replacementStyle.fontSize)).toBe(fontSize);
          const replacementCenter =
            replacementBox.top +
            parseFloat(replacementStyle.paddingTop) +
            parseFloat(replacementStyle.lineHeight) / 2;
          const toggle = replacement.closest(".monaco-findInput")?.querySelector(".controls > *");
          if (!toggle) throw new Error("Replace's preserve-case toggle did not mount.");
          const bounds = toggle.getBoundingClientRect();
          expect(Math.abs(bounds.top + bounds.height / 2 - replacementCenter)).toBeLessThanOrEqual(
            0.25,
          );
        }
      }
    } finally {
      await view.unmount();
    }
  },
);

it.each([false, true])("overlays Find without moving the code (diff: %s)", async (diff) => {
  const view = await mount(diff);
  const editor = await ready();
  if (diff) {
    await expect.poll(() => monaco.editor.getDiffEditors()[0]?.getLineChanges()).not.toBeNull();
    // Diff alignment inserts view zones asynchronously; finish that initial layout first.
    for (let frame = 0; frame < 2; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  const lineTop = () => editor.getScrolledVisiblePosition({ lineNumber: 1, column: 1 })?.top;
  const before = lineTop();
  try {
    await editor.getAction("actions.find")?.run();
    await expect.element(page.getByRole("textbox", { name: "Find", exact: true })).toBeVisible();
    expect(editor.getOption(monaco.editor.EditorOption.find).addExtraSpaceOnTop).toBe(false);
    const deadline = performance.now() + 350;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(lineTop()).toBe(before);
    }
    await page.getByRole("button", { name: /^Close(?:\s|$)/ }).click();
    expect(lineTop()).toBe(before);
  } finally {
    await view.unmount();
  }
});

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

// File surface only: the engine's diff view model (0.57) can throw a
// BugIndicatingError from UnchangedRegion.fromDiffs when a diff result lands on
// a model that changed under it, which this rapid edit sequence provokes.
it("keeps following rows visible after repeated Enter and joining lines", async () => {
  {
    const diff = false;
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
  }
});

it("does not mark unchanged CRLF lines as changes alongside a real edit", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <div style={{ width: 900, height: 500, display: "flex", flexDirection: "column" }}>
        <CodeDiffEditorPane
          original={"one\r\ntwo\r\nthree\r\n"}
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

it("keeps the editor mounted while typing in the command picker", async () => {
  const view = await mount();
  const editor = await ready();
  await userEvent.keyboard("{F1}");
  const input = page.getByRole("combobox", { name: "Editor commands", exact: true });
  await expect.element(input).toBeVisible();
  await userEvent.keyboard("fold");
  await expect.element(input).toHaveValue("fold");
  await expect.element(page.getByText("Fold all", { exact: true })).toBeVisible();
  expect(activeEditor()).toBe(editor);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(activeEditor()).toBe(editor);
  await view.unmount();
});

it.each(["Find in file", "Replace in file"])(
  "hands keyboard focus to %s without editing the source",
  async (command) => {
    const initialValue = 'const value = "needle";\n';
    const view = await mount(false, initialValue);
    await ready();
    await userEvent.keyboard("{F1}");
    await userEvent.keyboard(command);
    await userEvent.keyboard("{Enter}");
    const find = page.getByRole("textbox", { name: "Find", exact: true });
    await expect.element(find).toHaveFocus();
    await userEvent.keyboard("searchQuery");
    await expect.element(find).toHaveValue("searchQuery");
    expect(buffer()).toBe(initialValue);
    await userEvent.keyboard("{Escape}");
    await view.unmount();
  },
);

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

it("colours bracket pairs from the Shiki theme and leaves brackets inside strings plain", async () => {
  const view = await mount(false, 'const pair = ("x(");\n');
  await ready();
  // Two coloured brackets: the pair around the string, not the one inside it.
  await expect
    .poll(
      () =>
        activeEditor()
          .getDomNode()
          ?.querySelectorAll('.view-lines [class*="bracket-highlighting-"]').length,
      { timeout: 10_000 },
    )
    .toBe(2);
  await view.unmount();
});

it("collapses a long unchanged diff region behind a bar", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const shared = Array.from({ length: 40 }, (_, index) => `const line${index} = ${index};`).join(
    "\n",
  );
  const view = await render(
    <QueryClientProvider client={client}>
      <div style={{ width: 900, height: 500, display: "flex", flexDirection: "column" }}>
        <CodeDiffEditorPane
          original={`${shared}\nconst last = 0;\n`}
          modified={`${shared}\nconst last = 1;\n`}
          modifiedVersion={0}
          fileName="region.ts"
          resolvedTheme="dark"
          renderSideBySide
          onChange={() => {}}
          onSave={() => {}}
        />
      </div>
    </QueryClientProvider>,
  );
  await ready();
  await expect
    .poll(() =>
      Array.from(document.querySelectorAll(".monaco-diff-editor .diff-hidden-lines"))
        .map((bar) => bar.textContent)
        .join(" "),
    )
    .toContain("hidden lines");
  // The engine renders spaces as no-break spaces; match the identifier only.
  await expect.poll(rendered).toContain("last");
  await view.unmount();
  client.clear();
});

it("goes to a typed line from Synara's picker and restores the viewport on cancel", async () => {
  const view = await mount(false, "const first = 1;\nconst second = 2;\nconst third = 3;\n");
  const editor = await ready();
  editor.setPosition({ lineNumber: 1, column: 1 });
  await userEvent.keyboard("{F1}");
  await page.getByRole("combobox", { name: "Editor commands", exact: true }).fill("go to line");
  await page.getByRole("option", { name: "Go to line…", exact: true }).click();
  const input = page.getByRole("combobox", { name: "Go to line", exact: true });
  await expect.element(input).toBeVisible();
  await expect.element(page.getByText("Type a line number (1–4) or line:column.")).toBeVisible();
  await input.fill("3");
  await expect.element(page.getByText("Go to line 3", { exact: true })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(editor.getPosition()?.lineNumber).toBe(1);
  await userEvent.keyboard("{F1}");
  await page.getByRole("combobox", { name: "Editor commands", exact: true }).fill("go to line");
  await page.getByRole("option", { name: "Go to line…", exact: true }).click();
  await page.getByRole("combobox", { name: "Go to line", exact: true }).fill("3:7");
  await page.getByRole("option", { name: "Go to line 3, column 7", exact: false }).click();
  await expect.poll(() => editor.getPosition()?.toString()).toBe("(3,7)");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await view.unmount();
});
