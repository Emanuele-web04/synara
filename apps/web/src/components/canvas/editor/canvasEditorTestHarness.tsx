// FILE: canvasEditorTestHarness.tsx
// Purpose: Shared stand-ins for the canvas editor's browser tests: a small in-memory server that
//          answers the editor's RPCs the way the real store does, a mounted editor, and real
//          pointer and key events. Test-only; nothing in the app imports it.
// Layer: Canvas editor tests

import type {
  CanvasCommentThread,
  CanvasEditLayersInput,
  CanvasExportEntry,
  CanvasPage,
  CanvasPageLayoutInput,
  CanvasRestoreFramesInput,
  CanvasWork,
  DesignFrame,
  DesignLayer,
  DesignLayerAppliedEdit,
  DesignLayerTree,
} from "@synara/contracts";
import { applyDesignLayerEdits } from "@synara/shared/designCanvasLayers";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Profiler, useState, type ReactNode } from "react";
import { vi } from "vitest";
import { render } from "vitest-browser-react";
import { SidebarProvider } from "../../ui/sidebar";
import { useCanvasEditorStore, type CanvasSelectionItem } from "../canvasStores";
import { canvasWorkQueryKey, canvasWorkQueryOptions } from "../canvasWorkCache";
import { CanvasEditorProvider, useCanvasEditor, type CanvasEditorApi } from "./CanvasEditorContext";
import { CanvasInspector } from "../inspector/CanvasInspector";
import { CanvasLayersPanel } from "./CanvasLayersPanel";
import { CanvasViewport } from "./CanvasViewport";

type Mock = ReturnType<typeof vi.fn>;
export type CanvasNativeMock = {
  canvas: Record<string, Mock>;
  contextMenu: { show: Mock };
  dialogs: { confirm: Mock };
};

export const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 0, 0, second)).toISOString();

export const element = (
  id: string,
  style: string,
  children: string[] = [],
  tag = "div",
  attributes: Record<string, string> = {},
): DesignLayer => ({
  id,
  type: "element",
  tag,
  attributes: { style, ...attributes },
  children,
});
export const text = (id: string, value: string): DesignLayer => ({ id, type: "text", text: value });

export const frameOf = (
  id: string,
  nodes: DesignLayer[],
  roots: string[],
  overrides: Partial<DesignFrame> = {},
): DesignFrame => ({
  id,
  title: id,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  revision: 1,
  style: "background:#ffffff",
  layers: { roots, nodes },
  ...overrides,
});

export const workOf = (frames: DesignFrame[], page: Partial<CanvasPage> = {}): CanvasWork => ({
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
      // The frame's origin sits at the viewport's top-left corner, at 100%.
      viewport: { x: 0, y: 0, zoom: 1 },
      frames,
      comments: [],
      ...page,
    },
  ],
});

const mergeStyle = (style: string, patch: Readonly<Record<string, string | null>>) => {
  const declarations = new Map(
    style
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const colon = item.indexOf(":");
        return [item.slice(0, colon).trim(), item.slice(colon + 1).trim()] as const;
      }),
  );
  for (const [key, value] of Object.entries(patch))
    if (value === null) declarations.delete(key);
    else declarations.set(key, value);
  return [...declarations].map(([key, value]) => `${key}:${value}`).join(";");
};

/** HTML to layers with fresh IDs, as the server's importer would make them. */
function importHtml(html: string, nextId: () => string): DesignLayerTree {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const nodes: DesignLayer[] = [];
  const visit = (node: Node): string | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent) return null;
      const id = nextId();
      nodes.push({ id, type: "text", text: node.textContent });
      return id;
    }
    if (!(node instanceof Element)) return null;
    const id = nextId();
    const children: string[] = [];
    nodes.push({
      id,
      type: "element",
      tag: node.localName,
      attributes: Object.fromEntries([...node.attributes].map((item) => [item.name, item.value])),
      children,
    });
    for (const child of node.childNodes) {
      const childId = visit(child);
      if (childId) children.push(childId);
    }
    return id;
  };
  const roots = [...parsed.body.childNodes].flatMap((node) => {
    const id = visit(node);
    return id ? [id] : [];
  });
  return { roots, nodes };
}

/**
 * The canvas store's behaviour for the editor's RPCs, in memory: layer edits (set_styles merged
 * into the style attribute, insert_html imported with new IDs), layout patches, frame restores
 * and the comment and export-row cleanup that frame removal does.
 */
export function serveCanvas(native: CanvasNativeMock, initial: CanvasWork) {
  let saved = initial;
  let second = 2;
  let id = 0;
  const nextId = () => `n${++id}`;
  const failures: Partial<Record<"editLayers" | "layout" | "restoreFrames", number[]>> = {};
  const calls = { editLayers: 0, layout: 0, restoreFrames: 0 };
  const fail = (method: keyof typeof calls) => {
    calls[method]++;
    if (failures[method]?.includes(calls[method])) throw new Error(`${method} refused`);
  };
  const commit = (pageId: string, change: (page: CanvasPage) => CanvasPage) => {
    saved = {
      ...saved,
      updatedAt: at(second++),
      pages: saved.pages.map((page) => (page.id === pageId ? change(page) : page)),
    };
    return saved;
  };
  native.canvas.editLayers!.mockImplementation(async (input: CanvasEditLayersInput) => {
    fail("editLayers");
    const page = saved.pages.find((item) => item.id === input.pageId)!;
    const frame = page.frames.find((item) => item.id === input.edit.frameId)!;
    let tree = frame.layers;
    let style = frame.style ?? "";
    const createdNodeIds: string[] = [];
    for (const operation of input.edit.operations) {
      let applied: DesignLayerAppliedEdit;
      if (operation.type === "set_styles") {
        const node = tree.nodes.find((item) => item.id === operation.nodeId);
        if (node?.type !== "element") throw new Error("Layer not found.");
        applied = {
          type: "set_attributes",
          nodeId: node.id,
          attributes: { style: mergeStyle(node.attributes.style ?? "", operation.styles) },
        };
      } else if (operation.type === "set_frame_styles") {
        style = mergeStyle(style, operation.styles);
        continue;
      } else if (operation.type === "insert_html") {
        const layers = importHtml(operation.html, nextId);
        createdNodeIds.push(...layers.nodes.map((node) => node.id));
        applied = {
          type: "insert_layers",
          parentId: operation.parentId,
          ...(operation.beforeId ? { beforeId: operation.beforeId } : {}),
          layers,
        };
      } else if (operation.type === "insert_layers") {
        // Like the store, inserted layers count as created (undo removes them by these IDs).
        createdNodeIds.push(...operation.layers.nodes.map((node) => node.id));
        applied = operation;
      } else if (operation.type === "duplicate" || operation.type === "replace_html")
        // Agent-only operations; the editor never sends them.
        throw new Error(`${operation.type} is not served by the editor harness.`);
      else applied = operation;
      tree = applyDesignLayerEdits(tree, [applied]);
    }
    const next = commit(input.pageId, (current) => ({
      ...current,
      frames: current.frames.map((item) =>
        item.id === frame.id ? { ...item, layers: tree, style, revision: item.revision + 1 } : item,
      ),
    }));
    return { work: next, createdNodeIds, dropped: [] };
  });
  native.canvas.layout!.mockImplementation(async (input: CanvasPageLayoutInput) => {
    fail("layout");
    return commit(input.pageId, (page) => {
      const patches = new Map((input.frames ?? []).map((patch) => [patch.id, patch]));
      const removed = new Set(
        [...patches.values()].filter((patch) => patch.remove).map((patch) => patch.id),
      );
      const frames: DesignFrame[] = [];
      const order = input.order ?? [];
      const ordered = [
        ...order.flatMap((id) => page.frames.filter((frame) => frame.id === id)),
        ...page.frames.filter((frame) => !order.includes(frame.id)),
      ];
      for (const frame of ordered) {
        if (removed.has(frame.id)) continue;
        const patch = patches.get(frame.id);
        frames.push(
          patch
            ? Object.assign({}, frame, {
                x: patch.x ?? frame.x,
                y: patch.y ?? frame.y,
                width: patch.width ?? frame.width,
                height: patch.height ?? frame.height,
                title: patch.title ?? frame.title,
                ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
                ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
              })
            : frame,
        );
      }
      const exportSettings: Record<string, readonly CanvasExportEntry[]> = {
        ...page.exportSettings,
      };
      for (const patch of input.exportSettings ?? [])
        if (patch.entries?.length) exportSettings[patch.key] = patch.entries;
        else delete exportSettings[patch.key];
      for (const key of Object.keys(exportSettings)) {
        const [, frameId, layerId] = key.split(":");
        const frame = frames.find((item) => item.id === frameId);
        if (!frame || (layerId && !frame.layers.nodes.some((node) => node.id === layerId)))
          delete exportSettings[key];
      }
      return {
        ...page,
        frames,
        exportSettings,
        comments: page.comments.filter((thread) => !removed.has(thread.frameId)),
      };
    });
  });
  native.canvas.restoreFrames!.mockImplementation(async (input: CanvasRestoreFramesInput) => {
    fail("restoreFrames");
    return commit(input.pageId, (page) => {
      const removed = new Set(input.removeFrameIds);
      let frames = page.frames.filter((frame) => !removed.has(frame.id));
      for (const restored of input.frames)
        frames = frames.some((frame) => frame.id === restored.id)
          ? frames.map((frame) => (frame.id === restored.id ? restored : frame))
          : [...frames, restored];
      const kept = new Set(frames.map((frame) => frame.id));
      const comments: CanvasCommentThread[] = page.comments.filter(
        (thread) => !removed.has(thread.frameId),
      );
      const restoredComments = (input as { comments?: readonly CanvasCommentThread[] }).comments;
      for (const thread of restoredComments ?? [])
        if (kept.has(thread.frameId) && !comments.some((item) => item.id === thread.id))
          comments.push(thread);
      return { ...page, frames, comments };
    });
  });
  native.canvas.get!.mockImplementation(async () => saved);
  return {
    get work() {
      return saved;
    },
    frame: (frameId: string, pageId = "page1") =>
      saved.pages.find((page) => page.id === pageId)!.frames.find((item) => item.id === frameId)!,
    /** Makes the n-th call (1-based, counted from now on) of a method fail. */
    failCall(method: keyof typeof calls, ...nth: number[]) {
      failures[method] = nth.map((value) => calls[method] + value);
    },
  };
}

/** The editor API of the mounted canvas, for direct calls (undo, run, batch). */
export const mounted: { editor: CanvasEditorApi | null; commits: number } = {
  editor: null,
  commits: 0,
};

function Probe() {
  mounted.editor = useCanvasEditor();
  return null;
}

function Window({
  readOnly,
  layers,
  inspector,
  toolbar,
  pages,
  children,
}: {
  readOnly: boolean;
  layers: boolean;
  inspector: boolean;
  toolbar: boolean;
  pages: boolean;
  children?: ReactNode;
}) {
  const { data } = useQuery({ ...canvasWorkQueryOptions("work1"), enabled: false });
  const [pageId, setPageId] = useState("page1");
  if (!data) return null;
  return (
    <CanvasEditorProvider
      work={data}
      pageId={pageId}
      readOnly={readOnly}
      onSelectPage={pages ? setPageId : null}
    >
      <Probe />
      <div className="flex">
        {layers && <CanvasLayersPanel className="h-[400px] w-[220px] shrink-0" />}
        <div data-testid="viewport-box" className="relative h-[400px] w-[600px] shrink-0">
          <Profiler
            id="canvas-viewport"
            onRender={() => {
              mounted.commits++;
            }}
          >
            <CanvasViewport toolbar={toolbar} />
          </Profiler>
        </div>
        {inspector && <CanvasInspector className="h-[400px] w-[260px] shrink-0" />}
      </div>
      {children}
    </CanvasEditorProvider>
  );
}

const host = (frameId: string) =>
  document.querySelector<HTMLElement>(`[data-canvas-frame-id="${frameId}"]`)!;

/**
 * Mounts one editor on `work` (page1) with its viewport at 600×400 and the camera at 0,0 100%;
 * `toolbar` adds the floating toolbar (with the zoom menu in it), `pages` lets the editor switch
 * pages (PageUp / PageDown, a comment or undo on another page).
 */
export async function mountCanvas(
  work: CanvasWork,
  {
    readOnly = false,
    layers = false,
    inspector = false,
    toolbar = false,
    pages = false,
  }: {
    readOnly?: boolean;
    layers?: boolean;
    inspector?: boolean;
    toolbar?: boolean;
    pages?: boolean;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(canvasWorkQueryKey("work1"), work);
  const screen = await render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <Window
          readOnly={readOnly}
          layers={layers}
          inspector={inspector}
          toolbar={toolbar}
          pages={pages}
        />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  const root = document.querySelector<HTMLElement>("[data-canvas-viewport]")!;
  const layer = (layerId: string, frameId = "f1") =>
    host(frameId).shadowRoot?.querySelector<HTMLElement>(`[data-synara-layer-id="${layerId}"]`) ??
    null;
  return {
    client,
    screen,
    root,
    host,
    layer,
    cached: () => client.getQueryData<CanvasWork>(canvasWorkQueryKey("work1"))!,
  };
}

export const select = (items: CanvasSelectionItem[]) =>
  useCanvasEditorStore.getState().setSelection("work1", "page1", items);
export const selection = () =>
  useCanvasEditorStore
    .getState()
    .selection.work1?.items.map((item) =>
      item.kind === "frame" ? `frame:${item.frameId}` : item.layerId,
    ) ?? [];

/** A real pointer event; `buttons` is 1 while the primary button is down. */
export function pointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  x: number,
  y: number,
  init: PointerEventInit = {},
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
      ...init,
    }),
  );
}

/** A screen point at a viewport-local position (the camera sits at 0,0 100%). */
export function viewportPoint(root: HTMLElement, x: number, y: number) {
  const box = root.getBoundingClientRect();
  return { x: box.left + x, y: box.top + y };
}

export const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

export function resetCanvasStores() {
  localStorage.clear();
  useCanvasEditorStore.setState({
    tool: "move",
    panelHover: null,
    uiHidden: false,
    commentsHidden: false,
    panelRequest: null,
    revealRequest: null,
  });
  select([]);
  mounted.editor = null;
  mounted.commits = 0;
}
