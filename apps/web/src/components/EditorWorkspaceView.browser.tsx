// FILE: EditorWorkspaceView.browser.tsx
// Purpose: Preserve explicit Markdown view choices across editor navigation.
// Layer: Component browser regressions

import "../index.css";

import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { EditorWorkspaceView } from "./EditorWorkspaceView";
import { useEditorRailStore } from "../editorRailStore";
import { SidebarProvider } from "./ui/sidebar";
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../theme/theme.logic";
import { getAppTypographyScale } from "../lib/appTypography";

const WORKSPACE_ROOT = "/Users/tester/project";
let previousApi: PropertyDescriptor | undefined;
let previousAppearance: Map<string, string | null>;

beforeEach(() => {
  previousAppearance = new Map(
    ["style", "class", "data-window-material", "data-window-translucency"].map((attribute) => [
      attribute,
      document.documentElement.getAttribute(attribute),
    ]),
  );
  previousApi = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      projects: {
        readFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
          relativePath,
          contents: "# Markdown document\n",
          truncated: false,
          version: `sha256:${"1".repeat(64)}`,
          encoding: "utf8",
          lineEnding: "lf",
        })),
        searchEntries: vi.fn(async () => ({ entries: [], truncated: false })),
        listDirectories: vi.fn(async () => ({ directories: [] })),
      },
      git: { readWorkingTreeDiff: vi.fn(async () => ({ patch: "", truncated: false })) },
    } as unknown as NativeApi,
  });
});

afterEach(async () => {
  await cleanup();
  for (const [attribute, value] of previousAppearance) {
    if (value === null) document.documentElement.removeAttribute(attribute);
    else document.documentElement.setAttribute(attribute, value);
  }
  if (previousApi) Object.defineProperty(window, "nativeApi", previousApi);
  else Reflect.deleteProperty(window, "nativeApi");
});

function makeView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    centerMode: "file" | "diff" | "fileEdit" = "file",
    filePath = "README.md",
    workspaceRoot = WORKSPACE_ROOT,
  ) => (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <EditorWorkspaceView
          workspaceRoot={workspaceRoot}
          projectName="project"
          selectedFilePath={filePath}
          expandedDirectories={new Set()}
          centerMode={centerMode}
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff pane</div>}
          chatPanel={<div>Chat pane</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          editFilePath={centerMode === "fileEdit" ? filePath : null}
          editDiffBaseRev={null}
          onEditFile={vi.fn()}
          onCloseEdit={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </SidebarProvider>
    </QueryClientProvider>
  );
}

const source = () => page.getByRole("radio", { name: "Source", exact: true });
const preview = () => page.getByRole("radio", { name: "Preview", exact: true });

it.each(["light", "dark"] as const)(
  "keeps editor controls and surfaces themed in %s at 18px",
  async (theme) => {
    const root = document.documentElement;
    const originalPack = resolveThemePack(DEFAULT_THEME_STATE, theme);
    const scale = getAppTypographyScale(18);
    root.classList.toggle("dark", theme === "dark");
    for (const [key, value] of Object.entries(scale)) {
      const token = key
        .replace(/Px$/, "")
        .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      root.style.setProperty(`--app-font-size-${token}`, `${value}px`);
    }
    const view = makeView();
    const screen = await render(view());
    await expect.element(preview()).toHaveAttribute("aria-checked", "true");
    for (const scope of ["window", "sidebar", "none"] as const) {
      const build = buildThemeCssVariables(
        { ...originalPack, theme: { ...originalPack.theme, opaqueWindows: scope === "none" } },
        theme,
        {
          electron: true,
          isMac: true,
          translucency: { opacity: 0.8, blur: 20, sidebarOnly: scope === "sidebar" },
        },
      );
      for (const [name, value] of Object.entries(build.variables))
        root.style.setProperty(name, value);
      root.setAttribute("data-window-material", build.material);
      root.setAttribute("data-window-translucency", build.translucencyScope);
      const workspace = document.querySelector<HTMLElement>("[data-editor-workspace]")!;
      const surfaces = [workspace, ...workspace.querySelectorAll("aside")];
      for (const surface of surfaces) {
        const clear = getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)";
        expect(clear, `${scope} ${surface.tagName}`).toBe(scope === "window");
      }
      expect(
        getComputedStyle(page.getByText("project", { exact: true }).first().element()).fontSize,
      ).toBe(`${scale.uiLgPx}px`);
      await source().click();
      await screen.rerender(view("diff"));
      await expect.element(source()).not.toBeInTheDocument();
      await screen.rerender(view());
      await expect.element(source()).toHaveAttribute("aria-checked", "true");
      // Files / Diff / Search are published to the fixed rail while the view is mounted.
      const railItem = (label: string) => {
        const item = useEditorRailStore.getState().items?.find((entry) => entry.label === label);
        if (!item) throw new Error(`Rail item ${label} is not published`);
        return item;
      };
      const railLabels = () =>
        useEditorRailStore.getState().items?.map((entry) => entry.label) ?? [];
      await expect.poll(railLabels).toContain("Hide files sidebar");
      railItem("Search files").onSelect();
      await page.getByPlaceholder("Search files...").fill("settings");
      await expect.element(page.getByPlaceholder("Search files...")).toHaveValue("settings");
      await expect.poll(railLabels).toContain("Hide search sidebar");
      railItem("Files").onSelect();
      await expect.element(source()).toHaveAttribute("aria-checked", "true");
      await expect.poll(railLabels).toContain("Hide files sidebar");
    }
  },
);

it("keeps independent choices for multiple files and workspaces", async () => {
  const view = makeView();
  const screen = await render(view());
  await source().click();
  await screen.rerender(view("file", "docs/guide.markdown"));
  await expect.element(preview()).toHaveAttribute("aria-checked", "true");
  await source().click();
  await screen.rerender(view());
  await expect.element(source()).toHaveAttribute("aria-checked", "true");
  await preview().click();
  await screen.rerender(view("file", "docs/guide.markdown"));
  await expect.element(source()).toHaveAttribute("aria-checked", "true");
  await screen.rerender(view("file", "docs/guide.markdown", "/Users/tester/other"));
  await expect.element(preview()).toHaveAttribute("aria-checked", "true");
  await screen.rerender(view("file", "docs/guide.markdown"));
  await expect.element(source()).toHaveAttribute("aria-checked", "true");
});

it("keeps non-Markdown files in Source without a Markdown toggle", async () => {
  const screen = await render(makeView()("file", "src/app.ts"));
  await expect.element(source()).not.toBeInTheDocument();
  await expect.element(preview()).not.toBeInTheDocument();
  await screen.unmount();
});
