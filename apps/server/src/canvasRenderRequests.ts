import { randomUUID } from "node:crypto";
import type {
  CanvasMeasuredLayer,
  CanvasStreamEvent,
  CanvasSubmitRenderInput,
} from "@synara/contracts";
import { pngDimensions } from "./pngHeader";

const RENDER_TIMEOUT_MS = 20_000;
/** Measuring only lays the frame out; a tree read waits this long before showing `?`. */
export const CANVAS_MEASURE_TIMEOUT_MS = 5_000;
type RenderEvent = Extract<CanvasStreamEvent, { type: "render" }>;
type RenderResult = { png: string; width: number; height: number };
type Answer = CanvasSubmitRenderInput["result"];
type Pending = {
  /** Settles the request with a window's answer. */
  answer: (result: Answer) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, Pending>();
/** Editor clients currently subscribed to canvas events; only they can rasterize a frame. */
let renderClients = 0;

export function registerCanvasRenderClient(): () => void {
  renderClients++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    renderClients--;
  };
}

/** Whether a window could answer a render request right now. */
export const hasCanvasRenderClient = () => renderClients > 0;

/** One request on the render channel; the first answer wins. */
function requestFromWindow<A>(
  publish: (event: RenderEvent) => void,
  input: Omit<RenderEvent, "type" | "requestId">,
  options: {
    signal: AbortSignal | undefined;
    timeoutMs: number;
    label: string;
    accept: (answer: Answer) => A;
  },
): Promise<A> {
  const { signal, label } = options;
  if (renderClients <= 0)
    return Promise.reject(
      new Error(`${label}s need an open Synara window. Ask the user to open Synara, then retry.`),
    );
  if (signal?.aborted) return Promise.reject(new Error(`${label} cancelled.`));
  const requestId = `render_${randomUUID()}`;
  return new Promise<A>((resolve, reject) => {
    const settle = () => {
      const entry = pending.get(requestId);
      if (entry) clearTimeout(entry.timer);
      pending.delete(requestId);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      settle();
      reject(new Error(`${label} cancelled.`));
    };
    pending.set(requestId, {
      answer: (result) => {
        settle();
        try {
          resolve(options.accept(result));
        } catch (error) {
          reject(error as Error);
        }
      },
      timer: setTimeout(() => {
        settle();
        reject(new Error(`No Synara window answered the ${label.toLowerCase()} request in time.`));
      }, options.timeoutMs),
    });
    signal?.addEventListener("abort", abort, { once: true });
    publish({ type: "render", requestId, ...input });
  });
}

/**
 * The server has no layout engine, so an open Synara window renders the frame through the same
 * sanitized renderer the canvas uses and posts back a PNG. The first answer wins. With
 * `layerId` the image is the frame cropped to that layer's box.
 */
export function requestCanvasRender(
  publish: (event: RenderEvent) => void,
  input: {
    workId: string;
    pageId: string;
    frameId: string | null;
    maxSide: number;
    layerId?: string;
    scale?: 1 | 2;
  },
  signal?: AbortSignal,
): Promise<RenderResult> {
  return requestFromWindow(publish, input, {
    signal,
    timeoutMs: RENDER_TIMEOUT_MS,
    label: "Screenshot",
    accept: (result) => {
      if ("error" in result) throw new Error(`Screenshot failed: ${result.error}`);
      if (!("png" in result)) throw new Error("Screenshot failed: the window returned no image.");
      const dimensions = pngDimensions(Buffer.from(result.png, "base64"));
      if (!dimensions) throw new Error("Screenshot failed: the renderer returned an invalid PNG.");
      return { png: result.png, ...dimensions };
    },
  });
}

/**
 * Layer boxes (and optionally computed styles) of one frame, laid out by an open window.
 * Layers the window could not find (text layers, hidden or missing ones) are left out.
 */
export function requestCanvasMeasure(
  publish: (event: RenderEvent) => void,
  input: {
    workId: string;
    pageId: string;
    frameId: string;
    layerIds: readonly string[];
    styles?: boolean;
  },
  signal?: AbortSignal,
  timeoutMs = CANVAS_MEASURE_TIMEOUT_MS,
): Promise<Map<string, CanvasMeasuredLayer>> {
  const wanted = new Set(input.layerIds);
  return requestFromWindow(
    publish,
    {
      workId: input.workId,
      pageId: input.pageId,
      frameId: input.frameId,
      maxSide: 64,
      measure: { layerIds: [...wanted], ...(input.styles ? { styles: true } : {}) },
    },
    {
      signal,
      timeoutMs,
      label: "Measurement",
      accept: (result) => {
        if ("error" in result) throw new Error(`Measuring failed: ${result.error}`);
        // An older window answers every render request with an image.
        if (!("layers" in result))
          throw new Error("Measuring failed: this Synara window cannot measure layers.");
        return new Map(
          result.layers.filter((layer) => wanted.has(layer.id)).map((layer) => [layer.id, layer]),
        );
      },
    },
  );
}

export function submitCanvasRender(input: CanvasSubmitRenderInput): boolean {
  const entry = pending.get(input.requestId);
  if (!entry) return false;
  entry.answer(input.result);
  return true;
}
