import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  canvas: {
    list: vi.fn(),
    update: vi.fn(),
    duplicate: vi.fn(),
    create: vi.fn(),
    createFolder: vi.fn(),
  },
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("./useCanvasLibrary", () => ({
  useCanvasLibrary: () => ({ supported: true, negotiating: false, disconnected: false }),
}));
// The route chrome (window controls, sidebar toggles, computer picker) is not under test.
vi.mock("../RouteSurface", () => ({
  RouteSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  RouteSurfaceHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("../RouteInsetSurface", () => ({
  RouteInsetSurface: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("../hosts/ComputerPicker", () => ({ WorkspaceSurfaceComputerPicker: () => null }));

import type {
  CanvasFolder,
  CanvasListInput,
  CanvasResourceUpdateInput,
  CanvasWorkSummary,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { toastManager } from "../ui/toast";
import CanvasLibraryView from "./CanvasLibraryView";
import { useCanvasActivityStore } from "./canvasStores";

const time = (day: number) => new Date(Date.UTC(2026, 10, day)).toISOString();
const work = (
  id: string,
  folderId: string | null,
  updated: number,
  archivedAt: string | null = null,
): CanvasWorkSummary => ({
  kind: "work",
  id,
  title: id.toUpperCase(),
  folderId,
  projectId: null,
  createdAt: time(1),
  updatedAt: time(updated),
  archivedAt,
  pageCount: 1,
  frameCount: 0,
  preview: null,
});
const folder = (
  id: string,
  folderId: string | null,
  archivedAt: string | null = null,
): CanvasFolder => ({
  version: 2,
  kind: "folder",
  id,
  title: `Folder ${id}`,
  folderId,
  createdAt: time(1),
  updatedAt: time(1),
  archivedAt,
});

let works: CanvasWorkSummary[] = [];
let folders: CanvasFolder[] = [];
/** The store's listing rules: archive state, folder, title search, newest change first. */
function serveList() {
  native.canvas.list.mockImplementation(async (input: CanvasListInput) => {
    const archived = input.archived ?? false;
    const matches = works
      .filter(
        (item) =>
          (item.archivedAt !== null) === archived &&
          (input.folderId === undefined || item.folderId === input.folderId) &&
          (!input.search || item.title.toLowerCase().includes(input.search.toLowerCase())),
      )
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      works: matches,
      folders: folders.filter((item) => (item.archivedAt !== null) === archived),
      unavailableIds: [],
      total: matches.length,
    };
  });
  native.canvas.update.mockImplementation(async (input: CanvasResourceUpdateInput) => {
    works = works.map((item) =>
      item.id === input.id
        ? {
            ...item,
            ...(input.title ? { title: input.title } : {}),
            ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
            ...(input.archived !== undefined
              ? { archivedAt: input.archived ? time(20) : null }
              : {}),
          }
        : item,
    );
    return works.find((item) => item.id === input.id);
  });
}

async function mountLibrary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CanvasLibraryView />
    </QueryClientProvider>,
  );
}

const shownWorks = () =>
  [...document.querySelectorAll<HTMLElement>("[data-canvas-work]")].map(
    (item) => item.dataset.canvasWork,
  );
const shownFolders = () =>
  [...document.querySelectorAll<HTMLElement>("[data-canvas-folder]")].map(
    (item) => item.dataset.canvasFolder,
  );
const lastInput = () => native.canvas.list.mock.calls.at(-1)![0] as CanvasListInput;
const workMarker = (id: string) =>
  document.querySelector(`[data-canvas-work="${id}"] [data-canvas-page-activity="work"]`);
/** What CanvasEventBridge records from the stream with no editor open (or a turn's end). */
const agentOn = (workId: string, ended: boolean) =>
  useCanvasActivityStore.getState().record({
    type: "activity",
    workId,
    pageId: "any-page",
    frameIds: ended ? [] : ["f1"],
    threadId: "chat1" as never,
    expiresAt: new Date(Date.now() + (ended ? 0 : 40_000)).toISOString(),
    ...(ended ? { ended: true } : {}),
  });
/** How far in from a menu row's start its icon sits. */
const inset = (row: Element) =>
  (row.querySelector("svg")?.getBoundingClientRect().left ?? 0) - row.getBoundingClientRect().left;

describe("canvas library", () => {
  beforeEach(() => {
    localStorage.clear();
    navigate.mockReset();
    for (const mock of Object.values(native.canvas)) mock.mockReset();
    works = [
      work("loose", null, 5),
      work("filed", "outer", 9),
      work("deep", "inner", 3),
      work("old", null, 2, time(4)),
    ];
    folders = [folder("outer", null), folder("inner", "outer")];
    serveList();
  });
  afterEach(() => {
    document.body.innerHTML = "";
    useCanvasActivityStore.setState({ frames: {}, layers: {} });
  });

  it("shows Recent across folders, Files one folder at a time and Archive apart", async () => {
    const screen = await mountLibrary();
    try {
      // Recent: every work, the latest change first, no folders.
      await vi.waitFor(() => expect(shownWorks()).toEqual(["filed", "loose", "deep"]));
      expect(shownFolders()).toEqual([]);
      expect(lastInput()).not.toHaveProperty("folderId");

      await page.getByRole("radio", { name: "Files" }).click();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["loose"]));
      expect(lastInput()).toMatchObject({ folderId: null, archived: false });
      expect(shownFolders()).toEqual(["outer"]);

      await page.getByRole("button", { name: "Folder outer", exact: true }).click();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["filed"]));
      expect(shownFolders()).toEqual(["inner"]);
      await page.getByRole("button", { name: "Folder inner", exact: true }).click();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["deep"]));
      // The trail leads back up: Files / Folder outer / Folder inner.
      const trail = page.getByRole("navigation");
      await expect
        .element(trail.getByRole("button", { name: "Folder inner", exact: true }))
        .toHaveAttribute("aria-current", "page");
      await trail.getByRole("button", { name: "Folder outer", exact: true }).click();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["filed"]));

      await page.getByRole("radio", { name: "Archive" }).click();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["old"]));
      expect(lastInput()).toMatchObject({ archived: true });
      expect(lastInput()).not.toHaveProperty("folderId");
    } finally {
      await screen.unmount();
    }
  });

  it("searches every folder and says when nothing matches", async () => {
    const screen = await mountLibrary();
    try {
      await page.getByRole("radio", { name: "Files" }).click();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["loose"]));
      await userEvent.fill(page.getByRole("textbox", { name: "Search works" }), "dee");
      await vi.waitFor(() => expect(shownWorks()).toEqual(["deep"]));
      expect(lastInput()).toMatchObject({ search: "dee" });
      expect(lastInput()).not.toHaveProperty("folderId");
      await userEvent.fill(page.getByRole("textbox", { name: "Search works" }), "zzz");
      await expect.element(page.getByText("Nothing matches “zzz”")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("switches between grid and list and remembers the choice", async () => {
    const first = await mountLibrary();
    await vi.waitFor(() => expect(shownWorks()).toHaveLength(3));
    expect(document.querySelector("article[data-canvas-work]")).toBeTruthy();
    // The layout is the app's neutral segmented control (a radio group).
    await page.getByRole("radio", { name: "List" }).click();
    await vi.waitFor(() => expect(document.querySelector("li[data-canvas-work]")).toBeTruthy());
    await expect
      .element(page.getByRole("radio", { name: "List" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("radio", { name: "Grid" }))
      .toHaveAttribute("aria-checked", "false");
    await first.unmount();
    const second = await mountLibrary();
    try {
      await vi.waitFor(() => expect(document.querySelector("li[data-canvas-work]")).toBeTruthy());
      expect(document.querySelector("article[data-canvas-work]")).toBeNull();
    } finally {
      await second.unmount();
    }
  });

  it("moves a work with Move to and renames it in the shared rename dialog", async () => {
    const screen = await mountLibrary();
    try {
      await vi.waitFor(() => expect(shownWorks()).toHaveLength(3));
      await page.getByRole("button", { name: "Actions for LOOSE" }).click();
      await page.getByRole("menuitem", { name: "Move to" }).click();
      // A work cannot move to where it already is.
      await expect
        .element(page.getByRole("menuitem", { name: "Files" }))
        .toHaveAttribute("aria-disabled", "true");
      // Folders read as their tree: the subfolder follows its parent, one level in.
      const outerRow = page.getByRole("menuitem", { name: "Folder outer" }).element();
      const innerRow = page.getByRole("menuitem", { name: "Folder inner" }).element();
      expect(outerRow.compareDocumentPosition(innerRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(inset(innerRow) - inset(outerRow)).toBeGreaterThanOrEqual(12);
      await page.getByRole("menuitem", { name: "Folder inner" }).click();
      await vi.waitFor(() =>
        expect(native.canvas.update).toHaveBeenCalledWith({ id: "loose", folderId: "inner" }),
      );

      await page.getByRole("button", { name: "Actions for LOOSE" }).click();
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const field = page.getByRole("textbox", { name: "Rename canvas" });
      await userEvent.fill(field, "Landing");
      await page.getByRole("button", { name: "Save" }).click();
      await vi.waitFor(() =>
        expect(native.canvas.update).toHaveBeenLastCalledWith({ id: "loose", title: "Landing" }),
      );
      await vi.waitFor(() =>
        expect(document.querySelector('[data-canvas-work="loose"]')?.textContent).toContain(
          "Landing",
        ),
      );

      // A folder cannot move into itself or anything inside it.
      await page.getByRole("radio", { name: "Files" }).click();
      await page.getByRole("button", { name: "Actions for Folder outer" }).click();
      await page.getByRole("menuitem", { name: "Move to" }).click();
      await expect.element(page.getByRole("menuitem", { name: "Files" })).toBeVisible();
      expect(
        [...document.querySelectorAll('[role="menuitem"]')].some((item) =>
          item.textContent?.includes("Folder inner"),
        ),
      ).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("marks a work an agent is working on, in the grid and in the list", async () => {
    const screen = await mountLibrary();
    const marker = workMarker;
    const agent = (ended = false) => agentOn("loose", ended);
    try {
      await vi.waitFor(() => expect(shownWorks()).toHaveLength(3));
      expect(document.querySelector("[data-canvas-page-activity]")).toBeNull();
      agent();
      await vi.waitFor(() => expect(marker("loose")).toBeTruthy());
      expect(marker("loose")!.getAttribute("aria-label")).toBe(
        "An agent is working on this canvas",
      );
      // After the title, on the card's title row.
      expect(marker("loose")!.previousElementSibling?.textContent).toBe("LOOSE");
      expect(marker("filed")).toBeNull();
      expect(marker("deep")).toBeNull();

      await page.getByRole("radio", { name: "List" }).click();
      await vi.waitFor(() => expect(document.querySelector("li[data-canvas-work]")).toBeTruthy());
      await vi.waitFor(() => expect(marker("loose")).toBeTruthy());
      expect(marker("filed")).toBeNull();

      // The turn ends: it fades and goes.
      agent(true);
      await vi.waitFor(() => expect(marker("loose")).toBeNull());
    } finally {
      await screen.unmount();
    }
  });

  it("shows placeholders on the first load and keeps the works shown while a search loads", async () => {
    // The first list waits until released: placeholder cards meanwhile, no empty state.
    const serve = native.canvas.list.getMockImplementation()!;
    let release!: () => void;
    native.canvas.list.mockImplementationOnce(
      (input: CanvasListInput) => new Promise((resolve) => (release = () => resolve(serve(input)))),
    );
    const screen = await mountLibrary();
    try {
      await vi.waitFor(() =>
        expect(document.querySelector("[data-canvas-library-loading]")).toBeTruthy(),
      );
      expect(
        document.querySelectorAll("[data-canvas-library-loading] [data-slot=skeleton]").length,
      ).toBeGreaterThan(0);
      expect(shownWorks()).toEqual([]);
      expect(document.querySelector('[role="status"] h2')).toBeNull();
      release();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["filed", "loose", "deep"]));
      expect(document.querySelector("[data-canvas-library-loading]")).toBeNull();
      // A search that takes a while: the works stay until its list arrives.
      native.canvas.list.mockImplementationOnce(
        (input: CanvasListInput) =>
          new Promise((resolve) => (release = () => resolve(serve(input)))),
      );
      await userEvent.fill(page.getByRole("textbox", { name: "Search works" }), "dee");
      await vi.waitFor(() => expect(lastInput()).toMatchObject({ search: "dee" }));
      expect(shownWorks()).toEqual(["filed", "loose", "deep"]);
      expect(document.querySelector("[data-canvas-library-loading]")).toBeNull();
      release();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["deep"]));
    } finally {
      await screen.unmount();
    }
  });

  it("archives a work with the app's Undo toast, and Undo restores it", async () => {
    const add = vi.spyOn(toastManager, "add");
    const screen = await mountLibrary();
    try {
      await vi.waitFor(() => expect(shownWorks()).toHaveLength(3));
      await page.getByRole("button", { name: "Actions for LOOSE" }).click();
      await page.getByRole("menuitem", { name: "Archive" }).click();
      await vi.waitFor(() =>
        expect(native.canvas.update).toHaveBeenCalledWith({ id: "loose", archived: true }),
      );
      await vi.waitFor(() => expect(shownWorks()).toEqual(["filed", "deep"]));
      const toast = add.mock.calls
        .map(
          ([options]) =>
            options as {
              data?: { archiveUndo?: { message?: string; onUndo: () => Promise<boolean> } };
            },
        )
        .find((options) => options.data?.archiveUndo)!;
      expect(toast.data!.archiveUndo!.message).toBe("Canvas archived");
      await expect(toast.data!.archiveUndo!.onUndo()).resolves.toBe(true);
      expect(native.canvas.update).toHaveBeenLastCalledWith({ id: "loose", archived: false });
      await vi.waitFor(() => expect(shownWorks()).toEqual(["filed", "loose", "deep"]));
      // Restoring from the archive is not undone: no toast for it.
      add.mockClear();
      await page.getByRole("radio", { name: "Archive" }).click();
      await vi.waitFor(() => expect(shownWorks()).toEqual(["old"]));
      await page.getByRole("button", { name: "Actions for OLD" }).click();
      await page.getByRole("menuitem", { name: "Restore" }).click();
      await vi.waitFor(() =>
        expect(native.canvas.update).toHaveBeenLastCalledWith({ id: "old", archived: false }),
      );
      expect(add.mock.calls.some(([options]) => "data" in (options as object))).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("opens a work from anywhere on its card, its menu staying a menu", async () => {
    const screen = await mountLibrary();
    try {
      await vi.waitFor(() => expect(shownWorks()).toHaveLength(3));
      // A click on the title, not only on the thumbnail, opens the work: the point is the
      // title's centre, and what takes it there is the card's button (hence `force`).
      const title = page.getByRole("heading", { name: "LOOSE" });
      const box = title.element().getBoundingClientRect();
      expect(
        document
          .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          ?.closest("button")
          ?.getAttribute("aria-label"),
      ).toBe("Open LOOSE");
      await title.click({ force: true });
      expect(navigate).toHaveBeenCalledWith({
        to: "/canvas/$workId",
        params: { workId: "loose" },
        search: { page: undefined, chat: undefined },
      });
      navigate.mockReset();
      await page.getByRole("button", { name: "Actions for LOOSE" }).click();
      await expect.element(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
