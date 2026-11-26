import {
  CANVAS_MEASURE_MAX_STYLED_LAYERS,
  type CanvasExportFormat,
  type CanvasMeasuredLayer,
  type CanvasPage,
  type CanvasStreamEvent,
  type CanvasSubmitRenderInput,
  type CanvasWork,
  type DesignFrame,
} from "@synara/contracts";

import {
  PDF_QUALITY_SETTINGS,
  exportOutputSize,
  exportScaleFactor,
  type CanvasExportQuality,
} from "./canvasExportSettings";
import {
  attachDesignFrameRenderer,
  blobToBase64,
  buildDesignFrameExport,
  exportRenderContext,
  registerDesignFont,
  registeredFontFamily,
  type LoadedCanvasAsset,
} from "./designCanvas";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PAGE_PADDING = 32;
const MAX_PAGE_SIDE = 8192;
const MAX_PAGE_PIXELS = 16_000_000;
const MAX_PDF_PIXELS = 64_000_000;
const MAX_PDF_SIDE_POINTS = 14_400;

interface PageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function pageBounds(page: CanvasPage): PageBounds {
  const objects = page.frames;
  if (objects.length === 0) return { x: 0, y: 0, width: 800, height: 600 };
  const x = Math.min(...objects.map((object) => object.x)) - PAGE_PADDING;
  const y = Math.min(...objects.map((object) => object.y)) - PAGE_PADDING;
  const right = Math.max(...objects.map((object) => object.x + object.width)) + PAGE_PADDING;
  const bottom = Math.max(...objects.map((object) => object.y + object.height)) + PAGE_PADDING;
  return { x, y, width: right - x, height: bottom - y };
}

function createSvg(width: number, height: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  return svg;
}

function addForeignObject(svg: SVGSVGElement, bounds: PageBounds, content: HTMLElement): void {
  const foreignObject = document.createElementNS(SVG_NAMESPACE, "foreignObject");
  foreignObject.setAttribute("x", String(bounds.x));
  foreignObject.setAttribute("y", String(bounds.y));
  foreignObject.setAttribute("width", String(bounds.width));
  foreignObject.setAttribute("height", String(bounds.height));
  foreignObject.append(content);
  svg.append(foreignObject);
}

/** SVG image contexts keep design markup isolated, including CSS resource references. */
async function decodeSvg(svg: SVGSVGElement): Promise<HTMLImageElement> {
  const source = new XMLSerializer().serializeToString(svg);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  try {
    await image.decode();
    return image;
  } catch (cause) {
    image.removeAttribute("src");
    throw new Error("Canvas export could not render an image.", { cause });
  }
}

async function renderFrameImage(
  frame: CanvasPage["frames"][number],
  assets: readonly LoadedCanvasAsset[],
): Promise<HTMLImageElement> {
  // Each frame gets its own SVG viewport, so viewport units and fonts stay scoped to it.
  const svg = createSvg(frame.width, frame.height);
  addForeignObject(
    svg,
    { x: 0, y: 0, width: frame.width, height: frame.height },
    buildDesignFrameExport(frame, assets),
  );
  return decodeSvg(svg);
}

async function encodePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas export could not encode the PNG image."));
    }, "image/png");
  });
}

/**
 * One frame at up to `maxSide` pixels on its longer side and at most `maxScale` pixels per
 * design pixel, e.g. for an agent screenshot.
 */
export async function exportCanvasFramePng(
  frame: CanvasPage["frames"][number],
  assets: readonly LoadedCanvasAsset[],
  maxSide: number,
  maxScale = 2,
): Promise<Blob> {
  const scale = Math.min(maxScale, maxSide / Math.max(frame.width, frame.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(frame.width * scale));
  canvas.height = Math.max(1, Math.round(frame.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas export is unavailable in this browser.");
  const image = await renderFrameImage(frame, assets);
  try {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await encodePng(canvas);
  } finally {
    image.removeAttribute("src");
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function pagePng(
  page: CanvasPage,
  assets: readonly LoadedCanvasAsset[],
  maxPixels: number,
): Promise<Blob> {
  const bounds = pageBounds(page);
  const scale = Math.min(
    1,
    MAX_PAGE_SIDE / bounds.width,
    MAX_PAGE_SIDE / bounds.height,
    Math.sqrt(maxPixels / (bounds.width * bounds.height)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(bounds.width * scale));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas export is unavailable in this browser.");
  try {
    context.fillStyle = "#f5f5f4";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
    for (const frame of page.frames) {
      const image = await renderFrameImage(frame, assets);
      try {
        context.fillStyle = "#ffffff";
        context.fillRect(frame.x, frame.y, frame.width, frame.height);
        context.drawImage(image, frame.x, frame.y, frame.width, frame.height);
      } finally {
        image.removeAttribute("src");
      }
    }
    return await encodePng(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function exportCanvasPagePng(
  page: CanvasPage,
  assets: readonly LoadedCanvasAsset[] = [],
  maxPixels = MAX_PAGE_PIXELS,
): Promise<Blob> {
  return pagePng(page, assets, maxPixels);
}

/** PDF pages contain the same raster composition as PNG, in saved page order. */
export async function exportCanvasWorkPdf(
  work: CanvasWork,
  assets: readonly LoadedCanvasAsset[],
): Promise<Blob> {
  const pages = work.pages;
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(work.title);
  const maxPixels = Math.min(MAX_PAGE_PIXELS, Math.floor(MAX_PDF_PIXELS / pages.length));
  for (const page of pages) {
    const png = await pagePng(page, assets, maxPixels);
    const image = await pdf.embedPng(await png.arrayBuffer());
    const bounds = pageBounds(page);
    const pointsPerPixel = Math.min(
      0.75,
      MAX_PDF_SIDE_POINTS / bounds.width,
      MAX_PDF_SIDE_POINTS / bounds.height,
    );
    const width = bounds.width * pointsPerPixel;
    const height = bounds.height * pointsPerPixel;
    const output = pdf.addPage([width, height]);
    output.drawImage(image, { x: 0, y: 0, width, height });
  }
  const bytes = await pdf.save();
  return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}

/** A frame, or one of its layers at its rectangle in frame pixels. */
export type CanvasExportTarget = {
  frame: Pick<DesignFrame, "layers" | "style" | "width" | "height">;
  layerId: string | null;
  rect: { x: number; y: number; width: number; height: number };
};
export type CanvasImageFormat = Exclude<CanvasExportFormat, "pdf">;

const IMAGE_TYPES: Record<CanvasImageFormat, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
};
/** JPG, WebP and AVIF are encoded at quality 0.9. */
const IMAGE_QUALITY = 0.9;

function createCanvas(width: number, height: number, colorSpace: PredefinedColorSpace) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { colorSpace });
  if (!context) throw new Error("Canvas export is unavailable in this browser.");
  return { canvas, context };
}

/** The SVG view box crops to the target, so the browser rasterizes it at the output size. */
async function drawTarget(
  context: CanvasRenderingContext2D,
  target: CanvasExportTarget,
  assets: readonly LoadedCanvasAsset[],
  box: { x: number; y: number; width: number; height: number },
) {
  const { rect, frame } = target;
  const svg = createSvg(Math.max(1, Math.round(box.width)), Math.max(1, Math.round(box.height)));
  svg.setAttribute("viewBox", `${rect.x} ${rect.y} ${rect.width} ${rect.height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  addForeignObject(
    svg,
    { x: 0, y: 0, width: frame.width, height: frame.height },
    buildDesignFrameExport(frame, assets, target.layerId ?? undefined),
  );
  const image = await decodeSvg(svg);
  try {
    context.drawImage(image, box.x, box.y, box.width, box.height);
  } finally {
    image.removeAttribute("src");
  }
}

/**
 * Exports render on a Display P3 canvas, so the files carry a P3 profile. Nothing is
 * painted behind the node; only JPG, which has no alpha, gets a white background.
 */
async function renderTarget(
  target: CanvasExportTarget,
  assets: readonly LoadedCanvasAsset[],
  scale: string,
  background: string | null,
  colorSpace: PredefinedColorSpace = "display-p3",
): Promise<HTMLCanvasElement> {
  const { width, height } = exportOutputSize(target.rect, scale);
  const { canvas, context } = createCanvas(width, height, colorSpace);
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  await drawTarget(context, target, assets, { x: 0, y: 0, width, height });
  return canvas;
}

async function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  try {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    // Browsers fall back to PNG for types they cannot encode; never save that under another name.
    if (!blob || blob.type !== type)
      throw new Error(`This browser cannot encode ${type.replace("image/", "").toUpperCase()}.`);
    return blob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

let avifSupport: Promise<boolean> | null = null;

/** Chromium has no AVIF encoder; the format menu offers AVIF only where one exists. */
export function canEncodeAvif(): Promise<boolean> {
  avifSupport ??= new Promise<boolean>((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      canvas.toBlob((blob) => resolve(blob?.type === "image/avif"), "image/avif");
    } catch {
      resolve(false);
    }
  });
  return avifSupport;
}

/** One image of a frame or layer, as one export row produces. */
export async function exportCanvasTarget(
  target: CanvasExportTarget,
  assets: readonly LoadedCanvasAsset[],
  scale: string,
  format: CanvasImageFormat,
): Promise<Blob> {
  const canvas = await renderTarget(target, assets, scale, format === "jpg" ? "#ffffff" : null);
  return encode(canvas, IMAGE_TYPES[format], format === "png" ? undefined : IMAGE_QUALITY);
}

/**
 * Copy as PNG: one image at `factor`, or several nodes composited onto one sRGB
 * canvas the size of their combined bounds, with transparent gaps.
 */
export async function exportCanvasComposite(
  targets: readonly { target: CanvasExportTarget; origin: { x: number; y: number } }[],
  assets: readonly LoadedCanvasAsset[],
  factor: number,
): Promise<Blob> {
  const left = Math.min(...targets.map((item) => item.origin.x));
  const top = Math.min(...targets.map((item) => item.origin.y));
  const right = Math.max(...targets.map((item) => item.origin.x + item.target.rect.width));
  const bottom = Math.max(...targets.map((item) => item.origin.y + item.target.rect.height));
  const scale = Math.min(
    factor,
    exportScaleFactor({ width: right - left, height: bottom - top }, `${factor}x`),
  );
  const { canvas, context } = createCanvas(
    Math.max(1, Math.round((right - left) * scale)),
    Math.max(1, Math.round((bottom - top) * scale)),
    "srgb",
  );
  for (const { target, origin } of targets)
    await drawTarget(context, target, assets, {
      x: (origin.x - left) * scale,
      y: (origin.y - top) * scale,
      width: target.rect.width * scale,
      height: target.rect.height * scale,
    });
  return encode(canvas, "image/png");
}

/**
 * One PDF page per target, each the size of its node (96 px per inch). Pages are raster
 * images: High is lossless at 2x, Medium and Low are JPEG at 1.5x and 1x, so the
 * quality levels recompress images.
 */
export async function exportCanvasTargetsPdf(
  targets: readonly CanvasExportTarget[],
  assets: readonly LoadedCanvasAsset[],
  quality: CanvasExportQuality,
  title: string,
): Promise<Blob> {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  const settings = PDF_QUALITY_SETTINGS[quality];
  for (const target of targets) {
    // PDF images are sRGB; a P3 page would shift colours in viewers that ignore the profile.
    const canvas = await renderTarget(
      target,
      assets,
      `${settings.scale}x`,
      settings.jpegQuality === null ? null : "#ffffff",
      "srgb",
    );
    const bytes = await (
      settings.jpegQuality === null
        ? encode(canvas, "image/png")
        : encode(canvas, "image/jpeg", settings.jpegQuality)
    ).then((blob) => blob.arrayBuffer());
    const image =
      settings.jpegQuality === null ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const width = target.rect.width * 0.75;
    const height = target.rect.height * 0.75;
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  const bytes = await pdf.save();
  return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}

/** A region of a frame (a layer's box) with the frame painted around it, on white. */
export async function exportCanvasRegionPng(
  frame: CanvasExportTarget["frame"],
  assets: readonly LoadedCanvasAsset[],
  rect: CanvasExportTarget["rect"],
  factor: number,
): Promise<Blob> {
  const width = Math.max(1, Math.round(rect.width * factor));
  const height = Math.max(1, Math.round(rect.height * factor));
  const { canvas, context } = createCanvas(width, height, "srgb");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  await drawTarget(context, { frame, layerId: null, rect }, assets, { x: 0, y: 0, width, height });
  return encode(canvas, "image/png");
}

/** Computed properties a styles read reports: layout, spacing, type, color, border, effects. */
const MEASURED_STYLES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "box-sizing",
  "margin",
  "padding",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "align-self",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "gap",
  "grid-template-columns",
  "grid-template-rows",
  "overflow",
  "color",
  "background-color",
  "background-image",
  "opacity",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "box-shadow",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration-line",
  "white-space",
  "transform",
  "filter",
] as const;

const round = (value: number) => Math.round(value * 100) / 100;

const REGISTERED_FAMILY = new RegExp(`"${registeredFontFamily("")}([^"]*)"`, "g");

/** What an inline SVG's shapes are painted with, read on top of the box properties. */
const SVG_MEASURED_STYLES = ["fill", "stroke", "stroke-width"] as const;

/** Computed values as a design would write them: its own font names, no image bytes. */
function readComputedStyles(element: Element): Record<string, string> {
  const computed = getComputedStyle(element);
  const styles: Record<string, string> = {};
  const properties =
    element instanceof SVGElement ? [...MEASURED_STYLES, ...SVG_MEASURED_STYLES] : MEASURED_STYLES;
  for (const property of properties) {
    const value = computed
      .getPropertyValue(property)
      .replace(REGISTERED_FAMILY, '"$1"')
      .replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, "url(…)")
      .trim();
    if (value) styles[property] = value.slice(0, 2000);
  }
  return styles;
}

/**
 * Lays a frame out off screen through the canvas renderer, with the work's fonts and
 * images, and measures its element layers in frame pixels: every element layer, or the
 * listed ones. Hidden layers (no box) are left out.
 */
export async function measureCanvasFrameLayers(
  frame: CanvasExportTarget["frame"],
  assets: readonly LoadedCanvasAsset[],
  layerIds: readonly string[] | null,
  options: { styles?: boolean } = {},
): Promise<CanvasMeasuredLayer[]> {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  // Inline styles win over the frame sheet's :host rule; the box keeps the frame's size.
  host.style.cssText = `position:fixed;left:-${frame.width + 10_000}px;top:0;width:${frame.width}px;height:${frame.height}px;visibility:hidden;pointer-events:none;`;
  const renderer = attachDesignFrameRenderer(host.attachShadow({ mode: "open" }));
  // Fonts register in the document (as an open canvas does); images inline as data URLs.
  for (const asset of assets) registerDesignFont(asset);
  document.body.append(host);
  try {
    renderer.update(frame, exportRenderContext(assets).context);
    await document.fonts.ready;
    await Promise.all(
      [...renderer.root.querySelectorAll("img")].map((image) => image.decode().catch(() => {})),
    );
    const origin = renderer.root.getBoundingClientRect();
    const ids =
      layerIds ?? frame.layers.nodes.flatMap((node) => (node.type === "element" ? [node.id] : []));
    const styled = options.styles ? new Set(ids.slice(0, CANVAS_MEASURE_MAX_STYLED_LAYERS)) : null;
    return ids.flatMap((id): CanvasMeasuredLayer[] => {
      const element = renderer.element(id);
      if (!element || element.getClientRects().length === 0) return [];
      const box = element.getBoundingClientRect();
      return [
        {
          id,
          x: round(box.left - origin.left),
          y: round(box.top - origin.top),
          width: round(box.width),
          height: round(box.height),
          ...(styled?.has(id) ? { styles: readComputedStyles(element) } : {}),
        },
      ];
    });
  } finally {
    host.remove();
  }
}

type RenderRequest = Extract<CanvasStreamEvent, { type: "render" }>;

/**
 * What a window answers to an agent's render request: layer boxes for `measure`, the frame
 * cropped to one layer's box for `layerId`, else the frame or the whole page. `scale` sets
 * pixels per design pixel (frames default to up to 2); `maxSide` always caps the image.
 */
export async function answerCanvasRenderRequest(
  event: RenderRequest,
  page: CanvasPage,
  assets: readonly LoadedCanvasAsset[],
): Promise<CanvasSubmitRenderInput["result"]> {
  const frame = event.frameId ? page.frames.find((item) => item.id === event.frameId) : null;
  if (event.frameId && !frame) throw new Error("frame not found");
  if (event.measure) {
    if (!frame) throw new Error("measuring needs a frame");
    return {
      layers: await measureCanvasFrameLayers(frame, assets, event.measure.layerIds, {
        styles: event.measure.styles ?? false,
      }),
    };
  }
  let blob: Blob;
  if (frame && event.layerId) {
    const [box] = await measureCanvasFrameLayers(frame, assets, [event.layerId]);
    if (!box || box.width < 1 || box.height < 1) throw new Error("the layer is hidden or empty");
    const factor = Math.min(event.scale ?? 2, event.maxSide / Math.max(box.width, box.height));
    blob = await exportCanvasRegionPng(frame, assets, box, factor);
  } else if (frame) blob = await exportCanvasFramePng(frame, assets, event.maxSide, event.scale);
  else blob = await exportCanvasPagePng(page, assets, event.maxSide * event.maxSide);
  const png = await blobToBase64(blob);
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return { png, ...size };
}
