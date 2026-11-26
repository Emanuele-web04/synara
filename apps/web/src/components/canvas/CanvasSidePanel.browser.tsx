import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const native = vi.hoisted(() => ({
  canvas: { editLayers: vi.fn(), layout: vi.fn(), getAsset: vi.fn(), fontCatalog: vi.fn() },
  contextMenu: { show: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import { SidebarProvider } from "../ui/sidebar";
import { CanvasSidePanel, type CanvasSideTab } from "./CanvasSidePanel";
import { canvasWorkQueryKey } from "./canvasWorkCache";
import { flushCanvasCameras } from "./editor/canvasCamera";
import { CanvasEditorProvider } from "./editor/CanvasEditorContext";
import { element, frameOf, resetCanvasStores, workOf } from "./editor/canvasEditorTestHarness";
import { CanvasViewport } from "./editor/CanvasViewport";

const work = workOf([
  frameOf("f1", [element("box", "width:100px;height:60px;background:#0a0")], ["box"], {
    x: 40,
    y: 40,
  }),
]);

function Layout() {
  const [tab, setTab] = useState<CanvasSideTab>("chat");
  return (
    <CanvasEditorProvider work={work} pageId="page1" readOnly={false}>
      <div className="flex h-[500px] w-[1000px]">
        <CanvasSidePanel
          tab={tab}
          onTab={setTab}
          commentCount={0}
          hidden={false}
          panels={{ chat: <p>Chat</p>, layers: <p>Layers</p>, comments: <p>Comments</p> }}
        />
        <div className="relative min-w-0 flex-1">
          <CanvasViewport />
        </div>
      </div>
    </CanvasEditorProvider>
  );
}

const frameLeft = () =>
  document.querySelector<HTMLElement>('[data-canvas-frame-id="f1"]')!.getBoundingClientRect().left;
const panel = () => document.querySelector<HTMLElement>("[data-canvas-side-panel]")!;

describe("canvas side panel", () => {
  beforeEach(async () => {
    await page.viewport(1200, 700);
    resetCanvasStores();
  });
  afterEach(() => flushCanvasCameras());

  it("gives each tab its own width and keeps the frames still on screen when it changes", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(canvasWorkQueryKey("work1"), work);
    const screen = await render(
      <QueryClientProvider client={client}>
        <SidebarProvider>
          <Layout />
        </SidebarProvider>
      </QueryClientProvider>,
    );
    try {
      // The chat is wider; Layers and Comments take 240 px.
      expect(panel().getBoundingClientRect().width).toBe(360);
      const before = frameLeft();
      await page.getByRole("tab", { name: "Layers" }).click();
      await vi.waitFor(() => expect(panel().getBoundingClientRect().width).toBe(240));
      expect(frameLeft()).toBeCloseTo(before, 0);

      // Dragging the edge resizes the open tab only, frames still in place; it is remembered.
      const edge = page.getByRole("separator", { name: "Resize the panel" });
      const box = edge.element().getBoundingClientRect();
      await userEvent.hover(edge);
      const x = box.left + box.width / 2;
      const y = box.top + 100;
      edge
        .element()
        .dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }),
        );
      const overlay = document.body.lastElementChild!;
      for (const step of [20, 40, 60])
        overlay.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            buttons: 1,
            clientX: x + step,
            clientY: y,
          }),
        );
      overlay.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: x + 60, clientY: y }),
      );
      await vi.waitFor(() => expect(panel().getBoundingClientRect().width).toBe(300));
      expect(frameLeft()).toBeCloseTo(before, 0);
      expect(localStorage.getItem("synara:canvas-left-width:layers")).toBe("300");

      await page.getByRole("tab", { name: "Chat" }).click();
      await vi.waitFor(() => expect(panel().getBoundingClientRect().width).toBe(360));
      expect(frameLeft()).toBeCloseTo(before, 0);
    } finally {
      await screen.unmount();
    }
  });

  it("names the Layers tab's shortcut in its tooltip", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(canvasWorkQueryKey("work1"), work);
    const screen = await render(
      <QueryClientProvider client={client}>
        <SidebarProvider>
          <Layout />
        </SidebarProvider>
      </QueryClientProvider>,
    );
    try {
      const layers = page.getByRole("tab", { name: "Layers" });
      // The app's tooltip replaces the native title.
      expect(layers.element().getAttribute("title")).toBeNull();
      await userEvent.hover(layers);
      const label = /Mac/.test(navigator.platform) ? "⌥1" : "Alt+1";
      await vi.waitFor(() =>
        expect(
          document.querySelector<HTMLElement>(`[data-slot="kbd"][aria-label="${label}"]`),
        ).toBeTruthy(),
      );
      // Tabs without a shortcut keep a plain chip.
      await userEvent.hover(page.getByRole("tab", { name: "Comments" }));
      expect(
        page.getByRole("tab", { name: "Comments" }).element().getAttribute("title"),
      ).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
