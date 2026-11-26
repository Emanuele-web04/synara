import {
  DESIGN_CANVAS_MAX_DEPTH,
  DESIGN_CANVAS_MAX_ZOOM,
  DESIGN_CANVAS_MIN_ZOOM,
  type CanvasAsset,
  type DesignFrame,
  type DesignLayer,
  type DesignLayerTree,
  type DesignViewport,
} from "@synara/contracts";
import {
  DESIGN_HTML_TAGS,
  DESIGN_LAYER_ATTRIBUTE,
  DESIGN_VOID_TAGS,
  isDesignAttributeAllowed,
} from "@synara/shared/designCanvasLayers";
import { designTextBlockKind } from "@synara/shared/designCanvasText";
import {
  DESIGN_SVG_ID_PREFIX,
  DESIGN_SVG_NAMESPACE,
  DESIGN_SVG_TAGS,
  DESIGN_SVG_TEXT_TAGS,
  designSvgScopedId,
  scopeDesignSvgAttribute,
} from "@synara/shared/designCanvasSvg";

type Rect = { x: number; y: number; width: number; height: number };

export const clampZoom = (zoom: number) =>
  Math.min(DESIGN_CANVAS_MAX_ZOOM, Math.max(DESIGN_CANVAS_MIN_ZOOM, zoom));

/** Cursor-anchored zoom: the world point under (x, y) stays under the cursor. */
export function zoomDesignCanvas(
  view: DesignViewport,
  x: number,
  y: number,
  factor: number,
): DesignViewport {
  const zoom = clampZoom(view.zoom * factor);
  return {
    x: x - ((x - view.x) * zoom) / view.zoom,
    y: y - ((y - view.y) * zoom) / view.zoom,
    zoom,
  };
}

export function fitDesignCanvas(
  rects: readonly Rect[],
  width: number,
  height: number,
  { padding = 80, maxZoom = 1 } = {},
): DesignViewport {
  if (rects.length === 0) return { x: width / 2, y: height / 2, zoom: 1 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const zoom = clampZoom(
    Math.min(
      maxZoom,
      (width - padding * 2) / Math.max(1, right - left),
      (height - padding * 2) / Math.max(1, bottom - top),
    ),
  );
  return {
    x: (width - (right - left) * zoom) / 2 - left * zoom,
    y: (height - (bottom - top) * zoom) / 2 - top * zoom,
    zoom,
  };
}

export const screenToWorld = (view: DesignViewport, x: number, y: number) => ({
  x: (x - view.x) / view.zoom,
  y: (y - view.y) / view.zoom,
});

export type DesignRenderContext = {
  /** A displayable URL for a work-owned image, or null when the asset is missing. */
  assetUrl: (id: string) => string | null;
  /** Lower-cased family names designs use, mapped to the family registered for this canvas. */
  fonts: ReadonlyMap<string, string>;
};

// Frames render inside Synara's own document, so anything that would reach outside the frame
// (network, host variables, viewport units, pointer capture) is rewritten or dropped.
const BLOCKED_PROPERTIES = new Set([
  "pointer-events",
  "cursor",
  "user-select",
  "-webkit-user-select",
  "touch-action",
  "container",
  "container-type",
  "container-name",
  "behavior",
  "-moz-binding",
  "view-transition-name",
  "anchor-name",
  "position-anchor",
  // An Electron window-drag region would take pointer input from the editor.
  "app-region",
  "-webkit-app-region",
]);
const BLOCKED_FUNCTION = /(?:image-set|attr|element|paint|cross-fade|expression|src)\s*\(/i;
const URL_PATTERN = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/;
const ASSET_URL = /^synara-asset:([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})$/;
const CUSTOM_PREFIX = "--sc-";

let probe: HTMLElement | null = null;

function rewriteValue(value: string, context: DesignRenderContext): string | null {
  if (BLOCKED_FUNCTION.test(value)) return null;
  let blocked = false;
  const withUrls = value.replace(URL_PATTERN, (_, _quote: string, raw: string) => {
    const target = raw.trim();
    const asset = ASSET_URL.exec(target);
    if (asset) {
      const url = context.assetUrl(asset[1]!);
      if (url) return `url("${url}")`;
    } else if (DATA_IMAGE.test(target)) return `url("${target}")`;
    blocked = true;
    return "none";
  });
  if (blocked) return null;
  return (
    withUrls
      // Viewport units mean the frame, which is the size container of its content.
      .replace(/(-?\d*\.?\d+)(?:d|s|l)?vh\b/g, "$1cqh")
      .replace(/(-?\d*\.?\d+)(?:d|s|l)?vw\b/g, "$1cqw")
      .replace(/(-?\d*\.?\d+)vmin\b/g, "$1cqmin")
      .replace(/(-?\d*\.?\d+)vmax\b/g, "$1cqmax")
      // Design variables never see (or override) Synara's own custom properties.
      .replace(/var\(\s*--/g, `var(${CUSTOM_PREFIX}`)
  );
}

function rewriteFontFamily(value: string, context: DesignRenderContext): string {
  if (context.fonts.size === 0) return value;
  return value
    .split(",")
    .map((item) => {
      const name = item.trim().replace(/^["']|["']$/g, "");
      const registered = context.fonts.get(name.toLowerCase());
      return registered ? `"${registered}"` : item.trim();
    })
    .join(", ");
}

/** Browser-parsed declarations of one inline style, safe to apply in the host document. */
export function sanitizeDesignStyle(
  style: string,
  context: DesignRenderContext,
): Array<[property: string, value: string, priority: string]> {
  if (!style.trim()) return [];
  probe ??= document.createElement("div");
  probe.style.cssText = style;
  const result: Array<[string, string, string]> = [];
  for (let index = 0; index < probe.style.length; index++) {
    const property = probe.style.item(index);
    if (BLOCKED_PROPERTIES.has(property)) continue;
    const raw = probe.style.getPropertyValue(property);
    const value = rewriteValue(raw, context);
    if (value === null) continue;
    result.push([
      property.startsWith("--") ? `${CUSTOM_PREFIX}${property.slice(2)}` : property,
      property === "font-family" ? rewriteFontFamily(value, context) : value,
      probe.style.getPropertyPriority(property),
    ]);
  }
  probe.style.cssText = "";
  return result;
}

/** A rendered element layer: HTML, or an element of an inline SVG. */
export type DesignLayerElement = HTMLElement | SVGElement;

function applyStyle(element: DesignLayerElement, style: string, context: DesignRenderContext) {
  for (const [property, value, priority] of sanitizeDesignStyle(style, context))
    element.style.setProperty(property, value, priority);
}

type ElementLayer = Extract<DesignLayer, { type: "element" }>;

/**
 * Form controls a frame keeps disabled. Options are not: a disabled select already takes no
 * input, and a select whose options were all disabled would show no value.
 */
const DESIGN_CONTROL_TAGS = new Set(["input", "textarea", "select", "button"]);
/**
 * On a form control that is disabled only because frames are static (not by the design): the
 * frame stylesheet gives it the browser's enabled colours instead of the greyed disabled ones.
 */
export const DESIGN_INERT_CONTROL_ATTRIBUTE = "data-synara-inert";
/**
 * Inputs the browser paints itself (a check, a radio dot, a slider, a colour well): disabled,
 * they would keep the greyed look whatever the stylesheet says. They stay enabled and are made
 * inert by the frame instead (see `guardInertControls`).
 */
const NATIVE_PAINTED_INPUT_TYPES = new Set(["checkbox", "radio", "range", "color"]);
const isNativePaintedInput = (node: ElementLayer) =>
  node.tag === "input" &&
  NATIVE_PAINTED_INPUT_TYPES.has((node.attributes.type ?? "").trim().toLowerCase());

/** The frame's natively painted inputs, which `guardInertControls` keeps from taking input. */
const GUARDED_CONTROL_SELECTOR = `input[${DESIGN_INERT_CONTROL_ATTRIBUTE}]:not(:disabled)`;

/**
 * Keeps a frame's enabled-looking inputs inert: a press never focuses or drags them, a click
 * never checks them, and focus that reaches them anyway is dropped. Capture listeners on the
 * frame root run before the control's own default action; the canvas's gestures still see
 * the press (the event is not stopped).
 */
function guardInertControls(root: HTMLElement) {
  const guarded = (event: Event) =>
    event.target instanceof Element && event.target.closest(GUARDED_CONTROL_SELECTOR) !== null;
  const prevent = (event: Event) => {
    if (guarded(event)) event.preventDefault();
  };
  for (const type of ["pointerdown", "mousedown", "click", "keydown", "beforeinput"])
    root.addEventListener(type, prevent, true);
  root.addEventListener(
    "focusin",
    (event) => {
      if (guarded(event)) (event.target as HTMLElement).blur();
    },
    true,
  );
}

/**
 * Writes one element layer's allowlisted attributes and sanitized inline style, replacing
 * whatever the element had. Every rendered element goes through here, live or exported.
 * `svg` is the layer ID of the inline SVG the element belongs to (null for HTML): its IDs and
 * `url(#id)` references are rendered in that SVG's own scope, and only the SVG itself carries
 * a layer ID, so the editor hits, selects and outlines the SVG as one layer. A styled range of
 * a rich text block (`range`) carries none either: the block is the layer.
 */
function writeElementLayer(
  element: DesignLayerElement,
  node: ElementLayer,
  context: DesignRenderContext,
  layerIds: boolean,
  svg: string | null,
  range = false,
) {
  const attributes = new Map<string, string>();
  let style = "";
  const scoped = (id: string) => designSvgScopedId(svg!, id);
  for (const [name, value] of Object.entries(node.attributes)) {
    if (!isDesignAttributeAllowed(node.tag, name, value)) continue;
    if (name === "style") style = value;
    else if (svg !== null) attributes.set(name, scopeDesignSvgAttribute(scoped, name, value));
    // Scoped SVG IDs are the SVG's own; an HTML layer can never take (and shadow) one.
    else if (name === "id" && value.startsWith(DESIGN_SVG_ID_PREFIX)) continue;
    else if (name === "src") {
      const asset = ASSET_URL.exec(value);
      const url = asset ? context.assetUrl(asset[1]!) : DATA_IMAGE.test(value) ? value : null;
      if (url) attributes.set("src", url);
    } else attributes.set(name, value);
  }
  if (layerIds && !range && (svg === null || svg === node.id))
    attributes.set(DESIGN_LAYER_ATTRIBUTE, node.id);
  // Static frames: controls never take focus or input, links never navigate. A control the
  // design did not disable itself is marked, so the frame stylesheet draws it enabled.
  if (DESIGN_CONTROL_TAGS.has(node.tag)) {
    const designDisabled = attributes.has("disabled");
    if (!designDisabled) attributes.set(DESIGN_INERT_CONTROL_ATTRIBUTE, "");
    else attributes.delete(DESIGN_INERT_CONTROL_ATTRIBUTE);
    // A natively painted input the design left enabled stays enabled (the frame keeps it
    // inert); every other control is disabled.
    if (designDisabled || !isNativePaintedInput(node)) attributes.set("disabled", "");
    else attributes.set("tabindex", "-1");
  }
  if (["summary", "a", "label", "details"].includes(node.tag)) attributes.set("tabindex", "-1");
  if (node.tag === "img") {
    attributes.set("draggable", "false");
    attributes.set("decoding", "async");
  }
  for (const name of element.getAttributeNames())
    if (name !== "style" && !attributes.has(name)) element.removeAttribute(name);
  // Re-setting an unchanged src would make the browser fetch the image again.
  for (const [name, value] of attributes)
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  element.removeAttribute("style");
  applyStyle(element, style, context);
  // Hidden in the layers panel: not painted and takes no space, in the editor and in exports.
  if (node.attributes["data-hidden"] === "true")
    element.style.setProperty("display", "none", "important");
}

const sameAttributes = (a: ElementLayer["attributes"], b: ElementLayer["attributes"]) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** Puts exactly `desired` under `parent`, in order, moving existing nodes instead of rebuilding. */
function reconcileChildren(parent: Node, desired: readonly Node[]): boolean {
  let changed = false;
  let cursor = parent.firstChild;
  for (const node of desired) {
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
    changed = true;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = next;
    changed = true;
  }
  return changed;
}

export type DesignFrameRenderer = {
  readonly root: HTMLElement;
  /**
   * Brings the DOM to `frame`, keyed by layer ID: unchanged layers keep their nodes (and any
   * live preview on them), changed ones are patched in place, others are created, moved or
   * removed. `skipLayerId` (the layer being typed into) keeps its attributes and content
   * until it is released. Returns whether anything changed.
   */
  update: (
    frame: { layers: DesignLayerTree; style?: string | undefined },
    context: DesignRenderContext,
    options?: { skipLayerId?: string | null },
  ) => boolean;
  /**
   * The rendered element of a layer (an `SVGElement` for an inline SVG and its shapes), or null
   * for text layers and unrendered layers.
   */
  element: (layerId: string) => DesignLayerElement | null;
  /**
   * Rewrites one layer's element (the frame root for null) from the last model, dropping any
   * live preview on it, as when a gesture is cancelled or its save is refused. The layer being
   * typed into is left alone.
   */
  restore: (layerId: string | null) => void;
};

/**
 * Builds DOM for a frame from its persisted layers. Only allowed tags and attributes are
 * created; there is no HTML parsing, so nothing in a design can become script or markup.
 * Inline SVG is built with `createElementNS` from the SVG subset only, inside an `svg` layer.
 */
export function createDesignFrameRenderer(
  owner: Document,
  {
    layerIds = true,
    root = owner.createElement("div"),
  }: { layerIds?: boolean; root?: HTMLElement } = {},
): DesignFrameRenderer {
  guardInertControls(root);
  /**
   * `svg`: the inline SVG the layer was rendered in, so a move into another one rescopes it.
   * `range`: rendered as a styled range of a rich text block (no layer ID of its own).
   */
  type Entry = {
    node: DesignLayer;
    dom: DesignLayerElement | Text;
    svg: string | null;
    range: boolean;
  };
  let entries = new Map<string, Entry>();
  let lastStyle: string | undefined | null = null;
  let lastContext: DesignRenderContext | null = null;
  let lastSkip: string | null = null;
  const update: DesignFrameRenderer["update"] = (frame, context, { skipLayerId = null } = {}) => {
    let changed = false;
    const contextChanged = context !== lastContext;
    // The released layer is rewritten from the model: typing may have left anything in it.
    const released = lastSkip !== null && lastSkip !== skipLayerId ? lastSkip : null;
    if (contextChanged || frame.style !== lastStyle) {
      root.removeAttribute("style");
      applyStyle(root, frame.style ?? "", context);
      changed = true;
    }
    const nodes = new Map(frame.layers.nodes.map((node) => [node.id, node]));
    const next = new Map<string, Entry>();
    const keep = (id: string) => {
      const entry = entries.get(id);
      if (!entry || next.has(id)) return;
      next.set(id, entry);
      if (entry.node.type === "element") entry.node.children.forEach(keep);
    };
    /**
     * `svg` is the inline SVG the layer sits in (null in HTML) and `parentTag` its parent's tag:
     * SVG elements render only inside an `svg` layer, HTML only outside one, and text inside an
     * SVG only in its title or description. `range`: the parent is a rich text block, so an
     * element here is one of its styled ranges.
     */
    const render = (
      id: string,
      depth: number,
      force: boolean,
      svg: string | null,
      parentTag: string | null,
      range = false,
    ): DesignLayerElement | Text | null => {
      const node = nodes.get(id);
      if (!node || depth > DESIGN_CANVAS_MAX_DEPTH || next.has(id)) return null;
      const previous = entries.get(id);
      if (node.type === "text") {
        if (svg !== null && !DESIGN_SVG_TEXT_TAGS.has(parentTag ?? "")) return null;
        let text = previous?.dom.nodeType === Node.TEXT_NODE ? (previous.dom as Text) : null;
        if (!text) {
          text = owner.createTextNode(node.text);
          changed = true;
        } else if (text.data !== node.text) {
          text.data = node.text;
          changed = true;
        }
        next.set(id, { node, dom: text, svg, range: false });
        return text;
      }
      const scope = svg ?? (node.tag === "svg" ? node.id : null);
      if (scope === null ? !DESIGN_HTML_TAGS.has(node.tag) : !DESIGN_SVG_TAGS.has(node.tag))
        return null;
      if (scope !== null && DESIGN_SVG_TEXT_TAGS.has(parentTag ?? "")) return null;
      const namespace = scope === null ? "http://www.w3.org/1999/xhtml" : DESIGN_SVG_NAMESPACE;
      const reused =
        previous?.dom.nodeType === Node.ELEMENT_NODE &&
        (previous.dom as Element).localName === node.tag &&
        (previous.dom as Element).namespaceURI === namespace
          ? (previous.dom as DesignLayerElement)
          : null;
      const element =
        reused ??
        (scope === null
          ? owner.createElement(node.tag)
          : (owner.createElementNS(DESIGN_SVG_NAMESPACE, node.tag) as SVGElement));
      if (id === skipLayerId && reused) {
        // Typing in progress: leave this layer and its content alone until it is released.
        next.set(id, { node: previous!.node, dom: element, svg: scope, range });
        if (previous!.node.type === "element") previous!.node.children.forEach(keep);
        return element;
      }
      // A layer moved into another SVG (or out of one), or that became or stopped being a
      // styled range, is rewritten in its new role.
      const refresh =
        force ||
        id === released ||
        (reused !== null && (previous!.svg !== scope || previous!.range !== range));
      if (
        !reused ||
        contextChanged ||
        refresh ||
        (previous!.node !== node &&
          (previous!.node.type !== "element" ||
            !sameAttributes(previous!.node.attributes, node.attributes)))
      ) {
        writeElementLayer(element, node, context, layerIds, scope, range);
        changed = true;
      }
      next.set(id, { node, dom: element, svg: scope, range });
      if (!DESIGN_VOID_TAGS.has(node.tag)) {
        const rich =
          scope === null &&
          node.children.some((child) => nodes.get(child)?.type === "element") &&
          designTextBlockKind(nodes, id) === "rich";
        const children: Node[] = [];
        for (const child of node.children) {
          const dom = render(child, depth + 1, refresh, scope, node.tag, rich);
          if (dom) children.push(dom);
        }
        if (reconcileChildren(element, children)) changed = true;
      } else if (element.firstChild) {
        element.replaceChildren();
        changed = true;
      }
      return element;
    };
    const roots: Node[] = [];
    for (const id of frame.layers.roots) {
      const dom = render(id, 0, false, null, null);
      if (dom) roots.push(dom);
    }
    if (reconcileChildren(root, roots)) changed = true;
    entries = next;
    lastStyle = frame.style;
    lastContext = context;
    lastSkip = skipLayerId;
    return changed;
  };
  const restore: DesignFrameRenderer["restore"] = (layerId) => {
    if (!lastContext) return;
    if (layerId === null) {
      root.removeAttribute("style");
      applyStyle(root, lastStyle ?? "", lastContext);
      return;
    }
    const entry = entries.get(layerId);
    if (layerId === lastSkip || entry?.node.type !== "element") return;
    if (entry.dom.nodeType === Node.ELEMENT_NODE)
      writeElementLayer(
        entry.dom as DesignLayerElement,
        entry.node,
        lastContext,
        layerIds,
        entry.svg,
        entry.range,
      );
  };
  return {
    root,
    update,
    element: (layerId) => {
      const dom = entries.get(layerId)?.dom;
      return dom && dom.nodeType === Node.ELEMENT_NODE ? (dom as DesignLayerElement) : null;
    },
    restore,
  };
}

/** Base styles every frame shares; the frame's own style is applied inline on the root. */
export const DESIGN_FRAME_BASE_CSS = [
  ":host{all:initial;display:block;position:relative;overflow:clip;contain:strict;container-type:size;}",
  ":host>div{position:relative;width:100%;height:100%;overflow:hidden;box-sizing:border-box;background:#fff;color:#000;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:normal;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}",
  "*,*::before,*::after{box-sizing:border-box;}",
  // Form controls take the frame's font, as in most page stylesheets, instead of the browser's
  // small control font. Controls stay disabled (static frames), but those the design did not
  // disable are drawn with the enabled colours. Zero specificity: inline styles always win.
  ":where(button,input,select,textarea,optgroup,option){font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;}",
  `:where([${DESIGN_INERT_CONTROL_ATTRIBUTE}]):disabled{opacity:1;cursor:default;}`,
  `:where(button,input:is([type=button],[type=submit],[type=reset]))[${DESIGN_INERT_CONTROL_ATTRIBUTE}]:disabled{color:buttontext;background-color:buttonface;border-color:buttonborder;}`,
  `:where(input:not([type=button],[type=submit],[type=reset]),textarea,select)[${DESIGN_INERT_CONTROL_ATTRIBUTE}]:disabled{color:fieldtext;background-color:field;border-color:light-dark(#767676,#858585);}`,
  ":host>div *{-webkit-user-select:none;user-select:none;}",
  "[data-synara-editing],[data-synara-editing] *{-webkit-user-select:text!important;user-select:text!important;cursor:text;}",
  "[data-synara-editing]{outline:none;caret-color:currentColor;}",
  // The range a text edit styles stays shown while the inspector has focus.
  "::highlight(synara-canvas-text){background-color:Highlight;}",
].join("");

/** A one-off build (exports, previews): the same renderer, without keeping it. */
export function buildDesignFrameRoot(
  owner: Document,
  frame: { layers: DesignLayerTree; style?: string | undefined },
  context: DesignRenderContext,
  options: { layerIds?: boolean; root?: HTMLElement } = {},
): HTMLElement {
  const renderer = createDesignFrameRenderer(owner, options);
  renderer.update(frame, context);
  return renderer.root;
}

/** Gives a shadow root the frame stylesheet and a renderer that patches it in place. */
export function attachDesignFrameRenderer(shadow: ShadowRoot): DesignFrameRenderer {
  const sheet = shadow.ownerDocument.createElement("style");
  sheet.textContent = DESIGN_FRAME_BASE_CSS;
  const renderer = createDesignFrameRenderer(shadow.ownerDocument);
  shadow.replaceChildren(sheet, renderer.root);
  return renderer;
}

/** Static previews: rebuilt whole, since nothing in them is edited. */
export function renderDesignFrame(
  shadow: ShadowRoot,
  frame: { layers: DesignLayerTree; style?: string | undefined },
  context: DesignRenderContext,
): HTMLElement {
  const renderer = attachDesignFrameRenderer(shadow);
  renderer.update(frame, context);
  return renderer.root;
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A blob's bytes as base64, as canvas RPCs carry images (chunked to stay under arg limits). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** An asset with its bytes as base64, as `canvas.getAsset` returns them. */
export type LoadedCanvasAsset = CanvasAsset & { data: string };

const assetUrls = new Map<
  string,
  { url: string; uses: number; revoke?: ReturnType<typeof setTimeout> | undefined }
>();
/** A released URL stays valid briefly, so a re-render that acquires it again keeps it. */
const ASSET_URL_GRACE_MS = 5_000;

/**
 * Live rendering uses blob URLs, shared between frames by content hash and revoked a moment
 * after the last user releases them.
 */
export function acquireAssetUrl(asset: LoadedCanvasAsset): string {
  const existing = assetUrls.get(asset.sha256);
  if (existing) {
    clearTimeout(existing.revoke);
    existing.revoke = undefined;
    existing.uses++;
    return existing.url;
  }
  const url = URL.createObjectURL(new Blob([base64ToBytes(asset.data)], { type: asset.mimeType }));
  assetUrls.set(asset.sha256, { url, uses: 1 });
  return url;
}

export function releaseAssetUrl(asset: CanvasAsset): void {
  const existing = assetUrls.get(asset.sha256);
  if (!existing || --existing.uses > 0) return;
  existing.revoke = setTimeout(() => {
    if (assetUrls.get(asset.sha256) !== existing || existing.uses > 0) return;
    URL.revokeObjectURL(existing.url);
    assetUrls.delete(asset.sha256);
  }, ASSET_URL_GRACE_MS);
}

/** The family a font asset is known by in designs: its catalog name or `Canvas-<id>`. */
export const designFontFamily = (asset: CanvasAsset) => asset.font?.family ?? `Canvas-${asset.id}`;
/** Namespaced so a design's "Inter" can never replace a font Synara itself uses. */
export const registeredFontFamily = (family: string) => `SynaraCanvas ${family}`;

const registeredFaces = new Set<string>();

/** The design-name mapping of a work's fonts; the faces themselves load separately. */
export function designFontMap(assets: readonly CanvasAsset[]): Map<string, string> {
  const fonts = new Map<string, string>();
  for (const asset of assets) {
    if (asset.mimeType !== "font/woff2") continue;
    const family = designFontFamily(asset);
    fonts.set(family.toLowerCase(), registeredFontFamily(family));
  }
  return fonts;
}

/** Whether a font file is already registered in this document. */
export const isDesignFontRegistered = (asset: CanvasAsset) =>
  registeredFaces.has(`${designFontFamily(asset)}:${asset.sha256}`);

/** Registers one work font in this document once; text using it re-renders when it loads. */
export function registerDesignFont(asset: LoadedCanvasAsset): void {
  const key = `${designFontFamily(asset)}:${asset.sha256}`;
  if (asset.mimeType !== "font/woff2" || registeredFaces.has(key)) return;
  if (typeof FontFace === "undefined") return;
  try {
    const face = new FontFace(
      registeredFontFamily(designFontFamily(asset)),
      base64ToBytes(asset.data),
      {
        weight: asset.font?.weight ?? "100 900",
        style: asset.font?.style ?? "normal",
        ...(asset.font?.unicodeRange ? { unicodeRange: asset.font.unicodeRange } : {}),
        display: "swap",
      },
    );
    document.fonts.add(face);
    registeredFaces.add(key);
    void face.load().catch(() => {
      /* An invalid file falls back to the next family in the stack. */
    });
  } catch {
    /* Unsupported descriptors fall back to the next family in the stack. */
  }
}

/** Inline data URLs for isolated SVG rasterization, where blob URLs and FontFace do not reach. */
export function exportRenderContext(assets: readonly LoadedCanvasAsset[]): {
  context: DesignRenderContext;
  fontCss: string;
} {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const fonts = new Map<string, string>();
  let fontCss = "";
  for (const asset of assets) {
    if (asset.mimeType !== "font/woff2") continue;
    const family = registeredFontFamily(designFontFamily(asset));
    fonts.set(designFontFamily(asset).toLowerCase(), family);
    fontCss += `@font-face{font-family:"${family}";src:url("data:font/woff2;base64,${asset.data}") format("woff2");font-weight:${asset.font?.weight ?? "100 900"};font-style:${asset.font?.style ?? "normal"};${asset.font?.unicodeRange ? `unicode-range:${asset.font.unicodeRange};` : ""}}`;
  }
  return {
    context: {
      fonts,
      assetUrl: (id) => {
        const asset = byId.get(id);
        return asset && asset.mimeType !== "font/woff2"
          ? `data:${asset.mimeType};base64,${asset.data}`
          : null;
      },
    },
    fontCss,
  };
}

/** One frame as a standalone XHTML subtree for SVG foreignObject rasterization. */
export function buildDesignFrameExport(
  frame: Pick<DesignFrame, "layers" | "style" | "width" | "height">,
  assets: readonly LoadedCanvasAsset[],
  /** Paint only this layer (a layer export): everything else, frame fill included, is transparent. */
  isolateLayerId?: string,
): HTMLElement {
  const { context, fontCss } = exportRenderContext(assets);
  const host = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  host.setAttribute(
    "style",
    `all:initial;display:block;position:relative;overflow:hidden;contain:strict;container-type:size;width:${frame.width}px;height:${frame.height}px;`,
  );
  const sheet = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  // The SVG image is its own document, so the host selector becomes this wrapper's children.
  sheet.textContent = `${fontCss}${DESIGN_FRAME_BASE_CSS.replaceAll(":host>div", "[data-synara-export-root]").replace(/:host\{[^}]*\}/, "")}`;
  const root = buildDesignFrameRoot(document, frame, context, {
    layerIds: isolateLayerId !== undefined,
  });
  root.setAttribute("data-synara-export-root", "");
  if (isolateLayerId !== undefined) {
    // visibility inherits, but a visible descendant still paints inside a hidden ancestor, so
    // the layer keeps its exact layout, inherited text styles and its own subtree.
    const target = [...root.querySelectorAll<HTMLElement>(`[${DESIGN_LAYER_ATTRIBUTE}]`)].find(
      (element) => element.getAttribute(DESIGN_LAYER_ATTRIBUTE) === isolateLayerId,
    );
    root.style.setProperty("visibility", "hidden", "important");
    target?.style.setProperty("visibility", "visible", "important");
    for (const element of root.querySelectorAll(`[${DESIGN_LAYER_ATTRIBUTE}]`))
      element.removeAttribute(DESIGN_LAYER_ATTRIBUTE);
  }
  host.append(sheet, root);
  return host;
}
