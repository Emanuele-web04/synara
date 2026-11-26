import "../../index.css";

import { CANVAS_DEFAULT_VIEWPORT, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const native = vi.hoisted(() => ({
  canvas: {
    editLayers: vi.fn(),
    layout: vi.fn(),
    get: vi.fn(),
    getAsset: vi.fn(),
    setChatSelection: vi.fn(),
    fontCatalog: vi.fn(),
  },
  contextMenu: { show: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));
const shown = vi.hoisted(() => ({ work: null as unknown }));
vi.mock("./canvasPane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./canvasPane")>()),
  useCanvasWork: () => ({
    connection: { supported: true, negotiating: false, disconnected: false },
    query: { data: shown.work, isError: false },
  }),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

import { fitDesignCanvas } from "~/lib/designCanvas";
import { SidebarProvider } from "../ui/sidebar";
import CanvasDockPane, { CANVAS_DOCK_INSPECTOR_KEY } from "./CanvasDockPane";
import { flushCanvasCameras } from "./editor/canvasCamera";
import { frameOf, resetCanvasStores, workOf } from "./editor/canvasEditorTestHarness";

const frames = [
  frameOf("desktop", [], [], { width: 1440, height: 1024 }),
  frameOf("mobile", [], [], { x: 1600, width: 390, height: 844 }),
];
// A page this client has not placed yet (the page's untouched default camera).
const work = workOf(frames, { viewport: CANVAS_DEFAULT_VIEWPORT });

function Pane({ width }: { width: number }) {
  return (
    <div className="flex h-[520px] flex-col" style={{ width }} data-testid="pane">
      <CanvasDockPane hostThreadId={ThreadId.makeUnsafe("t1")} workId="work1" pageId="page1" />
    </div>
  );
}

async function mountPane(width: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next: number) => (
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <Pane width={next} />
      </SidebarProvider>
    </QueryClientProvider>
  );
  const screen = await render(tree(width));
  return { screen, resize: (next: number) => screen.rerender(tree(next)) };
}

const inspector = () => document.querySelector('[role="region"][aria-label="Inspector"]');
const toggle = () =>
  document.querySelector<HTMLButtonElement>("[data-canvas-dock-inspector-toggle]");
const viewport = () => document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
function camera() {
  const world = viewport().firstElementChild as HTMLElement;
  const match = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(
    world.style.transform,
  );
  if (!match) throw new Error(`No camera transform: ${world.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}
const fitNow = () =>
  fitDesignCanvas(frames, viewport().clientWidth, viewport().clientHeight, { maxZoom: 2 });

describe("canvas side pane", () => {
  beforeEach(async () => {
    await page.viewport(1400, 800);
    resetCanvasStores();
    shown.work = work;
  });
  afterEach(() => {
    flushCanvasCameras();
    localStorage.clear();
  });

  it("opens with the inspector closed and remembers this viewer's choice", async () => {
    const first = await mountPane(760);
    try {
      await vi.waitFor(() => expect(viewport()).toBeTruthy());
      await vi.waitFor(() => expect(toggle()).toBeTruthy());
      expect(inspector()).toBeNull();
      expect(toggle()!.getAttribute("aria-pressed")).toBe("false");
      expect(toggle()!.getAttribute("aria-label")).toBe("Show inspector");
      toggle()!.click();
      await vi.waitFor(() => expect(inspector()).toBeTruthy());
      expect(toggle()!.getAttribute("aria-pressed")).toBe("true");
      expect(localStorage.getItem(CANVAS_DOCK_INSPECTOR_KEY)).toBe("open");
    } finally {
      await first.screen.unmount();
    }
    const second = await mountPane(760);
    try {
      // Open again for this viewer, from the first frame.
      await vi.waitFor(() => expect(inspector()).toBeTruthy());
      toggle()!.click();
      await vi.waitFor(() => expect(inspector()).toBeNull());
      expect(localStorage.getItem(CANVAS_DOCK_INSPECTOR_KEY)).toBe("closed");
    } finally {
      await second.screen.unmount();
    }
  });

  it("expands to the full canvas on the same work and page, with this chat", async () => {
    navigate.mockReset();
    const { screen } = await mountPane(760);
    try {
      await vi.waitFor(() => expect(viewport()).toBeTruthy());
      document.querySelector<HTMLButtonElement>('button[aria-label="Open full size"]')!.click();
      expect(navigate).toHaveBeenCalledWith({
        to: "/canvas/$workId",
        params: { workId: "work1" },
        search: { page: "page1", chat: "t1" },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the middle of the canvas in the middle when the inspector opens and closes", async () => {
    const { screen } = await mountPane(760);
    try {
      await vi.waitFor(() => expect(toggle()).toBeTruthy());
      await vi.waitFor(() => expect(camera().zoom).toBeCloseTo(fitNow().zoom, 5));
      // The world point at the canvas's centre.
      const centre = () => (viewport().clientWidth / 2 - camera().x) / camera().zoom;
      const before = centre();
      const zoom = camera().zoom;
      toggle()!.click();
      await vi.waitFor(() => expect(inspector()).toBeTruthy());
      await vi.waitFor(() => expect(centre()).toBeCloseTo(before, 0));
      expect(camera().zoom).toBe(zoom);
      toggle()!.click();
      await vi.waitFor(() => expect(inspector()).toBeNull());
      await vi.waitFor(() => expect(centre()).toBeCloseTo(before, 0));
    } finally {
      await screen.unmount();
    }
  });

  it("has no inspector toggle where the pane is too narrow for it", async () => {
    localStorage.setItem(CANVAS_DOCK_INSPECTOR_KEY, "open");
    const { screen } = await mountPane(480);
    try {
      await vi.waitFor(() => expect(viewport()).toBeTruthy());
      expect(toggle()).toBeNull();
      expect(inspector()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("fits the canvas at the size the pane opens to, not the size it starts at", async () => {
    // The dock opens narrow and grows to its width.
    const { screen, resize } = await mountPane(240);
    try {
      await vi.waitFor(() => expect(viewport()).toBeTruthy());
      await vi.waitFor(() => expect(camera().zoom).toBeCloseTo(fitNow().zoom, 5));
      const narrow = camera().zoom;
      await resize(760);
      await vi.waitFor(() => {
        const fit = fitNow();
        expect(camera().zoom).toBeCloseTo(fit.zoom, 5);
        expect(camera().x).toBeCloseTo(fit.x, 2);
        expect(camera().y).toBeCloseTo(fit.y, 2);
      });
      expect(camera().zoom).toBeGreaterThan(narrow * 2);
    } finally {
      await screen.unmount();
    }
  });
});
