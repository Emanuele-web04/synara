import "../../../index.css";

import type {
  CanvasChangedEvent,
  CanvasEditLayersInput,
  CanvasWork,
  DesignFrame,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const native = vi.hoisted(() => ({
  canvas: { editLayers: vi.fn(), layout: vi.fn(), get: vi.fn(), getAsset: vi.fn() },
  dialogs: { confirm: vi.fn() },
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => native,
  readNativeApi: () => undefined,
}));

import { SidebarProvider } from "../../ui/sidebar";
import { useCanvasEditorStore } from "../canvasStores";
import {
  canvasWorkQueryKey,
  canvasWorkQueryOptions,
  handleCanvasChanged,
} from "../canvasWorkCache";
import { CanvasEditorProvider, useCanvasEditor, type CanvasEditorApi } from "./CanvasEditorContext";
import { CanvasViewport } from "./CanvasViewport";

const box = (id: string, left: number, top: number, color: string) => ({
  id,
  type: "element" as const,
  tag: "div",
  attributes: {
    style: `position:absolute;left:${left}px;top:${top}px;width:50px;height:50px;background:${color}`,
  },
  children: [],
});

const frame: DesignFrame = {
  id: "f1",
  title: "Screen",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  revision: 1,
  style: "background:#ffffff",
  layers: {
    roots: ["a", "b", "c", "d"],
    nodes: [
      box("a", 10, 10, "#0000ff"),
      box("b", 100, 10, "#00ff00"),
      {
        id: "c",
        type: "element",
        tag: "p",
        attributes: { style: "position:absolute;left:10px;top:120px;margin:0;font-size:16px" },
        children: ["ct"],
      },
      { id: "ct", type: "text", text: "Hello" },
      box("d", 200, 10, "#999999"),
    ],
  },
};

const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 0, 0, second)).toISOString();
const work: CanvasWork = {
  version: 3,
  kind: "work",
  id: "work1",
  title: "Work",
  folderId: null,
  projectId: null,
  createdAt: at(0),
  updatedAt: at(1),
  archivedAt: null,
  assets: [],
  chats: [],
  pages: [
    {
      id: "page1",
      title: "Page 1",
      // An explicit camera: the frame sits at the viewport's origin at 100%.
      viewport: { x: 0, y: 0, zoom: 1 },
      frames: [frame],
      comments: [],
    },
  ],
};

/** An agent's single-layer set_styles, as the server publishes it. */
const remoteRestyle: CanvasChangedEvent = {
  type: "changed",
  scope: "work",
  workId: "work1",
  pageId: "page1",
  frameId: "f1",
  revision: 2,
  mutationId: "m_agent",
  updatedAt: at(2),
  previousUpdatedAt: at(1),
  delta: {
    operations: [
      {
        type: "set_attributes",
        nodeId: "b",
        attributes: {
          style: "position:absolute;left:100px;top:10px;width:50px;height:50px;background:#ff0000",
        },
      },
    ],
    lastLayerEdit: { mutationId: "m_agent", fingerprint: "agent", createdNodeIds: [] },
  },
};

let editorApi: CanvasEditorApi | null = null;
function Probe() {
  editorApi = useCanvasEditor();
  return null;
}

function Harness() {
  const { data } = useQuery({ ...canvasWorkQueryOptions("work1"), enabled: false });
  if (!data) return null;
  return (
    <CanvasEditorProvider work={data} pageId="page1" readOnly={false}>
      <Probe />
      <div className="relative h-[400px] w-[600px]">
        <CanvasViewport />
      </div>
    </CanvasEditorProvider>
  );
}

let client: QueryClient;
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(canvasWorkQueryKey("work1"), work);
  const screen = await render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <Harness />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  const host = document.querySelector<HTMLElement>('[data-canvas-frame-id="f1"]')!;
  await vi.waitFor(() =>
    expect(host.shadowRoot?.querySelector('[data-synara-layer-id="d"]')).toBeTruthy(),
  );
  const shadow = host.shadowRoot!;
  const layer = (id: string) =>
    shadow.querySelector<HTMLElement>(`[data-synara-layer-id="${id}"]`)!;
  return { screen, shadow, layer };
}

const background = (element: HTMLElement) => getComputedStyle(element).backgroundColor;

function pointer(target: Element, type: string, x: number, y: number, buttons = 1) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
    }),
  );
}

describe("remote single-layer updates", () => {
  beforeEach(() => {
    localStorage.clear();
    useCanvasEditorStore.getState().setSelection("work1", "page1", []);
    native.canvas.editLayers.mockReset();
    native.canvas.layout.mockReset();
    native.canvas.get.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("patches only the changed layer and keeps a text edit on another layer open", async () => {
    const { screen, shadow, layer } = await mount();
    try {
      const before = { a: layer("a"), b: layer("b"), c: layer("c"), d: layer("d") };
      const text = before.c.firstChild;
      useCanvasEditorStore
        .getState()
        .setSelection("work1", "page1", [{ kind: "layer", frameId: "f1", layerId: "c" }]);
      document.querySelector<HTMLElement>("[data-canvas-viewport]")!.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() =>
        expect(before.c.getAttribute("contenteditable")).toBe("plaintext-only"),
      );
      await userEvent.keyboard("Typed by me");
      expect(before.c.textContent).toBe("Typed by me");

      handleCanvasChanged(client, remoteRestyle);

      await vi.waitFor(() => expect(background(before.b)).toBe("rgb(255, 0, 0)"));
      // Every element in the frame is the same DOM object; the restyled one was patched in place.
      expect(layer("a")).toBe(before.a);
      expect(layer("b")).toBe(before.b);
      expect(layer("c")).toBe(before.c);
      expect(layer("d")).toBe(before.d);
      expect(before.c.firstChild).toBe(text);
      // The text edit stays open, focused and with what was typed.
      expect(before.c.getAttribute("contenteditable")).toBe("plaintext-only");
      expect(shadow.activeElement).toBe(before.c);
      expect(before.c.textContent).toBe("Typed by me");
      expect(native.canvas.get).not.toHaveBeenCalled();
      expect(client.getQueryData<CanvasWork>(canvasWorkQueryKey("work1"))?.updatedAt).toBe(at(2));
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an in-flight layer drag's preview while a sibling changes", async () => {
    const { screen, layer } = await mount();
    try {
      const before = { a: layer("a"), b: layer("b"), d: layer("d") };
      const start = before.a.getBoundingClientRect();
      const x = start.left + 25;
      const y = start.top + 25;
      pointer(before.a, "pointerdown", x, y);
      pointer(before.a, "pointermove", x + 20, y + 10);
      pointer(before.a, "pointermove", x + 40, y + 30);
      await vi.waitFor(() => expect(before.a.style.left).toBe("50px"));
      expect(before.a.style.top).toBe("40px");

      handleCanvasChanged(client, remoteRestyle);

      await vi.waitFor(() => expect(background(before.b)).toBe("rgb(255, 0, 0)"));
      expect(layer("a")).toBe(before.a);
      expect(layer("b")).toBe(before.b);
      expect(layer("d")).toBe(before.d);
      expect(before.a.style.left).toBe("50px");
      expect(before.a.style.top).toBe("40px");

      native.canvas.editLayers.mockImplementation(async (input: CanvasEditLayersInput) => ({
        work: {
          ...client.getQueryData<CanvasWork>(canvasWorkQueryKey("work1"))!,
          updatedAt: at(3),
        },
        createdNodeIds: [],
        dropped: [],
        input,
      }));
      pointer(before.a, "pointerup", x + 40, y + 30, 0);
      await vi.waitFor(() => expect(native.canvas.editLayers).toHaveBeenCalledTimes(1));
      expect(native.canvas.editLayers.mock.calls[0]![0]).toMatchObject({
        workId: "work1",
        pageId: "page1",
        edit: {
          frameId: "f1",
          operations: [{ type: "set_styles", nodeId: "a", styles: { left: "50px", top: "40px" } }],
        },
      });
      // The drop's base is the document with the remote change, not the one before it (B7).
      expect(native.canvas.layout).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

/** A server stand-in for set_styles: merges declarations and moves the revision on. */
function serveStyleEdits(client: QueryClient) {
  let saved = client.getQueryData<CanvasWork>(canvasWorkQueryKey("work1"))!;
  let second = 2;
  native.canvas.editLayers.mockImplementation(async (input: CanvasEditLayersInput) => {
    const page = saved.pages[0]!;
    const current = page.frames[0]!;
    const nodes = current.layers.nodes.map((node) => {
      const operation = input.edit.operations.find(
        (item) => item.type === "set_styles" && item.nodeId === node.id,
      );
      if (node.type !== "element" || operation?.type !== "set_styles") return node;
      const declarations = new Map(
        (node.attributes.style ?? "")
          .split(";")
          .filter(Boolean)
          .map((item) => item.split(":") as [string, string]),
      );
      for (const [key, value] of Object.entries(operation.styles))
        if (value === null) declarations.delete(key);
        else declarations.set(key, value);
      const style = [...declarations].map(([key, value]) => `${key}:${value}`).join(";");
      return { ...node, attributes: { ...node.attributes, style } };
    });
    const nextFrame = {
      ...current,
      revision: current.revision + 1,
      layers: { ...current.layers, nodes },
    };
    saved = { ...saved, updatedAt: at(second++), pages: [{ ...page, frames: [nextFrame] }] };
    return { work: saved, createdNodeIds: [], dropped: [] };
  });
}

describe("back-to-back edits (B7)", () => {
  beforeEach(() => {
    localStorage.clear();
    native.canvas.editLayers.mockReset();
  });

  it("records the undo of a second edit against the document the first one saved", async () => {
    const { screen } = await mount();
    try {
      serveStyleEdits(client);
      const restyle = (background: string) =>
        editorApi!.run({
          kind: "edit",
          frameId: "f1",
          operations: [{ type: "set_styles", nodeId: "d", styles: { background } }],
        });
      // Queued in one tick: the second send runs before React re-renders the first result.
      await Promise.all([restyle("#ff0000"), restyle("#0000ff")]);
      await editorApi!.undo();
      const calls = native.canvas.editLayers.mock.calls.map(
        ([input]) => (input as CanvasEditLayersInput).edit.operations,
      );
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual([
        { type: "set_styles", nodeId: "d", styles: { background: "#ff0000" } },
      ]);
    } finally {
      await screen.unmount();
    }
  });
});
