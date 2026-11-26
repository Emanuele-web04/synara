import "../../../index.css";

import type { CanvasPage, CanvasWork, DesignFrame } from "@synara/contracts";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const native = vi.hoisted(() => ({
  canvas: {
    editLayers: vi.fn(),
    layout: vi.fn(),
    get: vi.fn(),
    getAsset: vi.fn(),
    setChatSelection: vi.fn(),
  },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import { fitDesignCanvas } from "~/lib/designCanvas";
import { executionStorage } from "~/lib/hosts/executionStorage";
import { SidebarProvider } from "../../ui/sidebar";
import { canvasWorkQueryKey, canvasWorkQueryOptions } from "../canvasWorkCache";
import { flushCanvasCameras } from "./canvasCamera";
import { CanvasEditorProvider } from "./CanvasEditorContext";
import { CanvasViewport } from "./CanvasViewport";
import { CANVAS_FIRST_FIT_SETTLE_MS } from "./useCanvasCamera";

const frame = (id: string, x: number, width: number, height: number): DesignFrame => ({
  id,
  title: id,
  x,
  y: 0,
  width,
  height,
  revision: 1,
  style: "background:#ffffff",
  layers: { roots: [], nodes: [] },
});
const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 0, 0, second)).toISOString();
const DEFAULT_VIEWPORT = { x: 64, y: 80, zoom: 0.5 };
const page = (id: string, frames: DesignFrame[], viewport = DEFAULT_VIEWPORT): CanvasPage => ({
  id,
  title: id,
  viewport,
  frames,
  comments: [],
});
const workWith = (pages: CanvasPage[], updatedAt = at(1)): CanvasWork => ({
  version: 3,
  kind: "work",
  id: "work1",
  title: "Work",
  folderId: null,
  projectId: null,
  createdAt: at(0),
  updatedAt,
  archivedAt: null,
  assets: [],
  chats: [],
  pages,
});

/** One window's editor on a page; several share the query cache like two dock panes. */
function Window({ pageId, label, width = 500 }: { pageId: string; label: string; width?: number }) {
  const { data } = useQuery({ ...canvasWorkQueryOptions("work1"), enabled: false });
  if (!data) return null;
  return (
    <CanvasEditorProvider work={data} pageId={pageId} readOnly={false}>
      <div data-testid={label} className="relative h-[400px] shrink-0" style={{ width }}>
        <CanvasViewport />
      </div>
    </CanvasEditorProvider>
  );
}

let client: QueryClient;
async function mount(
  work: CanvasWork,
  windows: { pageId: string; label: string; width?: number }[],
) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(canvasWorkQueryKey("work1"), work);
  const tree = (items: typeof windows) => (
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <div className="flex gap-2">
          {items.map((item) => (
            <Window key={item.label} {...item} />
          ))}
        </div>
      </SidebarProvider>
    </QueryClientProvider>
  );
  const screen = await render(tree(windows));
  return { screen, rerender: (items: typeof windows) => screen.rerender(tree(items)) };
}

const viewportOf = (label: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${label}"] [data-canvas-viewport]`)!;
/** The camera a window shows, read from its world transform. */
function camera(label: string) {
  const world = viewportOf(label).firstElementChild as HTMLElement;
  const match = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(
    world.style.transform,
  );
  if (!match) throw new Error(`No camera transform: ${world.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}
const expectCamera = (label: string, expected: { x: number; y: number; zoom: number }) => {
  const actual = camera(label);
  expect(actual.x).toBeCloseTo(expected.x, 3);
  expect(actual.y).toBeCloseTo(expected.y, 3);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 5);
};
const fitFor = (label: string, frames: DesignFrame[]) => {
  const element = viewportOf(label);
  return fitDesignCanvas(frames, element.clientWidth, element.clientHeight, { maxZoom: 2 });
};
function wheel(label: string, deltaX: number, deltaY: number) {
  viewportOf(label).dispatchEvent(
    new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true }),
  );
}
const storedCameras = () =>
  JSON.parse(executionStorage.getItem("synara:canvas-cameras:v1") ?? "{}") as Record<
    string,
    { x: number; y: number; zoom: number }
  >;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const serverWrites = () =>
  native.canvas.layout.mock.calls.length + native.canvas.editLayers.mock.calls.length;

describe("per-client camera", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
  });
  afterEach(() => {
    flushCanvasCameras();
    localStorage.clear();
  });

  it("fits a populated page on first visit in two windows that never write while idle", async () => {
    const frames = [frame("desktop", 0, 1440, 1024), frame("mobile", 1600, 390, 844)];
    const { screen } = await mount(workWith([page("page1", frames)]), [
      { pageId: "page1", label: "left" },
      { pageId: "page1", label: "right" },
    ]);
    try {
      // B4: the fit is what shows, not the page's untouched default camera.
      await vi.waitFor(() => expectCamera("left", fitFor("left", frames)));
      expectCamera("right", fitFor("right", frames));
      expect(camera("left").zoom).not.toBe(DEFAULT_VIEWPORT.zoom);
      await sleep(900);
      expect(serverWrites()).toBe(0);

      // B5: one window's pan stays in that window and still writes nothing to the server.
      const right = camera("right");
      wheel("left", 30, 120);
      await vi.waitFor(() => expect(camera("left").y).toBeCloseTo(fitFor("left", frames).y - 120));
      await sleep(900);
      expectCamera("right", right);
      expect(serverWrites()).toBe(0);
      const stored = storedCameras()["work1/page1"]!;
      expectCamera("left", stored);
    } finally {
      await screen.unmount();
    }
  });

  it("centres an empty page's origin at 100% and fits its first frames", async () => {
    const { screen } = await mount(workWith([page("page1", [])]), [
      { pageId: "page1", label: "only" },
    ]);
    try {
      const element = viewportOf("only");
      await vi.waitFor(() =>
        expectCamera("only", { x: element.clientWidth / 2, y: element.clientHeight / 2, zoom: 1 }),
      );
      // The automatic centre is not remembered: the first frames still fit.
      expect(storedCameras()["work1/page1"]).toBeUndefined();
      const frames = [frame("first", 0, 800, 600)];
      client.setQueryData(canvasWorkQueryKey("work1"), workWith([page("page1", frames)], at(2)));
      await vi.waitFor(() => expectCamera("only", fitFor("only", frames)));
      expect(serverWrites()).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("fits again while a pane opening around it is still taking its size", async () => {
    const frames = [frame("desktop", 0, 1440, 1024), frame("mobile", 1600, 390, 844)];
    // A side pane that opens narrow and then widens: the first fit lands on the narrow canvas.
    const { screen, rerender } = await mount(workWith([page("page1", frames)]), [
      { pageId: "page1", label: "pane", width: 180 },
    ]);
    try {
      await vi.waitFor(() => expectCamera("pane", fitFor("pane", frames)));
      const narrow = camera("pane").zoom;
      await rerender([{ pageId: "page1", label: "pane", width: 560 }]);
      // The camera follows to the fit for the size the pane keeps (not the narrow zoom).
      await vi.waitFor(() => expectCamera("pane", fitFor("pane", frames)));
      expect(camera("pane").zoom).toBeGreaterThan(narrow * 2);
      flushCanvasCameras();
      expect(storedCameras()["work1/page1"]!.zoom).toBeCloseTo(fitFor("pane", frames).zoom, 5);

      // Once the user moves the camera, a resize leaves it where they put it.
      wheel("pane", 0, 60);
      await vi.waitFor(() => expect(camera("pane").y).toBeCloseTo(fitFor("pane", frames).y - 60));
      const moved = camera("pane");
      await rerender([{ pageId: "page1", label: "pane", width: 420 }]);
      await sleep(300);
      expectCamera("pane", moved);
      expect(serverWrites()).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("stops fitting again once the canvas has kept its size for a moment", async () => {
    const frames = [frame("only", 0, 800, 600)];
    const { screen, rerender } = await mount(workWith([page("page1", frames)]), [
      { pageId: "page1", label: "pane", width: 300 },
    ]);
    try {
      await vi.waitFor(() => expectCamera("pane", fitFor("pane", frames)));
      const settled = camera("pane");
      await sleep(CANVAS_FIRST_FIT_SETTLE_MS + 200);
      // A later resize (the user dragging the pane wider) keeps the camera.
      await rerender([{ pageId: "page1", label: "pane", width: 520 }]);
      await sleep(300);
      expectCamera("pane", settled);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps each page's camera on that page across page switches and reopening", async () => {
    const work = workWith([
      page("page1", [frame("one", 0, 300, 200)], { x: 10, y: 20, zoom: 1 }),
      page("page2", [frame("two", 0, 300, 200)], { x: -40, y: 5, zoom: 2 }),
    ]);
    const { screen, rerender } = await mount(work, [{ pageId: "page1", label: "pane" }]);
    try {
      // A page saved with a camera opens there the first time (its first-open default).
      await vi.waitFor(() => expectCamera("pane", { x: 10, y: 20, zoom: 1 }));
      wheel("pane", 0, 50);
      await vi.waitFor(() => expectCamera("pane", { x: 10, y: -30, zoom: 1 }));

      // B6: switching pages shows page 2's camera and never stores page 1's camera under it.
      await rerender([{ pageId: "page2", label: "pane" }]);
      await vi.waitFor(() => expectCamera("pane", { x: -40, y: 5, zoom: 2 }));
      await sleep(500);
      expect(storedCameras()).toEqual({ "work1/page1": { x: 10, y: -30, zoom: 1 } });

      await rerender([{ pageId: "page1", label: "pane" }]);
      await vi.waitFor(() => expectCamera("pane", { x: 10, y: -30, zoom: 1 }));
      await screen.unmount();

      // Reopening restores this client's camera, not the page's saved one.
      const reopened = await mount(work, [{ pageId: "page1", label: "pane" }]);
      await vi.waitFor(() => expectCamera("pane", { x: 10, y: -30, zoom: 1 }));
      await reopened.screen.unmount();
      expect(serverWrites()).toBe(0);
    } finally {
      await screen.unmount().catch(() => {});
    }
  });
});
