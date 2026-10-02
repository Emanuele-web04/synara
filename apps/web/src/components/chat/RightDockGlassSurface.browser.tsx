// Right-dock viewers on a whole-window glass shell: real Pierre markup in Chromium, since the
// fill lives in shadow-root CSS that only resolves against the page's custom properties.
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { CodeDiffEditorPane } from "../codeEditor/CodeDiffEditorPane";
import { CodeEditorPane } from "../codeEditor/CodeEditorPane";
import type { CodeEditHistoryControls } from "../codeEditor/pierreEdit";
import { DiffPanelShell } from "../DiffPanelShell";

const root = document.documentElement;

const originalRootStyle = root.getAttribute("style");
const originalRootClassName = root.className;
afterEach(() => {
  root.removeAttribute("data-window-translucency");
  root.className = originalRootClassName;
  if (originalRootStyle === null) root.removeAttribute("style");
  else root.setAttribute("style", originalRootStyle);
});

function mountDockPane(options: { glass: boolean; maximized?: boolean }) {
  if (options.glass) root.setAttribute("data-window-translucency", "window");
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div
        data-slot="sidebar-container"
        data-dock-maximized={options.maximized ? "true" : undefined}
      >
        <div data-right-dock-content style={{ width: 320, height: 240, display: "flex" }}>
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

function viewerParts() {
  const shadow = page.getByRole("textbox").element().getRootNode() as ShadowRoot;
  const query = (selector: string) => {
    const element = shadow.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  return {
    shell: page.getByText("Header").element().closest<HTMLElement>(".app-content-surface"),
    host: shadow.host,
    code: query("[data-code]"),
    file: query("pre"),
    line: query("[data-line]"),
    lineNumber: query("[data-column-number]"),
    gutter: query("[data-gutter]"),
  };
}

// Fully transparent in either serialization: `rgba(0, 0, 0, 0)` or, mid-animation, `oklab(… / 0)`.
const isClear = (element: Element | null) =>
  element !== null && /[,/] 0\)$/.test(getComputedStyle(element).backgroundColor);

it("clears the pane shell and viewer fill, backing the gutter only under scrolled code", async () => {
  // The shell's fill is the theme's `--app-content-surface`, applied by useTheme at runtime.
  root.style.setProperty("--app-content-surface", "transparent");
  const view = await mountDockPane({ glass: true });
  await expect.element(page.getByRole("textbox")).toBeVisible();
  const { shell, host, code, file, line, lineNumber, gutter } = viewerParts();

  expect([shell, host, file, code, line, lineNumber, gutter].map(isClear)).not.toContain(false);

  code.scrollLeft = 120;
  await expect.poll(() => isClear(gutter)).toBe(false);
  code.scrollLeft = 0;
  await expect.poll(() => isClear(gutter)).toBe(true);

  root.style.removeProperty("--app-content-surface");
  await view.unmount();
});

it.each([
  { name: "an opaque window", glass: false, maximized: false },
  { name: "a maximized dock", glass: true, maximized: true },
])("keeps the viewer's own fill on $name", async ({ glass, maximized }) => {
  const view = await mountDockPane({ glass, maximized });
  await expect.element(page.getByRole("textbox")).toBeVisible();
  const { host, code, file, line, lineNumber, gutter } = viewerParts();

  expect([host, file, code, line, lineNumber].map(isClear)).not.toContain(true);
  // No backing animation either: the gutter's cells already paint the viewer fill.
  code.scrollLeft = 120;
  expect(getComputedStyle(gutter).animationName).toBe("none");
  await view.unmount();
});

// Change tint must remain readable independently of the transparent context fill.
// Exercise actual Pierre split/unified rows, rather than testing CSS source strings.
it.each([
  { theme: "light" as const, split: false },
  { theme: "light" as const, split: true },
  { theme: "dark" as const, split: false },
  { theme: "dark" as const, split: true },
])("keeps $theme changed rows dense in glass diffs (split: $split)", async ({ theme, split }) => {
  root.classList.toggle("dark", theme === "dark");
  root.setAttribute("data-window-translucency", "window");
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <div data-slot="sidebar-container">
        <div data-right-dock-content style={{ width: 600, height: 240, display: "flex" }}>
          <CodeDiffEditorPane
            original="const unchanged = 0;\nconst before = 1;\n"
            originalVersion={0}
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
  await expect.element(page.getByRole("textbox")).toBeVisible();
  const shadow = page.getByRole("textbox").element().getRootNode() as ShadowRoot;
  const changes = [
    ...shadow.querySelectorAll<HTMLElement>(
      '[data-line-type="change-addition"], [data-line-type="change-deletion"]',
    ),
  ];
  expect(changes.length).toBeGreaterThan(0);
  // Alpha >= 0.9 protects readable tint over arbitrary window backdrops. Context stays clear.
  for (const row of changes) {
    const color = getComputedStyle(
      row,
      row.hasAttribute("data-line") ? "::after" : null,
    ).backgroundColor;

    const alpha = color.includes("/")
      ? Number(color.match(/\/ ([\d.]+)\)$/)?.[1])
      : color.startsWith("rgba")
        ? Number(color.match(/, ([\d.]+)\)$/)?.[1])
        : 1;
    expect(alpha, color).toBeGreaterThanOrEqual(0.9);
  }
  expect(isClear(shadow.querySelector("[data-code]"))).toBe(true);
  await view.unmount();
  root.classList.remove("dark");
});
