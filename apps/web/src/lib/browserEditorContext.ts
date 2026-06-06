interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserViewport {
  width: number;
  height: number;
  devicePixelRatio?: number;
}

interface BrowserDocumentSize {
  width: number;
  height: number;
}

interface BrowserScrollPosition {
  x: number;
  y: number;
}

export interface BrowserElementEditorContext {
  url: string;
  title: string;
  selector: string;
  tagName: string;
  role: string | null;
  accessibleName: string | null;
  text: string;
  attributes: Record<string, string>;
  rect: BrowserRect;
  viewport: BrowserViewport;
  outerHTML: string;
}

export interface BrowserDrawingPoint {
  x: number;
  y: number;
}

export interface BrowserDrawingStroke {
  id: string;
  points: BrowserDrawingPoint[];
}

export type BrowserAnnotationArrowHandle =
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left";

export interface BrowserTextAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
  boxX?: number;
  boxY?: number;
}

export interface BrowserAnnotationArrow {
  id: string;
  from: BrowserDrawingPoint;
  to: BrowserDrawingPoint;
  sourceTextAnnotationId?: string;
  sourceHandle?: BrowserAnnotationArrowHandle;
}

export interface BrowserDrawingEditorContext {
  url: string;
  title: string;
  source?: "browser-annotation";
  viewport: BrowserViewport;
  document?: BrowserDocumentSize;
  scroll?: BrowserScrollPosition;
  selectedSelector?: string | null;
  selectedElement?: BrowserElementEditorContext | null;
  strokes: BrowserDrawingStroke[];
  textAnnotations?: BrowserTextAnnotation[];
  arrows?: BrowserAnnotationArrow[];
}

export type BrowserEditorPromptContextKind = "element" | "drawing" | "selection";

export interface BrowserEditorPromptContextSummary {
  kind: BrowserEditorPromptContextKind;
  block: string;
  title: string;
  url: string;
  label: string;
  detail: string;
}

const MAX_TEXT_LENGTH = 1_000;
const MAX_HTML_LENGTH = 2_000;
const MAX_ATTRIBUTE_VALUE_LENGTH = 200;
const BROWSER_EDITOR_BLOCK_PATTERN =
  /<browser-(element|drawing|selection)-selection>[\s\S]*?<\/browser-\1-selection>/g;

export function createBrowserEditorContextBlockRegex(): RegExp {
  return new RegExp(BROWSER_EDITOR_BLOCK_PATTERN.source, "g");
}

function escapeCssIdentifier(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function selectorForElement(target: Element): string {
  if (target.id) {
    return `#${escapeCssIdentifier(target.id)}`;
  }

  const parts: string[] = [];
  let current: Element | null = target;
  while (current && parts.length < 5) {
    let part = current.localName;
    if (!part) {
      break;
    }
    if (current.classList.length > 0) {
      part += `.${Array.from(current.classList).slice(0, 3).map(escapeCssIdentifier).join(".")}`;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child) => child.localName === current?.localName,
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ");
}

function redactAttribute(name: string, value: string): string {
  const lowerName = name.toLowerCase();
  if (
    lowerName === "value" ||
    lowerName.includes("token") ||
    lowerName.includes("secret") ||
    lowerName.includes("password")
  ) {
    return "[redacted]";
  }
  return value;
}

function readElementText(element: Element): string {
  const maybeText = "innerText" in element ? element.innerText : element.textContent;
  return typeof maybeText === "string" ? maybeText : "";
}

function readElementAttributes(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes).slice(0, 30)) {
    attributes[attribute.name] = redactAttribute(attribute.name, attribute.value);
  }
  return attributes;
}

export function readBrowserElementContextFromDocumentAtPoint(input: {
  document: Document;
  point: BrowserDrawingPoint;
  url?: string;
  title?: string;
  viewport?: BrowserViewport;
}): BrowserElementEditorContext | null {
  const ownerWindow = input.document.defaultView;
  const ElementCtor = ownerWindow?.Element ?? Element;
  const element = input.document.elementFromPoint(input.point.x, input.point.y);
  if (!element || !(element instanceof ElementCtor)) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const text = readElementText(element);
  const accessibleName =
    element.getAttribute("aria-label") ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    text;

  return {
    url: input.url ?? ownerWindow?.location.href ?? "",
    title: input.title ?? input.document.title,
    selector: selectorForElement(element),
    tagName: element.tagName,
    role: element.getAttribute("role"),
    accessibleName,
    text,
    attributes: readElementAttributes(element),
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    viewport:
      input.viewport ??
      ({
        width: ownerWindow?.innerWidth ?? input.document.documentElement.clientWidth,
        height: ownerWindow?.innerHeight ?? input.document.documentElement.clientHeight,
        devicePixelRatio: ownerWindow?.devicePixelRatio,
      } satisfies BrowserViewport),
    outerHTML: element.outerHTML,
  };
}

export function cdpElementContextExpression(x: number, y: number): string {
  return `(() => {
    const x = ${JSON.stringify(x)};
    const y = ${JSON.stringify(y)};
    const element = document.elementFromPoint(x, y);
    if (!element || !(element instanceof Element)) {
      return null;
    }
    const cssEscape = typeof CSS !== "undefined" && CSS.escape ? CSS.escape.bind(CSS) : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
    const selectorFor = (target) => {
      if (!(target instanceof Element)) return "";
      if (target.id) return "#" + cssEscape(target.id);
      const parts = [];
      let current = target;
      while (current && current instanceof Element && parts.length < 5) {
        let part = current.localName;
        if (!part) break;
        if (current.classList.length > 0) {
          part += "." + Array.from(current.classList).slice(0, 3).map(cssEscape).join(".");
        }
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
          if (siblings.length > 1) {
            part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
          }
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(" > ");
    };
    const redactAttribute = (name, value) => {
      const lowerName = name.toLowerCase();
      if (lowerName === "value" || lowerName.includes("token") || lowerName.includes("secret") || lowerName.includes("password")) {
        return "[redacted]";
      }
      return value;
    };
    const attributes = {};
    for (const attribute of Array.from(element.attributes).slice(0, 30)) {
      attributes[attribute.name] = redactAttribute(attribute.name, attribute.value);
    }
    const rect = element.getBoundingClientRect();
    const text = "innerText" in element ? element.innerText : element.textContent;
    const accessibleName =
      element.getAttribute("aria-label") ||
      element.getAttribute("alt") ||
      element.getAttribute("title") ||
      (typeof text === "string" ? text : "");
    return {
      url: window.location.href,
      title: document.title,
      selector: selectorFor(element),
      tagName: element.tagName,
      role: element.getAttribute("role"),
      accessibleName,
      text: typeof text === "string" ? text : "",
      attributes,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      outerHTML: element.outerHTML,
    };
  })()`;
}

export function isBrowserElementEditorContext(
  value: unknown,
): value is BrowserElementEditorContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BrowserElementEditorContext>;
  return (
    typeof candidate.url === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.selector === "string" &&
    typeof candidate.tagName === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.outerHTML === "string" &&
    typeof candidate.attributes === "object" &&
    candidate.attributes !== null &&
    typeof candidate.rect === "object" &&
    candidate.rect !== null &&
    typeof candidate.viewport === "object" &&
    candidate.viewport !== null
  );
}

function truncateText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 16)).trimEnd()}... [truncated]`;
}

function formatAttributes(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes);
  if (entries.length === 0) {
    return "none";
  }
  return entries
    .map(([key, value]) => {
      const nextValue = truncateText(value, MAX_ATTRIBUTE_VALUE_LENGTH);
      return `- ${key}: ${nextValue.length > 0 ? nextValue : "(empty)"}`;
    })
    .join("\n");
}

function formatRect(rect: BrowserRect): string {
  return `x=${Math.round(rect.x)}, y=${Math.round(rect.y)}, width=${Math.round(rect.width)}, height=${Math.round(rect.height)}`;
}

function formatViewport(viewport: BrowserViewport): string {
  const pixelRatio =
    typeof viewport.devicePixelRatio === "number"
      ? `, devicePixelRatio=${Number(viewport.devicePixelRatio.toFixed(2))}`
      : "";
  return `width=${Math.round(viewport.width)}, height=${Math.round(viewport.height)}${pixelRatio}`;
}

function formatDocumentSize(document: BrowserDocumentSize): string {
  return `width=${Math.round(document.width)}, height=${Math.round(document.height)}`;
}

function formatScrollPosition(scroll: BrowserScrollPosition): string {
  return `x=${Math.round(scroll.x)}, y=${Math.round(scroll.y)}`;
}

function formatPoint(point: BrowserDrawingPoint): string {
  return `x=${Math.round(point.x)}, y=${Math.round(point.y)}`;
}

function formatStrokeSummary(points: BrowserDrawingPoint[]): string {
  const start = points[0] ?? { x: 0, y: 0 };
  const end = points[points.length - 1] ?? start;
  const bounds = points.reduce(
    (current, point) => ({
      minX: Math.min(current.minX, point.x),
      minY: Math.min(current.minY, point.y),
      maxX: Math.max(current.maxX, point.x),
      maxY: Math.max(current.maxY, point.y),
    }),
    {
      minX: start.x,
      minY: start.y,
      maxX: start.x,
      maxY: start.y,
    },
  );
  return [
    `start: ${formatPoint(start)}`,
    `end: ${formatPoint(end)}`,
    `bounds: x=${Math.round(bounds.minX)}, y=${Math.round(bounds.minY)}, width=${Math.round(bounds.maxX - bounds.minX)}, height=${Math.round(bounds.maxY - bounds.minY)}`,
    `pointCount: ${points.length}`,
  ].join("; ");
}

function formatTextAnnotation(annotation: BrowserTextAnnotation): string {
  const text = truncateText(annotation.text, MAX_TEXT_LENGTH);
  const boxPosition =
    typeof annotation.boxX === "number" && typeof annotation.boxY === "number"
      ? `, box: x=${Math.round(annotation.boxX)}, y=${Math.round(annotation.boxY)}`
      : "";
  return `x=${Math.round(annotation.x)}, y=${Math.round(annotation.y)}${boxPosition}, text: ${text || "(empty)"}`;
}

function formatArrowSummary(arrow: BrowserAnnotationArrow): string {
  const minX = Math.min(arrow.from.x, arrow.to.x);
  const minY = Math.min(arrow.from.y, arrow.to.y);
  const maxX = Math.max(arrow.from.x, arrow.to.x);
  const maxY = Math.max(arrow.from.y, arrow.to.y);
  const source = arrow.sourceTextAnnotationId
    ? `; sourceTextAnnotationId: ${arrow.sourceTextAnnotationId}`
    : "";
  const handle = arrow.sourceHandle ? `; sourceHandle: ${arrow.sourceHandle}` : "";
  return [
    `from: ${formatPoint(arrow.from)}`,
    `to: ${formatPoint(arrow.to)}`,
    `bounds: x=${Math.round(minX)}, y=${Math.round(minY)}, width=${Math.round(maxX - minX)}, height=${Math.round(maxY - minY)}`,
  ].join("; ") + source + handle;
}

function indentLines(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatSelectedElement(context: BrowserElementEditorContext): string[] {
  return [
    "selectedElement:",
    `  selector: ${context.selector || "(unavailable)"}`,
    `  tag: ${context.tagName.toLowerCase()}`,
    `  role: ${context.role ?? "(none)"}`,
    `  accessibleName: ${context.accessibleName ?? "(none)"}`,
    `  bounds: ${formatRect(context.rect)}`,
    "  attributes:",
    indentLines(formatAttributes(context.attributes), "    "),
    `  text: ${truncateText(context.text, MAX_TEXT_LENGTH) || "(empty)"}`,
    "  outerHTML:",
    `    ${truncateText(context.outerHTML, MAX_HTML_LENGTH) || "(empty)"}`,
  ];
}

function readPromptBlockField(block: string, field: string): string {
  const match = block.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

function compactPromptBlockText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function summarizeBrowserEditorPromptBlock(
  block: string,
): BrowserEditorPromptContextSummary | null {
  const firstLine = block.match(/^<browser-(element|drawing|selection)-selection>/)?.[1] ?? null;
  if (firstLine !== "element" && firstLine !== "drawing" && firstLine !== "selection") {
    return null;
  }

  const title = readPromptBlockField(block, "title");
  const url = readPromptBlockField(block, "url");
  if (firstLine === "element") {
    const tag = readPromptBlockField(block, "tag");
    const selector = readPromptBlockField(block, "selector");
    const text = readPromptBlockField(block, "text");
    const fallbackLabel = tag || selector || "element";
    return {
      kind: "element",
      block,
      title,
      url,
      label: `Browser element: ${fallbackLabel}`,
      detail: compactPromptBlockText(text || selector || title || url || "Selected page element"),
    };
  }
  if (firstLine === "selection") {
    const selector = readPromptBlockField(block, "selectedSelector");
    const tag = readPromptBlockField(block, "tag");
    return {
      kind: "selection",
      block,
      title,
      url,
      label: `Browser selection: ${tag || selector || "element"}`,
      detail: compactPromptBlockText(selector || title || url || "Selected page element"),
    };
  }

  const strokeCount = readPromptBlockField(block, "strokeCount");
  const textCount = readPromptBlockField(block, "textCount");
  const arrowCount = readPromptBlockField(block, "arrowCount");
  const details = [
    strokeCount && strokeCount !== "0"
      ? `${strokeCount} stroke${strokeCount === "1" ? "" : "s"}`
      : "",
    textCount && textCount !== "0" ? `${textCount} text note${textCount === "1" ? "" : "s"}` : "",
    arrowCount && arrowCount !== "0" ? `${arrowCount} arrow${arrowCount === "1" ? "" : "s"}` : "",
  ].filter(Boolean);
  return {
    kind: "drawing",
    block,
    title,
    url,
    label: details.length > 0 ? `Live Editor Context: ${details.join(", ")}` : "Live Editor Context",
    detail: compactPromptBlockText(title || url || "Live editor context"),
  };
}

export function appendBrowserEditorContextPrompt(currentPrompt: string, block: string): string {
  const trimmedCurrent = currentPrompt.trimEnd();
  if (trimmedCurrent.length === 0) {
    return block;
  }
  return `${trimmedCurrent}\n\n${block}`;
}

function normalizePromptBlockSpacing(prompt: string): string {
  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}

function isBrowserAnnotationPromptBlock(block: string): boolean {
  return (
    block.startsWith("<browser-drawing-selection>") &&
    /^source:\s*browser-annotation$/m.test(block)
  );
}

export function upsertBrowserAnnotationContextPrompt(currentPrompt: string, block: string): string {
  let replaced = false;
  const nextPrompt = currentPrompt.replace(createBrowserEditorContextBlockRegex(), (match) => {
    if (!isBrowserAnnotationPromptBlock(match)) {
      return match;
    }
    replaced = true;
    return block;
  });
  if (replaced) {
    return normalizePromptBlockSpacing(nextPrompt);
  }
  return appendBrowserEditorContextPrompt(nextPrompt, block);
}

export function removeBrowserAnnotationContextPrompt(currentPrompt: string): string {
  return normalizePromptBlockSpacing(
    currentPrompt.replace(createBrowserEditorContextBlockRegex(), (match) =>
      isBrowserAnnotationPromptBlock(match) ? "" : match,
    ),
  );
}

export function buildBrowserElementPromptBlock(context: BrowserElementEditorContext): string {
  return [
    "<browser-element-selection>",
    `url: ${context.url}`,
    `title: ${context.title || "(untitled)"}`,
    `selector: ${context.selector || "(unavailable)"}`,
    `tag: ${context.tagName.toLowerCase()}`,
    `role: ${context.role ?? "(none)"}`,
    `accessibleName: ${context.accessibleName ?? "(none)"}`,
    `viewport: ${formatViewport(context.viewport)}`,
    `bounds: ${formatRect(context.rect)}`,
    "attributes:",
    formatAttributes(context.attributes),
    `text: ${truncateText(context.text, MAX_TEXT_LENGTH) || "(empty)"}`,
    "outerHTML:",
    truncateText(context.outerHTML, MAX_HTML_LENGTH) || "(empty)",
    "</browser-element-selection>",
  ].join("\n");
}

export function buildBrowserSelectionPromptBlock(context: BrowserElementEditorContext): string {
  return [
    "<browser-selection-selection>",
    "source: browser-selection",
    `url: ${context.url}`,
    `title: ${context.title || "(untitled)"}`,
    `selectedSelector: ${context.selector || "(unavailable)"}`,
    `tag: ${context.tagName.toLowerCase()}`,
    `role: ${context.role ?? "(none)"}`,
    `accessibleName: ${context.accessibleName ?? "(none)"}`,
    `viewport: ${formatViewport(context.viewport)}`,
    `bounds: ${formatRect(context.rect)}`,
    "attributes:",
    formatAttributes(context.attributes),
    `text: ${truncateText(context.text, MAX_TEXT_LENGTH) || "(empty)"}`,
    "outerHTML:",
    truncateText(context.outerHTML, MAX_HTML_LENGTH) || "(empty)",
    "</browser-selection-selection>",
  ].join("\n");
}

export function buildBrowserDrawingPromptBlock(context: BrowserDrawingEditorContext): string {
  const textAnnotations = context.textAnnotations ?? [];
  const arrows = context.arrows ?? [];
  const selectedElement = context.selectedElement ?? null;
  const selectedSelector = context.selectedSelector ?? selectedElement?.selector ?? null;
  return [
    "<browser-drawing-selection>",
    ...(context.source ? [`source: ${context.source}`] : []),
    `url: ${context.url}`,
    `title: ${context.title || "(untitled)"}`,
    `viewport: ${formatViewport(context.viewport)}`,
    ...(context.document ? [`document: ${formatDocumentSize(context.document)}`] : []),
    ...(context.scroll ? [`scroll: ${formatScrollPosition(context.scroll)}`] : []),
    ...(selectedSelector
      ? [`selectedSelector: ${selectedSelector}`]
      : ["selectedSelector: (none)"]),
    ...(selectedElement ? formatSelectedElement(selectedElement) : ["selectedElement: (none)"]),
    `strokeCount: ${context.strokes.length}`,
    "strokes:",
    ...context.strokes.map(
      (stroke, index) =>
        `- stroke ${index + 1}: ${formatStrokeSummary(stroke.points)}`,
    ),
    `textCount: ${textAnnotations.length}`,
    "textAnnotations:",
    ...textAnnotations.map(
      (annotation, index) => `- text ${index + 1}: ${formatTextAnnotation(annotation)}`,
    ),
    `arrowCount: ${arrows.length}`,
    "arrows:",
    ...arrows.map((arrow, index) => `- arrow ${index + 1}: ${formatArrowSummary(arrow)}`),
    "</browser-drawing-selection>",
  ].join("\n");
}
