import "../../../index.css";

import type { CanvasWork, DesignFrame } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const canvas = vi.hoisted(() => ({
  editLayers: vi.fn(),
  layout: vi.fn(),
  fontCatalog: vi.fn(),
  addFont: vi.fn(),
  changePages: vi.fn(),
}));
vi.mock("../../../nativeApi", () => ({ ensureNativeApi: () => ({ canvas }) }));

import { useCanvasEditorStore, type CanvasSelectionItem } from "../canvasStores";
import { CanvasEditorProvider, useCanvasEditor } from "../editor/CanvasEditorContext";
import { CanvasFrameView } from "../editor/CanvasFrameView";
import { CanvasInspector } from "./CanvasInspector";
import { pageColorOf, themeCanvasColor } from "./PageSection";

const frame: DesignFrame = {
  id: "frame1",
  title: "Hero",
  x: 40,
  y: 60,
  width: 320,
  height: 200,
  revision: 1,
  style: "background: #ffffff",
  layers: {
    roots: ["box"],
    nodes: [
      {
        id: "box",
        type: "element",
        tag: "div",
        attributes: { style: "display: flex; flex-direction: column; gap: 8px; padding: 12px" },
        children: ["title"],
      },
      {
        id: "title",
        type: "element",
        tag: "p",
        attributes: { style: "color: #ff0000; font-size: 20px; margin: 4px" },
        children: ["titleText"],
      },
      { id: "titleText", type: "text", text: "Hello" },
    ],
  },
};

const work = {
  id: "work1",
  title: "Work",
  folderId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  version: 3,
  kind: "work",
  projectId: null,
  assets: [],
  chats: [],
  pages: [
    {
      id: "page1",
      title: "Page",
      viewport: { x: 0, y: 0, zoom: 1 },
      frames: [frame],
      comments: [],
    },
  ],
} as unknown as CanvasWork;

function Frames() {
  const editor = useCanvasEditor();
  const context = useMemo(() => ({ fonts: editor.fonts, assetUrl: () => null }), [editor.fonts]);
  return (
    <div className="relative h-[300px] w-[420px] shrink-0">
      {editor.page.frames.map((item) => (
        <CanvasFrameView
          key={item.id}
          frame={item}
          context={context}
          zoom={1}
          selected={false}
          hovered={false}
          agentActive={false}
          onRegister={editor.registerFrame}
        />
      ))}
    </div>
  );
}

function select(items: CanvasSelectionItem[]) {
  useCanvasEditorStore.getState().setSelection(work.id, "page1", items);
}

async function mount(readOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CanvasEditorProvider work={work} pageId="page1" readOnly={readOnly}>
        <div className="flex w-[720px]">
          <Frames />
          <CanvasInspector className="h-[760px] w-[280px] shrink-0 border-s" />
        </div>
      </CanvasEditorProvider>
    </QueryClientProvider>,
  );
}

describe("CanvasInspector", () => {
  beforeEach(async () => {
    await page.viewport(1100, 900);
    canvas.editLayers.mockReset().mockResolvedValue({ work, createdNodeIds: [], dropped: [] });
    canvas.layout.mockReset().mockResolvedValue(work);
    canvas.fontCatalog.mockReset().mockResolvedValue({
      families: [
        {
          family: "Inter",
          category: "sans-serif",
          weights: [100, 900],
          italic: true,
          variable: true,
        },
      ],
      available: true,
    });
    canvas.addFont.mockReset().mockResolvedValue(work);
    canvas.changePages.mockReset().mockResolvedValue(work);
    select([]);
  });
  afterEach(() => select([]));

  it("shows the Page section without a selection and saves the page's canvas colour", async () => {
    await mount();
    await expect.element(page.getByRole("heading", { name: "Page", exact: true })).toBeVisible();
    // Unset, the field shows the theme's canvas colour: the backdrop, a shade off the app's
    // background so white frames keep their edges.
    const color = page.getByRole("textbox", { name: "Page color", exact: true });
    const backdrop = themeCanvasColor();
    expect(backdrop).toMatch(/^#[0-9a-f]{6}$/);
    expect(backdrop).not.toBe(
      pageColorOf(getComputedStyle(document.documentElement).getPropertyValue("--background")),
    );
    await expect.element(color).toHaveValue(backdrop.slice(1).toUpperCase());
    await color.fill("282828");
    await color
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(canvas.changePages).toHaveBeenCalled());
    expect(canvas.changePages.mock.calls[0]![0]).toEqual({
      workId: "work1",
      operation: { type: "set_color", id: "page1", color: "#282828" },
    });
  });

  it("edits a text layer's color as one inline style patch", async () => {
    select([{ kind: "layer", frameId: "frame1", layerId: "title" }]);
    await mount();
    await expect.element(page.getByRole("heading", { name: "Text" })).toBeVisible();
    const color = page.getByRole("textbox", { name: "Text color", exact: true });
    await expect.element(color).toHaveValue("FF0000");
    await color.fill("00ff00");
    await color
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(canvas.editLayers).toHaveBeenCalled());
    expect(canvas.editLayers.mock.calls[0]![0].edit.operations).toEqual([
      { type: "set_styles", nodeId: "title", styles: { color: "#00FF00" } },
    ]);
    // Declarations without a dedicated control are listed under Other styles.
    await expect.element(page.getByText("margin:")).toBeVisible();
  });

  it("shows every colour channel row in the picker uncut, HSL with decimals included", async () => {
    select([{ kind: "layer", frameId: "frame1", layerId: "title" }]);
    await mount();
    await page.getByRole("button", { name: "Open the color picker for Text color" }).click();
    const hsl = await vi.waitFor(() => {
      const row = document.querySelector<HTMLElement>('[data-color-channels="hsl"]');
      if (!row) throw new Error("no HSL row yet");
      return row;
    });
    for (const name of ["oklch", "hsl", "rgb"]) {
      const row = document.querySelector<HTMLElement>(`[data-color-channels="${name}"]`)!;
      expect(row.scrollWidth, name).toBeLessThanOrEqual(row.clientWidth);
    }
    // The longest HSL text the picker writes: a hue and two percentages with one decimal each.
    hsl.textContent = "359.9 99.9% 99.9%";
    expect(hsl.scrollWidth).toBeLessThanOrEqual(hsl.clientWidth);
  });

  it("shows frame geometry and flex controls for a frame", async () => {
    select([{ kind: "frame", frameId: "frame1" }]);
    await mount();
    await expect.element(page.getByRole("textbox", { name: "X position" })).toHaveValue("40");
    await expect.element(page.getByRole("textbox", { name: "Width" })).toHaveValue("320");
    await expect.element(page.getByRole("button", { name: "Add flex" })).toBeVisible();
    const width = page.getByRole("textbox", { name: "Width" });
    await width.fill("400");
    await width
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(canvas.layout).toHaveBeenCalled());
    expect(canvas.layout.mock.calls[0]![0].frames).toEqual([{ id: "frame1", width: 400 }]);
  });

  it("reads flex layout from a flex container", async () => {
    select([{ kind: "layer", frameId: "frame1", layerId: "box" }]);
    await mount();
    await expect
      .element(page.getByRole("radio", { name: "Column" }))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByRole("textbox", { name: "Gap" })).toHaveValue("8");
    await expect
      .element(page.getByRole("textbox", { name: "Horizontal padding" }))
      .toHaveValue("12");
    // The Flex label row: Remove flex beside the options menu.
    await expect.element(page.getByRole("button", { name: "Remove flex" })).toBeVisible();
    await page.getByRole("button", { name: "More flex options" }).click();
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Space between vertically" }))
      .toBeVisible();
  });

  it("disables editing in a read-only canvas", async () => {
    select([{ kind: "layer", frameId: "frame1", layerId: "title" }]);
    await mount(true);
    await expect.element(page.getByText("Read only")).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Text color", exact: true }))
      .toBeDisabled();
  });
});
