// FILE: EditorWorkspaceView.browser.tsx
// Purpose: Preserve explicit Markdown view choices across editor navigation.
// Layer: Component browser regressions

import "../index.css";
import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { useEditorRailStore } from "../editorRailStore";
import { installEditorWorkspaceFixture, makeView } from "./EditorWorkspaceView.test-support";
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../theme/theme.logic";
import { getAppTypographyScale } from "../lib/appTypography";

installEditorWorkspaceFixture();

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
