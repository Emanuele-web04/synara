import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  canvas: {
    changePages: vi.fn(),
    update: vi.fn(),
    editLayers: vi.fn(),
    layout: vi.fn(),
    restoreFrames: vi.fn(),
    get: vi.fn(),
    getAsset: vi.fn(),
    setChatSelection: vi.fn(),
  },
  contextMenu: { show: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import type {
  CanvasPage,
  CanvasPageChangeInput,
  CanvasPageDivider,
  CanvasResourceUpdateInput,
  CanvasWork,
  ContextMenuItem,
} from "@synara/contracts";
import {
  canvasPageList,
  canvasPageListParts,
  moveCanvasPageListItem,
  type CanvasPageListItem,
} from "@synara/shared/designCanvasPages";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { CanvasPageMenu } from "./CanvasPageMenu";
import { CanvasPagesSection } from "./CanvasPagesSection";
import { useCanvasActivityStore } from "./canvasStores";
import { canvasWorkQueryKey, canvasWorkQueryOptions } from "./canvasWorkCache";
import {
  at,
  frameOf,
  mountCanvas,
  nextFrame,
  resetCanvasStores,
  select,
  serveCanvas,
  workOf,
} from "./editor/canvasEditorTestHarness";

const page = (id: string, extra: Partial<CanvasPage> = {}): CanvasPage => ({
  id,
  title: id.toUpperCase(),
  viewport: { x: 0, y: 0, zoom: 1 },
  frames: [],
  comments: [],
  ...extra,
});
const dividers: CanvasPageDivider[] = [
  { id: "d1", beforePageId: "p2" },
  { id: "d2", beforePageId: null },
];
const initialWork = (): CanvasWork => ({
  ...workOf([]),
  pages: [page("p1", { icon: "swatch" }), page("p2"), page("p3")],
  dividers,
});

/** The store's page list operations, in memory (the real ones are covered on the server). */
function servePages(initial: CanvasWork) {
  let saved = initial;
  let second = 2;
  native.canvas.changePages.mockImplementation(async (input: CanvasPageChangeInput) => {
    const operation = input.operation;
    let list: CanvasPageListItem<CanvasPage>[] = canvasPageList(saved);
    if (operation.type === "move")
      list = moveCanvasPageListItem(list, operation.id, operation.beforeId);
    else if (operation.type === "add_divider")
      list = moveCanvasPageListItem(
        [...list, { kind: "divider", id: operation.id }],
        operation.id,
        operation.beforeId,
      );
    else if (operation.type === "delete_divider" || operation.type === "delete")
      list = list.filter((item) => item.id !== operation.id);
    else if (operation.type === "create")
      list = [...list, { kind: "page", id: operation.id, page: page(operation.id) }];
    else
      list = list.map((item) => {
        if (item.kind !== "page" || item.id !== operation.id) return item;
        if (operation.type === "rename")
          return { ...item, page: { ...item.page, title: operation.title } };
        if (operation.type === "set_color") {
          const { color: _color, ...rest } = item.page;
          return { ...item, page: operation.color ? { ...rest, color: operation.color } : rest };
        }
        if (operation.type !== "set_icon") return item;
        const { icon: _icon, ...rest } = item.page;
        return { ...item, page: operation.icon ? { ...rest, icon: operation.icon } : rest };
      });
    saved = { ...saved, updatedAt: at(second++), ...canvasPageListParts(list) };
    return saved;
  });
  return {
    get work() {
      return saved;
    },
  };
}

const rows = () =>
  [...document.querySelectorAll<HTMLElement>("section [data-page-row]")].map(
    (row) => row.dataset.pageRow,
  );
const row = (id: string) => document.querySelector<HTMLElement>(`section [data-page-row="${id}"]`)!;
const operations = () =>
  native.canvas.changePages.mock.calls.map(([input]) => (input as CanvasPageChangeInput).operation);
const menuIds = (call = -1) =>
  (native.contextMenu.show.mock.calls.at(call)![0] as ContextMenuItem[]).map((item) => item.id);

function Pages({ onSelect }: { onSelect: (id: string) => void }) {
  const { data } = useQuery({ ...canvasWorkQueryOptions("work1"), enabled: false });
  const [pageId, setPageId] = useState("p1");
  if (!data) return null;
  const choose = (id: string) => {
    setPageId(id);
    onSelect(id);
  };
  return (
    <div className="w-[300px]">
      <CanvasPageMenu work={data} pageId={pageId} onSelect={choose} />
      <CanvasPagesSection work={data} pageId={pageId} onSelect={choose} />
    </div>
  );
}

async function mountPages(work = initialWork()) {
  const server = servePages(work);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(canvasWorkQueryKey("work1"), work);
  const onSelect = vi.fn();
  const screen = await render(
    <QueryClientProvider client={client}>
      <Pages onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { server, screen, onSelect };
}

function drag(source: HTMLElement, target: HTMLElement, edge: "top" | "bottom") {
  const data = new DataTransfer();
  source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
  const box = target.getBoundingClientRect();
  const point = { clientX: box.left + 20, clientY: edge === "top" ? box.top + 2 : box.bottom - 2 };
  return {
    // The list renders the drag before it takes drag-overs, as between real events.
    over: async () => {
      await nextFrame();
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          ...point,
        }),
      );
    },
    drop: () => {
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data, ...point }),
      );
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: data }));
    },
  };
}

const rightClick = (target: HTMLElement) => {
  const box = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: box.left + 10,
      clientY: box.top + 4,
    }),
  );
};

describe("canvas page list", () => {
  beforeEach(() => {
    resetCanvasStores();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    native.contextMenu.show.mockReset();
    native.dialogs.confirm.mockReset();
  });
  afterEach(() => {
    useCanvasActivityStore.setState({ frames: {}, layers: {} } as never);
  });

  it("lists pages and dividers in one order, with icons, the open page checked and agent rain", async () => {
    const { screen } = await mountPages();
    try {
      expect(rows()).toEqual(["p1", "d1", "p2", "p3", "d2"]);
      expect(row("d1").getAttribute("aria-disabled")).toBe("true");
      expect(row("p1").querySelector('[data-canvas-page-icon="swatch"]')).toBeTruthy();
      expect(row("p1").querySelector("[data-canvas-page-current]")).toBeTruthy();
      expect(row("p2").querySelector("[data-canvas-page-current]")).toBeNull();
      // A page an agent works on shows the activity indicator in place of its icon.
      useCanvasActivityStore.getState().record({
        type: "activity",
        workId: "work1",
        pageId: "p1",
        frameIds: ["f1"],
        threadId: "chat1" as never,
        expiresAt: new Date(Date.now() + 40_000).toISOString(),
      });
      await vi.waitFor(() =>
        expect(row("p1").querySelector("[data-canvas-page-activity]")).toBeTruthy(),
      );
      expect(row("p1").querySelector("[data-canvas-page-icon]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("sizes the pages list with the splitter under it, remembered; a double-click fits the pages", async () => {
    // Twelve pages overflow the default height.
    const many = {
      ...initialWork(),
      pages: Array.from({ length: 12 }, (_, index) => page(`p${index + 1}`)),
      dividers: [],
    };
    const { screen } = await mountPages(many);
    try {
      const list = document.querySelector<HTMLElement>("[data-canvas-pages-list]")!;
      const splitter = document.querySelector<HTMLElement>("[data-canvas-pages-splitter]")!;
      expect(list.getBoundingClientRect().height).toBe(224);
      const box = splitter.getBoundingClientRect();
      const x = box.left + 40;
      const y = box.top + box.height / 2;
      splitter.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }),
      );
      const overlay = document.body.lastElementChild!;
      for (const step of [-30, -60, -100])
        overlay.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            buttons: 1,
            clientX: x,
            clientY: y + step,
          }),
        );
      overlay.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y - 100 }),
      );
      await vi.waitFor(() => expect(list.getBoundingClientRect().height).toBe(124));
      expect(localStorage.getItem("synara:canvas-pages-height")).toBe("124");

      // The keyboard steps it; a double-click shows every page and no more.
      splitter.focus();
      splitter.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
      await vi.waitFor(() => expect(list.getBoundingClientRect().height).toBe(140));
      splitter.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await vi.waitFor(() => expect(list.getBoundingClientRect().height).toBe(list.scrollHeight));
      expect(list.scrollHeight).toBeGreaterThan(224);
      expect(list.scrollTop).toBe(0);
    } finally {
      await screen.unmount();
    }
    // A new editor opens the list at the remembered height.
    const again = await mountPages(many);
    try {
      const list = document.querySelector<HTMLElement>("[data-canvas-pages-list]")!;
      expect(list.getBoundingClientRect().height).toBe(list.scrollHeight);
    } finally {
      await again.screen.unmount();
    }
  });

  it("reorders pages and dividers by dragging, showing where they land", async () => {
    const { screen, server } = await mountPages();
    try {
      const first = drag(row("p3"), row("d1"), "top");
      await first.over();
      await vi.waitFor(() => expect(row("d1").querySelector("[data-tree-row-drop]")).toBeTruthy());
      first.drop();
      await vi.waitFor(() => expect(rows()).toEqual(["p1", "p3", "d1", "p2", "d2"]));
      expect(operations()).toEqual([{ type: "move", id: "p3", beforeId: "d1" }]);
      // A divider dropped on a page's lower half lands right below it.
      const second = drag(row("d2"), row("p1"), "bottom");
      await second.over();
      await vi.waitFor(() => expect(row("p1").querySelector("[data-tree-row-drop]")).toBeTruthy());
      second.drop();
      await vi.waitFor(() => expect(rows()).toEqual(["p1", "d2", "p3", "d1", "p2"]));
      expect(operations().at(-1)).toEqual({ type: "move", id: "d2", beforeId: "p3" });
      expect(server.work.pages.map((item) => item.id)).toEqual(["p1", "p3", "p2"]);
      // Dropping a row where it already is saves nothing.
      const still = drag(row("p3"), row("p3"), "top");
      await still.over();
      await vi.waitFor(() => expect(row("p3").querySelector("[data-tree-row-drop]")).toBeTruthy());
      still.drop();
      expect(native.canvas.changePages).toHaveBeenCalledTimes(2);
    } finally {
      await screen.unmount();
    }
  });

  it("moves the focused page or divider with Alt+arrow keys and keeps it focused", async () => {
    const { screen } = await mountPages();
    try {
      row("p2").focus();
      row("p2").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }),
      );
      await vi.waitFor(() => expect(rows()).toEqual(["p1", "p2", "d1", "p3", "d2"]));
      await vi.waitFor(() => expect(document.activeElement).toBe(row("p2")));
      row("d1").focus();
      row("d1").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
      );
      await vi.waitFor(() => expect(rows()).toEqual(["p1", "p2", "p3", "d1", "d2"]));
      expect(operations()).toEqual([
        { type: "move", id: "p2", beforeId: "d1" },
        { type: "move", id: "d1", beforeId: "d2" },
      ]);
      // Plain arrows still walk the rows, dividers included.
      row("p3").focus();
      row("p3").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(document.activeElement).toBe(row("d1"));
    } finally {
      await screen.unmount();
    }
  });

  it("offers Rename, Add divider, the icon submenu and Delete on a page, and acts on them", async () => {
    const { screen, onSelect } = await mountPages();
    try {
      native.contextMenu.show.mockResolvedValueOnce("icon:slides");
      rightClick(row("p2"));
      await vi.waitFor(() =>
        expect(row("p2").querySelector('[data-canvas-page-icon="slides"]')).toBeTruthy(),
      );
      expect(menuIds()).toEqual(["rename", "add-divider", "icon:none", "delete"]);
      const iconRow = (native.contextMenu.show.mock.calls[0]![0] as ContextMenuItem[])[2]!;
      // One row with a submenu: every icon, each drawn with its Central icon.
      expect(iconRow.children?.map((item) => item.id)).toContain("icon:pie-chart");
      expect(iconRow.children?.every((item) => typeof item.icon === "string")).toBe(true);

      // With an icon set, the submenu starts with the default.
      native.contextMenu.show.mockResolvedValueOnce("icon:none");
      rightClick(row("p2"));
      await vi.waitFor(() => expect(row("p2").querySelector("[data-canvas-page-icon]")).toBeNull());
      const reset = (native.contextMenu.show.mock.calls[1]![0] as ContextMenuItem[])[2]!;
      expect(reset.children?.[0]?.id).toBe("icon:none");

      native.contextMenu.show.mockResolvedValueOnce("add-divider");
      rightClick(row("p3"));
      // Below the page: between it and the divider that followed it.
      await vi.waitFor(() => expect(rows()).toHaveLength(6));
      expect([rows()[3], rows()[5]]).toEqual(["p3", "d2"]);
      expect(row(rows()[4]!).hasAttribute("data-page-divider")).toBe(true);
      expect(operations().at(-1)).toMatchObject({ type: "add_divider", beforeId: "d2" });

      native.contextMenu.show.mockResolvedValueOnce("rename");
      rightClick(row("p3"));
      const input = await vi.waitFor(() => {
        const found = row("p3").querySelector("input");
        expect(found).toBeTruthy();
        return found!;
      });
      input.value = "Review";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() => expect(row("p3").textContent).toContain("Review"));

      // Deleting the open page opens the one after it, not the first one.
      native.dialogs.confirm.mockResolvedValueOnce(true);
      native.contextMenu.show.mockResolvedValueOnce("delete");
      rightClick(row("p1"));
      await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("p2"));
      expect(rows()).not.toContain("p1");
    } finally {
      await screen.unmount();
    }
  });

  it("offers Duplicate and Remove on a divider", async () => {
    const { screen } = await mountPages();
    try {
      native.contextMenu.show.mockResolvedValueOnce("duplicate-divider");
      rightClick(row("d1"));
      await vi.waitFor(() => expect(rows()).toHaveLength(6));
      expect(menuIds()).toEqual(["duplicate-divider", "delete-divider"]);
      expect(operations().at(-1)).toMatchObject({ type: "add_divider", beforeId: "p2" });
      native.contextMenu.show.mockResolvedValueOnce("delete-divider");
      rightClick(row("d1"));
      await vi.waitFor(() => expect(rows()).toHaveLength(5));
      expect(rows()).not.toContain("d1");
    } finally {
      await screen.unmount();
    }
  });

  it("shows dividers and icons in the header page switcher, with the same menu", async () => {
    const { screen } = await mountPages();
    try {
      const trigger = screen.getByRole("button", { name: /P1/ });
      await trigger.click();
      const popup = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>('[role="menu"]');
        expect(found).toBeTruthy();
        return found!;
      });
      expect(popup.querySelectorAll("[data-page-divider]")).toHaveLength(2);
      expect(popup.querySelector('[data-canvas-page-icon="swatch"]')).toBeTruthy();
      native.contextMenu.show.mockResolvedValueOnce(null);
      const second = [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.includes("P2"),
      )!;
      rightClick(second);
      await vi.waitFor(() => expect(native.contextMenu.show).toHaveBeenCalled());
      expect(menuIds()).toEqual(["rename", "add-divider", "icon:none", "delete"]);
      native.contextMenu.show.mockResolvedValueOnce("delete-divider");
      rightClick(popup.querySelector<HTMLElement>("[data-page-divider]")!);
      await vi.waitFor(() => expect(popup.querySelectorAll("[data-page-divider]")).toHaveLength(1));
    } finally {
      await screen.unmount();
    }
  });

  it("makes a frame the work's cover from its menu, and takes it back", async () => {
    const f1 = frameOf("f1", [], []);
    const work = workOf([f1]);
    const server = serveCanvas(native, work);
    let saved = server.work;
    native.canvas.update.mockImplementation(async (input: CanvasResourceUpdateInput) => {
      const { cover: _cover, ...rest } = saved;
      saved = { ...rest, updatedAt: at(50), ...(input.cover ? { cover: input.cover } : {}) };
      return saved;
    });
    const { screen, cached } = await mountCanvas(work, { layers: true });
    try {
      select([{ kind: "frame", frameId: "f1" }]);
      const frameRow = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-layer-row="frame:f1"]');
        expect(found).toBeTruthy();
        return found!;
      });
      native.contextMenu.show.mockResolvedValueOnce("cover");
      rightClick(frameRow);
      await vi.waitFor(() =>
        expect(native.canvas.update).toHaveBeenCalledWith({
          id: "work1",
          cover: { pageId: "page1", frameId: "f1" },
        }),
      );
      await vi.waitFor(() => expect(cached().cover).toEqual({ pageId: "page1", frameId: "f1" }));
      const firstMenu = native.contextMenu.show.mock.calls[0]![0] as ContextMenuItem[];
      expect(firstMenu.find((item) => item.id === "cover")?.label).toBe("Use as cover");
      native.contextMenu.show.mockResolvedValueOnce("cover");
      rightClick(frameRow);
      await vi.waitFor(() =>
        expect(native.canvas.update).toHaveBeenLastCalledWith({ id: "work1", cover: null }),
      );
      const secondMenu = native.contextMenu.show.mock.calls[1]![0] as ContextMenuItem[];
      expect(secondMenu.find((item) => item.id === "cover")?.label).toBe("Remove cover");
    } finally {
      await screen.unmount();
    }
  });
});
