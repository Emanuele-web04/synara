// Right-dock viewers on a whole-window glass shell: verify the real editor
// DOM, computed native theme fills, horizontal scrolling and changed rows.
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { CodeDiffEditorPane } from "../codeEditor/CodeDiffEditorPane";
import { CodeEditorPane } from "../codeEditor/CodeEditorPane";
import type { CodeEditHistoryControls } from "../codeEditor/codeEditHistory";
import { DiffPanelShell } from "../DiffPanelShell";
import { monaco } from "../codeEditor/editorRuntime";

const root = document.documentElement;

const originalRootStyle = root.getAttribute("style");
const originalRootClassName = root.className;
afterEach(async () => {
  await cleanup();
  root.removeAttribute("data-window-translucency");
  root.className = originalRootClassName;
  if (originalRootStyle === null) root.removeAttribute("style");
  else root.setAttribute("style", originalRootStyle);
});

function mountDockPane(options: { glass: boolean; maximized?: boolean; editor?: boolean }) {
  if (options.glass) root.setAttribute("data-window-translucency", "window");
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div
        data-slot={options.editor ? undefined : "sidebar-container"}
        data-dock-maximized={options.maximized ? "true" : undefined}
      >
        <div
          data-right-dock-content={options.editor ? undefined : ""}
          data-editor-workspace={options.editor ? "" : undefined}
          style={{ width: 320, height: 240, display: "flex" }}
        >
          <DiffPanelShell mode="sidebar" header={<span>Header</span>}>
            <CodeEditorPane
              fileName="sample.ts"
              resolvedTheme="light"
              value={`const value = "${"x".repeat(400)}";\n`}
              valueVersion={0}
              onChange={() => {}}
              onSave={() => {}}
              historyControlsRef={createRef<CodeEditHistoryControls>()}
            />
          </DiffPanelShell>
        </div>
      </div>
    </QueryClientProvider>,
  );
}

async function viewerParts() {
  const find = () =>
    monaco.editor
      .getEditors()
      .find(
        (editor) =>
          editor.getModel()?.uri.scheme === "synara-standalone" && editor.getDomNode()?.isConnected,
      );
  // The first test must include cold loading of the lazy editor, unlike the
  // later parameterized cases. Bound the wait without relaxing any CSS check.
  await expect.poll(find, { timeout: 10_000 }).toBeDefined();
  const editor = find()!;
  const host = editor.getDomNode()!;
  const query = (selector: string) => {
    const element = host.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  await expect.poll(() => host.querySelector(".view-line")).not.toBeNull();
  return {
    shell: page.getByText("Header").element().closest<HTMLElement>(".app-content-surface"),
    editor,
    host,
    code: query(".monaco-editor-background"),
    line: query(".view-line"),
    lineNumber: query(".line-numbers"),
    gutter: query(".margin"),
  };
}

// Fully transparent in either serialization: `rgba(0, 0, 0, 0)` or, mid-animation, `oklab(… / 0)`.
const isClear = (element: Element | null) =>
  element !== null && /[,/] 0\)$/.test(getComputedStyle(element).backgroundColor);

it.each([
  { name: "right dock", editor: false },
  { name: "editor workspace", editor: true },
])(
  "clears the $name shell and viewer fill, backing the gutter only under scrolled code",
  async ({ editor }) => {
    // The shell's fill is the theme's `--app-content-surface`, applied by useTheme at runtime.
    root.style.setProperty("--app-content-surface", "transparent");
    const view = await mountDockPane({ glass: true, editor });
    const { shell, host, code, line, lineNumber, gutter, editor: surface } = await viewerParts();

    expect([shell, host, code, line, lineNumber, gutter].map(isClear)).not.toContain(false);

    surface.setScrollLeft(120, monaco.editor.ScrollType.Immediate);
    await expect.poll(() => isClear(gutter)).toBe(false);
    surface.setScrollLeft(0, monaco.editor.ScrollType.Immediate);
    await expect.poll(() => isClear(gutter)).toBe(true);

    root.style.removeProperty("--app-content-surface");
    await view.unmount();
  },
);

it.each([
  { name: "an opaque window", glass: false, maximized: false },
  { name: "a maximized dock", glass: true, maximized: true },
])("keeps the viewer's own fill on $name", async ({ glass, maximized }) => {
  const view = await mountDockPane({ glass, maximized });
  const { host, code, gutter, editor } = await viewerParts();

  // Monaco's rows inherit these opaque surfaces; they do not repaint each cell.
  expect([host, code, gutter].map(isClear)).not.toContain(true);
  editor.setScrollLeft(120, monaco.editor.ScrollType.Immediate);
  expect(isClear(gutter)).toBe(false);
  expect(getComputedStyle(gutter).animationName).toBe("none");
  await view.unmount();
});

// Changed rows stay glass on a clear viewer, but keep a visible tint of their own.
// Exercise actual split/unified diff rows, rather than testing CSS source strings.
it.each([
  { theme: "light" as const, split: false },
  { theme: "light" as const, split: true },
  { theme: "dark" as const, split: false },
  { theme: "dark" as const, split: true },
])(
  "keeps $theme changed rows tinted glass in glass diffs (split: $split)",
  async ({ theme, split }) => {
    root.classList.toggle("dark", theme === "dark");
    root.setAttribute("data-window-translucency", "window");
    const client = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const view = await render(
      <QueryClientProvider client={client}>
        <div data-slot="sidebar-container">
          <div data-right-dock-content style={{ width: 600, height: 240, display: "flex" }}>
            <CodeDiffEditorPane
              original="const unchanged = 0;\nconst before = 1;\n"
              modified="const unchanged = 0;\nconst after = 2;\n"
              modifiedVersion={0}
              fileName="sample.ts"
              resolvedTheme={theme}
              renderSideBySide={split}
              onChange={() => {}}
              onSave={() => {}}
            />
          </div>
        </div>
      </QueryClientProvider>,
    );
    const find = () =>
      document.querySelector<HTMLElement>(".synara-code-editor .monaco-diff-editor");
    await expect.poll(find).not.toBeNull();
    const diff = find()!;
    const changedRows = () => [...diff.querySelectorAll<HTMLElement>(".line-insert, .line-delete")];
    await expect.poll(() => changedRows().length).toBeGreaterThan(0);
    const changes = changedRows();
    // Tinted (not washed out to clear) yet see-through. Context stays clear.
    for (const row of changes) {
      const color = getComputedStyle(row).backgroundColor;

      const alpha = color.includes("/")
        ? Number(color.match(/\/ ([\d.]+)\)$/)?.[1])
        : color.startsWith("rgba")
          ? Number(color.match(/, ([\d.]+)\)$/)?.[1])
          : 1;
      expect(alpha, color).toBeGreaterThan(0.05);
      expect(alpha, color).toBeLessThan(0.5);
    }
    for (const background of diff.querySelectorAll(".monaco-editor-background"))
      expect(isClear(background)).toBe(true);
    await view.unmount();
    root.classList.remove("dark");
  },
);
