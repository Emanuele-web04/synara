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
const shown = vi.hoisted(() => ({ work: null as unknown, disconnected: false }));
vi.mock("./canvasPane", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./canvasPane")>()),
  useCanvasWork: () => ({
    connection: { supported: true, negotiating: false, disconnected: shown.disconnected },
    query: { data: shown.work, isError: false },
  }),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

import { fitDesignCanvas } from "~/lib/designCanvas";
import { createDefaultRightDockState, openPaneInState } from "~/rightDockStore.logic";
import { RightDock } from "../chat/RightDock";
import { SidebarProvider } from "../ui/sidebar";
import CanvasDockPane, { CANVAS_DOCK_INSPECTOR_KEY } from "./CanvasDockPane";
import { CANVAS_SAVING_DELAY_MS, canvasDockPaneIcons } from "./canvasPane";
import { runCanvasWrite } from "./canvasWorkCache";
import { useCanvasActivityStore } from "./canvasStores";
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
  return { screen, client, resize: (next: number) => screen.rerender(tree(next)) };
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const headerStatus = (kind: string) =>
  document.querySelector(`[data-canvas-header-status="${kind}"]`);
const otherPageMarker = () => document.querySelector('[data-canvas-page-activity="otherPage"]');
const dockTab = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-surface-tab]")].find((item) =>
    item.textContent?.includes(label),
  )!;
/** What CanvasEventBridge records for an agent's write (or the end of its turn). */
const agentWrites = (pageId: string, ended = false) =>
  useCanvasActivityStore.getState().record({
    type: "activity",
    workId: "work1",
    pageId,
    frameIds: ended ? [] : ["mobile"],
    threadId: ThreadId.makeUnsafe("agent"),
    expiresAt: new Date(Date.now() + (ended ? 0 : 40_000)).toISOString(),
    ...(ended ? { ended: true } : {}),
  });

describe("canvas side pane", () => {
  beforeEach(async () => {
    await page.viewport(1400, 800);
    resetCanvasStores();
    shown.work = work;
    shown.disconnected = false;
  });
  afterEach(() => {
    flushCanvasCameras();
    localStorage.clear();
    useCanvasActivityStore.setState({ frames: {}, layers: {} });
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

  it("marks the page name in its header while an agent works on another page", async () => {
    shown.work = {
      ...work,
      pages: [...work.pages, { ...work.pages[0]!, id: "page2", title: "Page 2", frames: [] }],
    };
    const { screen } = await mountPane(760);
    const marker = otherPageMarker;
    try {
      await vi.waitFor(() => expect(viewport()).toBeTruthy());
      // On the open page, the canvas shows it (the outline); the header stays as it is.
      agentWrites("page1");
      await vi.waitFor(() =>
        expect(document.querySelector('[data-canvas-agent-outline="mobile"]')).toBeTruthy(),
      );
      expect(marker()).toBeNull();
      // On another page, the page name in the header gets the indicator, with its label.
      agentWrites("page2");
      await vi.waitFor(() => expect(marker()).toBeTruthy());
      expect(marker()!.closest("button")?.textContent).toContain("Page 1");
      expect(marker()!.getAttribute("aria-label")).toBe("An agent is working on another page");
      // The turn's end takes it away after its fade.
      agentWrites("page2", true);
      await vi.waitFor(() => expect(marker()).toBeNull());
    } finally {
      await screen.unmount();
    }
  });

  it("says in its header when the work is archived or canvas updates are unavailable", async () => {
    const first = await mountPane(760);
    try {
      await vi.waitFor(() => expect(viewport()).toBeTruthy());
      expect(headerStatus("archived")).toBeNull();
      expect(headerStatus("disconnected")).toBeNull();
    } finally {
      await first.screen.unmount();
    }
    // Archived, and the connection down: both, after the page name, as the full layout says.
    shown.work = { ...work, archivedAt: "2026-11-20T00:00:00.000Z" };
    shown.disconnected = true;
    const second = await mountPane(760);
    try {
      await vi.waitFor(() => expect(headerStatus("archived")).toBeTruthy());
      expect(headerStatus("archived")!.textContent).toBe("Archived");
      expect(headerStatus("disconnected")!.textContent).toBe(
        "Canvas updates unavailable. Reconnecting…",
      );
      expect(headerStatus("disconnected")!.getAttribute("role")).toBe("status");
      const pageName = document.querySelector('button[aria-haspopup="menu"]')!;
      expect(
        pageName.compareDocumentPosition(headerStatus("archived")!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      await second.screen.unmount();
    }
  });

  it("says Saving… while a write takes a moment, and Unsaved changes while it waits offline", async () => {
    const first = await mountPane(760);
    try {
      await vi.waitFor(() => expect(viewport()).toBeTruthy());
      // A quick write never shows.
      await runCanvasWrite(first.client, "work1", async () => work);
      await sleep(CANVAS_SAVING_DELAY_MS + 200);
      expect(headerStatus("saving")).toBeNull();
      // A slow one does, after a moment, and goes once it is saved.
      let finish!: () => void;
      const slow = runCanvasWrite(
        first.client,
        "work1",
        () => new Promise<typeof work>((resolve) => (finish = () => resolve(work))),
      );
      expect(headerStatus("saving")).toBeNull();
      await vi.waitFor(() => expect(headerStatus("saving")?.textContent).toBe("Saving..."));
      expect(headerStatus("saving")!.getAttribute("role")).toBe("status");
      finish();
      await slow;
      await vi.waitFor(() => expect(headerStatus("saving")).toBeNull());
    } finally {
      await first.screen.unmount();
    }
    // Offline, a write waits for the connection: the header says so at once.
    shown.disconnected = true;
    const second = await mountPane(760);
    try {
      await vi.waitFor(() => expect(headerStatus("disconnected")).toBeTruthy());
      expect(headerStatus("unsaved")).toBeNull();
      let finish!: () => void;
      const waiting = runCanvasWrite(
        second.client,
        "work1",
        () => new Promise<typeof work>((resolve) => (finish = () => resolve(work))),
      );
      await vi.waitFor(() => expect(headerStatus("unsaved")?.textContent).toBe("Unsaved changes"));
      expect(headerStatus("saving")).toBeNull();
      finish();
      await waiting;
      await vi.waitFor(() => expect(headerStatus("unsaved")).toBeNull());
    } finally {
      await second.screen.unmount();
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

describe("canvas dock tab", () => {
  afterEach(() => {
    useCanvasActivityStore.setState({ frames: {}, layers: {} });
  });

  // The canvas pane behind the browser, which is the tab in front.
  const state = {
    ...openPaneInState(
      openPaneInState(createDefaultRightDockState(), {
        paneId: "canvas-pane",
        kind: "canvas",
        canvasWorkId: "work1",
        canvasPageId: "page1",
      }),
      { paneId: "browser-pane", kind: "browser" },
    ),
    open: true,
  };
  const mountDock = (icons: boolean) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div style={{ display: "flex", width: 1000, height: 400 }}>
          <div style={{ flex: 1 }} />
          <RightDock
            state={state}
            minWidth={300}
            defaultWidth="500px"
            shouldAcceptWidth={() => true}
            addMenuKinds={[]}
            {...(icons ? { paneIconOverrides: canvasDockPaneIcons(state.panes) ?? {} } : {})}
            onSelectPane={() => {}}
            onClosePane={() => {}}
            onCollapse={() => {}}
            onOpenChange={() => {}}
            onAddPane={() => {}}
            renderPane={() => <div />}
          />
        </div>
      </QueryClientProvider>,
    );
  const tab = dockTab;
  // The chip's 16px glyph slot, as drawn.
  const glyph = (label: string) => tab(label).querySelector("span.relative.size-4")!.innerHTML;

  it("shows the agent indicator on the canvas tab from behind another tab, its glyph otherwise", async () => {
    // The dock as every other host draws it, without the canvas icon.
    const plain = await mountDock(false);
    const plainGlyphs = { canvas: glyph("Canvas"), browser: glyph("Browser") };
    await plain.unmount();

    const screen = await mountDock(true);
    const indicator = () => tab("Canvas").querySelector('[data-canvas-page-activity="work"]');
    try {
      // Idle, both tabs draw exactly what they always do.
      expect(glyph("Canvas")).toBe(plainGlyphs.canvas);
      expect(glyph("Browser")).toBe(plainGlyphs.browser);
      expect(indicator()).toBeNull();

      // An agent writes on any page of the work: the canvas tab shows it; the browser tab does not.
      agentWrites("page2");
      await vi.waitFor(() => expect(indicator()).toBeTruthy());
      expect(indicator()!.getAttribute("aria-label")).toBe("An agent is working on this canvas");
      expect(tab("Browser").querySelector("[data-canvas-page-activity]")).toBeNull();
      expect(glyph("Browser")).toBe(plainGlyphs.browser);
      // It fades in, over the glyph fading out.
      await vi.waitFor(() =>
        expect(
          getComputedStyle(indicator()!.querySelector("[data-canvas-agent-rain]")!).opacity,
        ).toBe("1"),
      );

      // The turn ends: after the fade the tab has its glyph back, unchanged.
      agentWrites("page2", true);
      await vi.waitFor(() => expect(indicator()).toBeNull());
      expect(glyph("Canvas")).toBe(plainGlyphs.canvas);
    } finally {
      await screen.unmount();
    }
  });
});
