interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserViewport {
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

export interface BrowserElementStyleSnapshot {
  color: string;
  backgroundColor: string;
  backgroundImage?: string;
  backgroundPosition?: string;
  backgroundSize?: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: string;
  letterSpacing: string;
  textAlign: string;
  opacity: string;
  display: string;
  padding: string;
  margin: string;
  borderWidth: string;
  borderColor: string;
  borderRadius: string;
  boxShadow: string;
  filter?: string;
  animationName?: string;
  animationDuration?: string;
  animationTimingFunction?: string;
  animationIterationCount?: string;
}

export type BrowserElementStylePatch = Partial<Omit<BrowserElementStyleSnapshot, "display">> & {
  effectTarget?: BrowserElementEffectSource;
};

export type BrowserElementFontSource = "current" | "page" | "system" | "fallback";
export type BrowserElementEffectSource = "element" | "::before" | "::after";
export type BrowserElementEffectKind = "shimmer" | "gradient" | "animation" | "visual";

export interface BrowserElementEffectSnapshot {
  source: BrowserElementEffectSource;
  label: string;
  kind: BrowserElementEffectKind;
  backgroundImage: string;
  backgroundPosition: string;
  backgroundSize: string;
  backgroundColor: string;
  animationName: string;
  animationDuration: string;
  animationTimingFunction: string;
  animationIterationCount: string;
  opacity: string;
  filter: string;
  transform: string;
  customProperties?: Record<string, string>;
}

export interface BrowserElementFontOption {
  value: string;
  label: string;
  source: BrowserElementFontSource;
  loaded?: boolean;
}

export interface BrowserElementPayloadMetadata {
  textLength: number;
  textTruncated: boolean;
  outerHTMLLength: number;
  outerHTMLTruncated: boolean;
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
  payload?: BrowserElementPayloadMetadata;
  style?: BrowserElementStyleSnapshot;
  availableFonts?: BrowserElementFontOption[];
  effects?: BrowserElementEffectSnapshot[];
}

export interface BrowserElementHoverContext {
  selector: string;
  tagName: string;
  rect: BrowserRect;
  viewport?: BrowserViewport;
}

export interface BrowserDrawingPoint {
  x: number;
  y: number;
}

export interface BrowserDrawingStroke {
  id: string;
  points: BrowserDrawingPoint[];
  strokeSize?: number;
  animated?: boolean;
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
  fontSize?: number;
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
  capture?: BrowserRect;
  selectedSelector?: string | null;
  selectedElement?: BrowserElementEditorContext | null;
  strokes: BrowserDrawingStroke[];
  textAnnotations?: BrowserTextAnnotation[];
  arrows?: BrowserAnnotationArrow[];
}

export interface BrowserStyleEditContext {
  element: BrowserElementEditorContext;
  currentStyle?: BrowserElementStyleSnapshot | null;
  previewStyle: BrowserElementStylePatch;
  manualOverride: boolean;
}

export type BrowserEditorPromptContextKind = "element" | "drawing" | "selection" | "style-edit";

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
const MAX_ELEMENT_TEXT_PAYLOAD_LENGTH = 2_000;
const MAX_ELEMENT_HTML_PAYLOAD_LENGTH = 4_000;
const MAX_ATTRIBUTE_VALUE_LENGTH = 200;
const BROWSER_EDITOR_BLOCK_PATTERN =
  /<browser-(element|drawing|selection|style-edit|live-editor)-selection>[\s\S]*?<\/browser-\1-selection>/g;

// Page-derived text (element text, outerHTML, attribute values) is spliced verbatim
// into prompt blocks whose boundaries are the tags above. Neutralize any literal
// occurrence of those delimiter tags inside embedded content so a page that happens
// to contain them cannot prematurely close (or open) a block and corrupt the
// extraction/removal/replacement regexes.
function sanitizeBrowserEditorBlockText(value: string): string {
  return value.replace(
    /<(\/?)(browser-(?:element|drawing|selection|style-edit|live-editor)-selection)>/g,
    "<$1$2 >",
  );
}
export const BROWSER_STYLE_EDIT_STYLING_NOTE =
  "Implement these visual changes in accordance with the project's styling framework and configuration. Prefer the closest local styling source first: component props/classes, nearby module CSS, scoped styles, Tailwind utilities, design tokens/theme config, then broader/global styles only when appropriate. Avoid permanent inline styles unless the project already uses them or no better styling location exists. If a requested font is not already loaded, add it through the project's existing font pipeline, framework font helper, theme config, or CSS import before applying it.";
const BROWSER_STYLE_PATCH_KEYS = [
  "color",
  "backgroundColor",
  "backgroundImage",
  "backgroundPosition",
  "backgroundSize",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "opacity",
  "padding",
  "margin",
  "borderWidth",
  "borderColor",
  "borderRadius",
  "boxShadow",
  "filter",
  "animationName",
  "animationDuration",
  "animationTimingFunction",
  "animationIterationCount",
] as const;

export const BROWSER_SYSTEM_FONT_OPTIONS: readonly BrowserElementFontOption[] = [
  { value: "system-ui, sans-serif", label: "System UI", source: "system", loaded: true },
  { value: "Inter, system-ui, sans-serif", label: "Inter stack", source: "fallback" },
  { value: '"Segoe UI", system-ui, sans-serif', label: "Segoe UI", source: "system" },
  { value: '"Helvetica Neue", Arial, sans-serif', label: "Helvetica Neue", source: "system" },
  { value: "Arial, sans-serif", label: "Arial", source: "system" },
  { value: 'Georgia, "Times New Roman", serif', label: "Georgia", source: "system" },
  { value: '"Times New Roman", Times, serif', label: "Times New Roman", source: "system" },
  { value: "ui-serif, Georgia, serif", label: "UI Serif", source: "system" },
  { value: '"SF Mono", ui-monospace, monospace', label: "SF Mono", source: "system" },
  {
    value: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    label: "UI Mono",
    source: "system",
  },
] as const;

export function createBrowserEditorContextBlockRegex(): RegExp {
  return new RegExp(BROWSER_EDITOR_BLOCK_PATTERN.source, "g");
}

export function extractBrowserEditorContextPromptBlocks(
  prompt: string,
): BrowserEditorPromptContextSummary[] {
  return Array.from(prompt.matchAll(createBrowserEditorContextBlockRegex()))
    .map((match) => summarizeBrowserEditorPromptBlock(match[0] ?? ""))
    .filter((summary): summary is BrowserEditorPromptContextSummary => summary !== null);
}

export function removeBrowserEditorContextPrompts(prompt: string): string {
  return normalizePromptBlockSpacing(prompt.replace(createBrowserEditorContextBlockRegex(), ""));
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
    const currentElement: Element = current;
    const parent: Element | null = currentElement.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child: Element) => child.localName === currentElement.localName,
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(currentElement) + 1})`;
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

function truncateElementPayloadValue(value: string, limit: number): string {
  const sanitized = sanitizeBrowserEditorBlockText(value);
  if (sanitized.length <= limit) {
    return sanitized;
  }
  const suffix = `\n...[truncated; original length ${sanitized.length} chars]`;
  return `${sanitized.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
}

function buildElementPayloadMetadata(input: {
  text: string;
  outerHTML: string;
}): BrowserElementPayloadMetadata {
  return {
    textLength: input.text.length,
    textTruncated: input.text.length > MAX_ELEMENT_TEXT_PAYLOAD_LENGTH,
    outerHTMLLength: input.outerHTML.length,
    outerHTMLTruncated: input.outerHTML.length > MAX_ELEMENT_HTML_PAYLOAD_LENGTH,
  };
}

function readElementAttributes(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes).slice(0, 30)) {
    attributes[attribute.name] = redactAttribute(attribute.name, attribute.value);
  }
  return attributes;
}

function fourPartStyleValue(top: string, right: string, bottom: string, left: string): string {
  if (top === right && right === bottom && bottom === left) {
    return top;
  }
  if (top === bottom && right === left) {
    return `${top} ${right}`;
  }
  return `${top} ${right} ${bottom} ${left}`;
}

function unquoteFontFamily(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function quoteFontFamilyIfNeeded(value: string): string {
  const trimmed = unquoteFontFamily(value);
  if (!trimmed) return "";
  if (
    /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|emoji|math|fangsong)$/i.test(
      trimmed,
    )
  ) {
    return trimmed;
  }
  return /[\s"'(),]/.test(trimmed) ? JSON.stringify(trimmed) : trimmed;
}

export function splitFontFamilyList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : (quote ?? char);
      current += char;
      continue;
    }
    if (char === "," && !quote) {
      const part = current.trim();
      if (part) parts.push(part);
      current = "";
      continue;
    }
    current += char;
  }
  const lastPart = current.trim();
  if (lastPart) parts.push(lastPart);
  return parts;
}

function fontOptionKey(value: string): string {
  return value.replace(/\s+/g, " ").replace(/["']/g, "").trim().toLowerCase();
}

function fontLabel(value: string): string {
  return unquoteFontFamily(splitFontFamilyList(value)[0] ?? value) || value;
}

function isFontFamilyLikeValue(value: string): boolean {
  const trimmed = value.trim();
  if (
    !trimmed ||
    /^(inherit|initial|revert|revert-layer|unset|none|normal|auto)$/i.test(trimmed) ||
    /^-?(?:\d|\.\d)/.test(trimmed) ||
    /^(calc|clamp|min|max|rgb|rgba|hsl|hsla|color|var)\(/i.test(trimmed)
  ) {
    return false;
  }
  if (trimmed.includes(",")) {
    return true;
  }
  const unquoted = unquoteFontFamily(trimmed);
  return /^[a-zA-Z_-][\w\s.-]*$/.test(unquoted);
}

function isLikelyFontFamilyProperty(name: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName === "font-family" || lowerName.includes("fontfamily")) {
    return true;
  }
  if (!lowerName.startsWith("--")) {
    return false;
  }
  return (
    (lowerName.includes("font") || lowerName.includes("typeface")) &&
    !/(size|weight|line|letter|tracking|spacing|style|smoothing|feature|variant|stretch|kerning)/.test(
      lowerName,
    )
  );
}

function addFontStackOptions(
  options: BrowserElementFontOption[],
  value: string,
  source: BrowserElementFontSource,
  loaded?: boolean,
): void {
  const trimmed = value.trim();
  if (!isFontFamilyLikeValue(trimmed)) {
    return;
  }
  const add = (family: string) => {
    const normalized = quoteFontFamilyIfNeeded(family);
    if (!normalized) return;
    options.push({
      value: normalized,
      label: fontLabel(normalized),
      source,
      ...(typeof loaded === "boolean" ? { loaded } : {}),
    });
  };
  add(trimmed);
  for (const family of splitFontFamilyList(trimmed)) {
    add(family);
  }
}

function collectFontsFromRules(rules: CSSRuleList, pageFonts: BrowserElementFontOption[]): void {
  for (const rule of Array.from(rules)) {
    if (typeof CSSFontFaceRule !== "undefined" && rule instanceof CSSFontFaceRule) {
      addFontStackOptions(pageFonts, rule.style.getPropertyValue("font-family"), "page");
      continue;
    }
    if (typeof CSSStyleRule !== "undefined" && rule instanceof CSSStyleRule) {
      addFontStackOptions(pageFonts, rule.style.getPropertyValue("font-family"), "page");
      for (const propertyName of Array.from(rule.style)) {
        if (isLikelyFontFamilyProperty(propertyName)) {
          addFontStackOptions(pageFonts, rule.style.getPropertyValue(propertyName), "page");
        }
      }
      continue;
    }
    const nestedRules = (rule as { cssRules?: CSSRuleList }).cssRules;
    if (nestedRules) {
      collectFontsFromRules(nestedRules, pageFonts);
    }
  }
}

const pageFontOptionsCache = new WeakMap<
  Document,
  { key: string; pageFonts: BrowserElementFontOption[] }
>();

function pageFontCacheKey(ownerWindow: Window | null): string {
  const document = ownerWindow?.document;
  return [
    ownerWindow?.location.href ?? "",
    document?.fonts?.size ?? 0,
    document?.styleSheets.length ?? 0,
  ].join("\u0000");
}

export function normalizeBrowserElementFontOptions(input: {
  currentFontFamily?: string | null;
  pageFonts?: readonly Partial<BrowserElementFontOption>[];
  includeSystemFonts?: boolean;
}): BrowserElementFontOption[] {
  const options: BrowserElementFontOption[] = [];
  const seen = new Set<string>();
  const addOption = (
    option: Partial<BrowserElementFontOption>,
    fallbackSource: BrowserElementFontSource,
  ) => {
    const value = option.value?.trim();
    if (!value) return;
    const key = fontOptionKey(value);
    if (seen.has(key)) return;
    seen.add(key);
    options.push({
      value,
      label: option.label?.trim() || fontLabel(value),
      source: option.source ?? fallbackSource,
      ...(typeof option.loaded === "boolean" ? { loaded: option.loaded } : {}),
    });
  };

  if (input.currentFontFamily?.trim()) {
    addOption(
      {
        value: input.currentFontFamily.trim(),
        label: `Current: ${fontLabel(input.currentFontFamily)}`,
        source: "current",
        loaded: true,
      },
      "current",
    );
  }
  for (const option of input.pageFonts ?? []) {
    addOption(option, "page");
  }
  if (input.includeSystemFonts !== false) {
    for (const option of BROWSER_SYSTEM_FONT_OPTIONS) {
      addOption(option, option.source);
    }
  }
  return options.slice(0, 80);
}

function readPageFontOptions(ownerWindow: Window | null): BrowserElementFontOption[] {
  const document = ownerWindow?.document;
  if (!ownerWindow || !document) {
    return [];
  }
  const key = pageFontCacheKey(ownerWindow);
  const cached = pageFontOptionsCache.get(document);
  if (cached?.key === key) {
    return cached.pageFonts;
  }

  const pageFonts: BrowserElementFontOption[] = [];
  const addPageFont = (value: string, loaded?: boolean) => {
    addFontStackOptions(pageFonts, value, "page", loaded);
  };

  try {
    const fonts = document.fonts;
    if (fonts) {
      for (const fontFace of Array.from(fonts).slice(0, 80)) {
        addPageFont(fontFace.family, fontFace.status === "loaded");
      }
    }
  } catch {
    // Cross-origin or incomplete font APIs should not block element inspection.
  }

  try {
    for (const sheet of Array.from(document.styleSheets ?? [])) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      collectFontsFromRules(rules, pageFonts);
    }
  } catch {
    // Stylesheet inspection is best-effort; inaccessible sheets are expected.
  }

  try {
    const sample = Array.from(
      document.querySelectorAll(
        "body,h1,h2,h3,h4,h5,h6,p,a,button,input,textarea,label,nav,header,main,section,article,[class]",
      ),
    ).slice(0, 160);
    for (const element of sample) {
      const fontFamily = ownerWindow.getComputedStyle(element).fontFamily;
      if (fontFamily) {
        addPageFont(fontFamily, true);
      }
    }
  } catch {
    // Computed style sampling is opportunistic; inspection should still succeed.
  }

  pageFontOptionsCache.set(document, { key, pageFonts });
  return pageFonts;
}

function readAvailableFontOptions(
  ownerWindow: Window | null,
  currentFontFamily: string,
): BrowserElementFontOption[] {
  return normalizeBrowserElementFontOptions({
    currentFontFamily,
    pageFonts: readPageFontOptions(ownerWindow),
  });
}

export function readElementStyleSnapshot(
  element: Element,
  ownerWindow: Window | null = element.ownerDocument.defaultView,
): BrowserElementStyleSnapshot {
  const style = (ownerWindow ?? window).getComputedStyle(element);

  return {
    color: style.color,
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    backgroundPosition: style.backgroundPosition,
    backgroundSize: style.backgroundSize,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    textAlign: style.textAlign,
    opacity: style.opacity,
    display: style.display,
    padding: fourPartStyleValue(
      style.paddingTop,
      style.paddingRight,
      style.paddingBottom,
      style.paddingLeft,
    ),
    margin: fourPartStyleValue(
      style.marginTop,
      style.marginRight,
      style.marginBottom,
      style.marginLeft,
    ),
    borderWidth: fourPartStyleValue(
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
    ),
    borderColor: fourPartStyleValue(
      style.borderTopColor,
      style.borderRightColor,
      style.borderBottomColor,
      style.borderLeftColor,
    ),
    borderRadius: fourPartStyleValue(
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ),
    boxShadow: style.boxShadow,
    filter: style.filter,
    animationName: style.animationName,
    animationDuration: style.animationDuration,
    animationTimingFunction: style.animationTimingFunction,
    animationIterationCount: style.animationIterationCount,
  };
}

function readEffectCustomProperties(style: CSSStyleDeclaration): Record<string, string> {
  const customProperties: Record<string, string> = {};
  for (const propertyName of Array.from(style)) {
    if (!propertyName.startsWith("--")) {
      continue;
    }
    const value = style.getPropertyValue(propertyName).trim();
    if (value) {
      customProperties[propertyName] = value;
    }
    if (Object.keys(customProperties).length >= 24) {
      break;
    }
  }
  return customProperties;
}

function readEffectSnapshot(
  style: CSSStyleDeclaration,
  source: BrowserElementEffectSource,
): BrowserElementEffectSnapshot | null {
  const backgroundImage = style.backgroundImage || "";
  const animationName = style.animationName || "";
  const hasGradient = /gradient\(/i.test(backgroundImage);
  const hasAnimation = animationName.trim() !== "" && animationName !== "none";
  const hasFilter = Boolean(style.filter && style.filter !== "none");
  const hasTransform = Boolean(style.transform && style.transform !== "none");
  const hasVisualBackground =
    Boolean(backgroundImage && backgroundImage !== "none") ||
    Boolean(
      style.backgroundColor && !/rgba?\(0,\s*0,\s*0(?:,\s*0)?\)/i.test(style.backgroundColor),
    );
  if (!hasGradient && !hasAnimation && !hasFilter && !hasTransform && !hasVisualBackground) {
    return null;
  }
  const kind: BrowserElementEffectKind =
    hasGradient && hasAnimation
      ? "shimmer"
      : hasGradient
        ? "gradient"
        : hasAnimation
          ? "animation"
          : "visual";
  return {
    source,
    label: source === "element" ? "Element" : source,
    kind,
    backgroundImage,
    backgroundPosition: style.backgroundPosition,
    backgroundSize: style.backgroundSize,
    backgroundColor: style.backgroundColor,
    animationName,
    animationDuration: style.animationDuration,
    animationTimingFunction: style.animationTimingFunction,
    animationIterationCount: style.animationIterationCount,
    opacity: style.opacity,
    filter: style.filter,
    transform: style.transform,
    customProperties: readEffectCustomProperties(style),
  };
}

function readElementEffectSnapshots(
  element: Element,
  ownerWindow: Window | null = element.ownerDocument.defaultView,
): BrowserElementEffectSnapshot[] {
  const win = ownerWindow ?? window;
  return (["element", "::before", "::after"] as const)
    .map((source) =>
      readEffectSnapshot(
        source === "element"
          ? win.getComputedStyle(element)
          : win.getComputedStyle(element, source),
        source,
      ),
    )
    .filter((effect): effect is BrowserElementEffectSnapshot => effect !== null)
    .slice(0, 6);
}

export function normalizeBrowserElementStylePatch(
  patch: BrowserElementStylePatch,
): BrowserElementStylePatch {
  const normalized: BrowserElementStylePatch = {};
  for (const key of BROWSER_STYLE_PATCH_KEYS) {
    const value = patch[key]?.trim();
    if (value) {
      normalized[key] = value;
    }
  }
  if (
    Object.keys(normalized).length > 0 &&
    (patch.effectTarget === "element" ||
      patch.effectTarget === "::before" ||
      patch.effectTarget === "::after")
  ) {
    normalized.effectTarget = patch.effectTarget;
  }
  return normalized;
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
  const rawText = readElementText(element);
  const rawOuterHTML = element.outerHTML;
  const text = truncateElementPayloadValue(rawText, MAX_ELEMENT_TEXT_PAYLOAD_LENGTH);
  const outerHTML = truncateElementPayloadValue(rawOuterHTML, MAX_ELEMENT_HTML_PAYLOAD_LENGTH);
  const payload = buildElementPayloadMetadata({ text: rawText, outerHTML: rawOuterHTML });
  const accessibleName =
    element.getAttribute("aria-label") ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    rawText;
  const style = readElementStyleSnapshot(element, ownerWindow ?? null);
  const effects = readElementEffectSnapshots(element, ownerWindow ?? null);

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
        ...(ownerWindow ? { devicePixelRatio: ownerWindow.devicePixelRatio } : {}),
      } satisfies BrowserViewport),
    outerHTML,
    payload,
    style,
    availableFonts: readAvailableFontOptions(ownerWindow ?? null, style.fontFamily),
    effects,
  };
}

export function readBrowserElementHoverContextFromDocumentAtPoint(input: {
  document: Document;
  point: BrowserDrawingPoint;
}): BrowserElementHoverContext | null {
  const ownerWindow = input.document.defaultView;
  const ElementCtor = ownerWindow?.Element ?? Element;
  const element = input.document.elementFromPoint(input.point.x, input.point.y);
  if (!element || !(element instanceof ElementCtor)) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    selector: selectorForElement(element),
    tagName: element.tagName,
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    viewport: {
      width: ownerWindow?.innerWidth ?? input.document.documentElement.clientWidth,
      height: ownerWindow?.innerHeight ?? input.document.documentElement.clientHeight,
      ...(ownerWindow ? { devicePixelRatio: ownerWindow.devicePixelRatio } : {}),
    },
  };
}

export function cdpElementHoverContextExpression(
  x: number,
  y: number,
  overlayGeometry?: { overlayWidth: number; overlayHeight: number },
): string {
  return `(() => {
    const rawX = ${JSON.stringify(x)};
    const rawY = ${JSON.stringify(y)};
    const overlayWidth = ${JSON.stringify(overlayGeometry?.overlayWidth ?? null)};
    const overlayHeight = ${JSON.stringify(overlayGeometry?.overlayHeight ?? null)};
    const viewportWidth = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || overlayWidth || 1;
    const viewportHeight = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || overlayHeight || 1;
    const x = overlayWidth && overlayWidth > 0 ? Math.max(0, Math.min(viewportWidth, rawX * viewportWidth / overlayWidth)) : rawX;
    const y = overlayHeight && overlayHeight > 0 ? Math.max(0, Math.min(viewportHeight, rawY * viewportHeight / overlayHeight)) : rawY;
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
    const rect = element.getBoundingClientRect();
    return {
      selector: selectorFor(element),
      tagName: element.tagName,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
    };
  })()`;
}

export function cdpElementContextExpression(
  x: number,
  y: number,
  overlayGeometry?: { overlayWidth: number; overlayHeight: number },
): string {
  return `(() => {
    const rawX = ${JSON.stringify(x)};
    const rawY = ${JSON.stringify(y)};
    const overlayWidth = ${JSON.stringify(overlayGeometry?.overlayWidth ?? null)};
    const overlayHeight = ${JSON.stringify(overlayGeometry?.overlayHeight ?? null)};
    const viewportWidth = (window.visualViewport && window.visualViewport.width) || window.innerWidth || document.documentElement.clientWidth || overlayWidth || 1;
    const viewportHeight = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || overlayHeight || 1;
    const x = overlayWidth && overlayWidth > 0 ? Math.max(0, Math.min(viewportWidth, rawX * viewportWidth / overlayWidth)) : rawX;
    const y = overlayHeight && overlayHeight > 0 ? Math.max(0, Math.min(viewportHeight, rawY * viewportHeight / overlayHeight)) : rawY;
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
    const maxTextPayloadLength = ${JSON.stringify(MAX_ELEMENT_TEXT_PAYLOAD_LENGTH)};
    const maxHtmlPayloadLength = ${JSON.stringify(MAX_ELEMENT_HTML_PAYLOAD_LENGTH)};
    const truncatePayloadValue = (value, limit) => {
      const nextValue = String(value || "");
      if (nextValue.length <= limit) return nextValue;
      const suffix = "\\n...[truncated; original length " + nextValue.length + " chars]";
      return nextValue.slice(0, Math.max(0, limit - suffix.length)).trimEnd() + suffix;
    };
    const fourPartStyleValue = (top, right, bottom, left) => {
      if (top === right && right === bottom && bottom === left) return top;
      if (top === bottom && right === left) return top + " " + right;
      return top + " " + right + " " + bottom + " " + left;
    };
    const unquoteFontFamily = (value) => {
      const trimmed = String(value || "").trim();
      return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
        ? trimmed.slice(1, -1).trim()
        : trimmed;
    };
    const quoteFontFamilyIfNeeded = (value) => {
      const trimmed = unquoteFontFamily(value);
      if (!trimmed) return "";
      if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|emoji|math|fangsong)$/i.test(trimmed)) {
        return trimmed;
      }
      return /[\\s"'(),]/.test(trimmed) ? JSON.stringify(trimmed) : trimmed;
    };
    const splitFontFamilyList = (value) => {
      const parts = [];
      let current = "";
      let quote = null;
      for (let index = 0; index < String(value || "").length; index += 1) {
        const char = value[index];
        if ((char === '"' || char === "'") && value[index - 1] !== "\\\\") {
          quote = quote === char ? null : quote || char;
          current += char;
          continue;
        }
        if (char === "," && !quote) {
          if (current.trim()) parts.push(current.trim());
          current = "";
          continue;
        }
        current += char;
      }
      if (current.trim()) parts.push(current.trim());
      return parts;
    };
    const fontLabel = (value) => unquoteFontFamily(splitFontFamilyList(value)[0] || value) || value;
    const fontKey = (value) => String(value || "").replace(/\\s+/g, " ").replace(/["']/g, "").trim().toLowerCase();
    const isFontFamilyLikeValue = (value) => {
      const trimmed = String(value || "").trim();
      if (!trimmed || /^(inherit|initial|revert|revert-layer|unset|none|normal|auto)$/i.test(trimmed) || /^-?(?:\\d|\\.\\d)/.test(trimmed) || /^(calc|clamp|min|max|rgb|rgba|hsl|hsla|color|var)\\(/i.test(trimmed)) {
        return false;
      }
      if (trimmed.includes(",")) return true;
      return /^[a-zA-Z_-][\\w\\s.-]*$/.test(unquoteFontFamily(trimmed));
    };
    const isLikelyFontFamilyProperty = (name) => {
      const lowerName = String(name || "").toLowerCase();
      if (lowerName === "font-family" || lowerName.includes("fontfamily")) return true;
      if (!lowerName.startsWith("--")) return false;
      return (lowerName.includes("font") || lowerName.includes("typeface")) && !/(size|weight|line|letter|tracking|spacing|style|smoothing|feature|variant|stretch|kerning)/.test(lowerName);
    };
    const systemFonts = ${JSON.stringify(BROWSER_SYSTEM_FONT_OPTIONS)};
    const fontCacheKey = [
      window.location.href,
      document.fonts && typeof document.fonts.size === "number" ? document.fonts.size : 0,
      document.styleSheets ? document.styleSheets.length : 0,
    ].join("\\u0000");
    const readPageFonts = () => {
      const cache = window.__synaraBrowserEditorFontCache;
      if (cache && cache.key === fontCacheKey && Array.isArray(cache.pageFonts)) {
        return cache.pageFonts;
      }
      const pageFonts = [];
      const addFontValue = (value, source, loaded) => {
        const trimmed = String(value || "").trim();
        if (!isFontFamilyLikeValue(trimmed)) return;
        const addFamily = (family) => {
          const normalized = quoteFontFamilyIfNeeded(family);
          if (normalized) {
            const option = { value: normalized, label: fontLabel(normalized), source };
            if (typeof loaded === "boolean") option.loaded = loaded;
            pageFonts.push(option);
          }
        };
        addFamily(trimmed);
        for (const family of splitFontFamilyList(trimmed)) addFamily(family);
      };
      const collectRuleFonts = (rules) => {
        for (const rule of Array.from(rules || [])) {
          if (typeof CSSFontFaceRule !== "undefined" && rule instanceof CSSFontFaceRule) {
            addFontValue(rule.style.getPropertyValue("font-family"), "page");
            continue;
          }
          if (typeof CSSStyleRule !== "undefined" && rule instanceof CSSStyleRule) {
            addFontValue(rule.style.getPropertyValue("font-family"), "page");
            for (const propertyName of Array.from(rule.style || [])) {
              if (isLikelyFontFamilyProperty(propertyName)) {
                addFontValue(rule.style.getPropertyValue(propertyName), "page");
              }
            }
            continue;
          }
          if (rule.cssRules) collectRuleFonts(rule.cssRules);
        }
      };
      try {
        for (const fontFace of Array.from(document.fonts || []).slice(0, 80)) {
          addFontValue(fontFace.family, "page", fontFace.status === "loaded");
        }
      } catch {}
      try {
        for (const sheet of Array.from(document.styleSheets || [])) {
          let rules = null;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          collectRuleFonts(rules);
        }
      } catch {}
      try {
        const sample = Array.from(document.querySelectorAll("body,h1,h2,h3,h4,h5,h6,p,a,button,input,textarea,label,nav,header,main,section,article,[class]")).slice(0, 160);
        for (const sampleElement of sample) {
          addFontValue(window.getComputedStyle(sampleElement).fontFamily, "page", true);
        }
      } catch {}
      window.__synaraBrowserEditorFontCache = { key: fontCacheKey, pageFonts };
      return pageFonts;
    };
    const collectFonts = (currentFontFamily) => {
      const seen = new Set();
      const fonts = [];
      const add = (option, fallbackSource) => {
        const value = String(option.value || "").trim();
        if (!value) return;
        const key = fontKey(value);
        if (seen.has(key)) return;
        seen.add(key);
        const next = {
          value,
          label: String(option.label || "").trim() || fontLabel(value),
          source: option.source || fallbackSource,
        };
        if (typeof option.loaded === "boolean") next.loaded = option.loaded;
        fonts.push(next);
      };
      if (currentFontFamily && String(currentFontFamily).trim()) {
        add({
          value: String(currentFontFamily).trim(),
          label: "Current: " + fontLabel(currentFontFamily),
          source: "current",
          loaded: true,
        }, "current");
      }
      for (const option of readPageFonts()) add(option, "page");
      for (const option of systemFonts) add(option, option.source);
      return fonts.slice(0, 80);
    };
    const effectCustomProperties = (style) => {
      const customProperties = {};
      for (const propertyName of Array.from(style || [])) {
        if (!String(propertyName).startsWith("--")) continue;
        const value = style.getPropertyValue(propertyName).trim();
        if (value) customProperties[propertyName] = value;
        if (Object.keys(customProperties).length >= 24) break;
      }
      return customProperties;
    };
    const effectFromStyle = (style, source) => {
      const backgroundImage = style.backgroundImage || "";
      const animationName = style.animationName || "";
      const hasGradient = /gradient\\(/i.test(backgroundImage);
      const hasAnimation = animationName.trim() !== "" && animationName !== "none";
      const hasFilter = Boolean(style.filter && style.filter !== "none");
      const hasTransform = Boolean(style.transform && style.transform !== "none");
      const hasVisualBackground =
        Boolean(backgroundImage && backgroundImage !== "none") ||
        Boolean(style.backgroundColor && !/rgba?\\(0,\\s*0,\\s*0(?:,\\s*0)?\\)/i.test(style.backgroundColor));
      if (!hasGradient && !hasAnimation && !hasFilter && !hasTransform && !hasVisualBackground) return null;
      const kind = hasGradient && hasAnimation ? "shimmer" : hasGradient ? "gradient" : hasAnimation ? "animation" : "visual";
      return {
        source,
        label: source === "element" ? "Element" : source,
        kind,
        backgroundImage,
        backgroundPosition: style.backgroundPosition,
        backgroundSize: style.backgroundSize,
        backgroundColor: style.backgroundColor,
        animationName,
        animationDuration: style.animationDuration,
        animationTimingFunction: style.animationTimingFunction,
        animationIterationCount: style.animationIterationCount,
        opacity: style.opacity,
        filter: style.filter,
        transform: style.transform,
        customProperties: effectCustomProperties(style),
      };
    };
    const computedStyle = window.getComputedStyle(element);
    const effects = [
      effectFromStyle(computedStyle, "element"),
      effectFromStyle(window.getComputedStyle(element, "::before"), "::before"),
      effectFromStyle(window.getComputedStyle(element, "::after"), "::after"),
    ].filter(Boolean).slice(0, 6);
    const rect = element.getBoundingClientRect();
    const rawText = "innerText" in element ? element.innerText : element.textContent;
    const text = truncatePayloadValue(rawText, maxTextPayloadLength);
    const rawOuterHTML = element.outerHTML;
    const outerHTML = truncatePayloadValue(rawOuterHTML, maxHtmlPayloadLength);
    const accessibleName =
      element.getAttribute("aria-label") ||
      element.getAttribute("alt") ||
      element.getAttribute("title") ||
      (typeof rawText === "string" ? rawText : "");
    return {
      url: window.location.href,
      title: document.title,
      selector: selectorFor(element),
      tagName: element.tagName,
      role: element.getAttribute("role"),
      accessibleName,
      text,
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
      outerHTML,
      payload: {
        textLength: typeof rawText === "string" ? rawText.length : 0,
        textTruncated: typeof rawText === "string" && rawText.length > maxTextPayloadLength,
        outerHTMLLength: rawOuterHTML.length,
        outerHTMLTruncated: rawOuterHTML.length > maxHtmlPayloadLength,
      },
      style: {
        color: computedStyle.color,
        backgroundColor: computedStyle.backgroundColor,
        backgroundImage: computedStyle.backgroundImage,
        backgroundPosition: computedStyle.backgroundPosition,
        backgroundSize: computedStyle.backgroundSize,
        fontFamily: computedStyle.fontFamily,
        fontSize: computedStyle.fontSize,
        fontWeight: computedStyle.fontWeight,
        fontStyle: computedStyle.fontStyle,
        lineHeight: computedStyle.lineHeight,
        letterSpacing: computedStyle.letterSpacing,
        textAlign: computedStyle.textAlign,
        opacity: computedStyle.opacity,
        display: computedStyle.display,
        padding: fourPartStyleValue(computedStyle.paddingTop, computedStyle.paddingRight, computedStyle.paddingBottom, computedStyle.paddingLeft),
        margin: fourPartStyleValue(computedStyle.marginTop, computedStyle.marginRight, computedStyle.marginBottom, computedStyle.marginLeft),
        borderWidth: fourPartStyleValue(computedStyle.borderTopWidth, computedStyle.borderRightWidth, computedStyle.borderBottomWidth, computedStyle.borderLeftWidth),
        borderColor: fourPartStyleValue(computedStyle.borderTopColor, computedStyle.borderRightColor, computedStyle.borderBottomColor, computedStyle.borderLeftColor),
        borderRadius: fourPartStyleValue(computedStyle.borderTopLeftRadius, computedStyle.borderTopRightRadius, computedStyle.borderBottomRightRadius, computedStyle.borderBottomLeftRadius),
        boxShadow: computedStyle.boxShadow,
        filter: computedStyle.filter,
        animationName: computedStyle.animationName,
        animationDuration: computedStyle.animationDuration,
        animationTimingFunction: computedStyle.animationTimingFunction,
        animationIterationCount: computedStyle.animationIterationCount,
      },
      availableFonts: collectFonts(computedStyle.fontFamily),
      effects,
    };
  })()`;
}

export function isBrowserElementHoverContext(value: unknown): value is BrowserElementHoverContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BrowserElementHoverContext>;
  return (
    typeof candidate.selector === "string" &&
    typeof candidate.tagName === "string" &&
    typeof candidate.rect === "object" &&
    candidate.rect !== null &&
    typeof candidate.rect.x === "number" &&
    typeof candidate.rect.y === "number" &&
    typeof candidate.rect.width === "number" &&
    typeof candidate.rect.height === "number"
  );
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
  const normalized = sanitizeBrowserEditorBlockText(value).replace(/\s+/g, " ").trim();
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

function formatStrokeSummary(stroke: BrowserDrawingStroke): string {
  const { points } = stroke;
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
  const summary = [
    `start: ${formatPoint(start)}`,
    `end: ${formatPoint(end)}`,
    `bounds: x=${Math.round(bounds.minX)}, y=${Math.round(bounds.minY)}, width=${Math.round(bounds.maxX - bounds.minX)}, height=${Math.round(bounds.maxY - bounds.minY)}`,
    `pointCount: ${points.length}`,
  ];
  if (typeof stroke.strokeSize === "number") {
    summary.push(`strokeSize: ${Number(stroke.strokeSize.toFixed(2))}px`);
  }
  if (stroke.animated === false) {
    summary.push("animated: false");
  }
  return summary.join("; ");
}

function formatTextAnnotation(annotation: BrowserTextAnnotation): string {
  const text = truncateText(annotation.text, MAX_TEXT_LENGTH);
  const boxPosition =
    typeof annotation.boxX === "number" && typeof annotation.boxY === "number"
      ? `, box: x=${Math.round(annotation.boxX)}, y=${Math.round(annotation.boxY)}`
      : "";
  const fontSize =
    typeof annotation.fontSize === "number"
      ? `, fontSize: ${Math.round(annotation.fontSize)}px`
      : "";
  return `x=${Math.round(annotation.x)}, y=${Math.round(annotation.y)}${boxPosition}${fontSize}, text: ${text || "(empty)"}`;
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
  return (
    [
      `from: ${formatPoint(arrow.from)}`,
      `to: ${formatPoint(arrow.to)}`,
      `bounds: x=${Math.round(minX)}, y=${Math.round(minY)}, width=${Math.round(maxX - minX)}, height=${Math.round(maxY - minY)}`,
    ].join("; ") +
    source +
    handle
  );
}

function formatStyleEntries(
  value: BrowserElementStyleSnapshot | BrowserElementStylePatch | null | undefined,
): string {
  if (!value) {
    return "none";
  }
  const entries = BROWSER_STYLE_PATCH_KEYS.flatMap((key) => {
    const styleValue = value[key]?.trim();
    return styleValue ? [`- ${key}: ${styleValue}`] : [];
  });
  return entries.length > 0 ? entries.join("\n") : "none";
}

function formatFontOptions(value: readonly BrowserElementFontOption[] | null | undefined): string {
  if (!value || value.length === 0) {
    return "none";
  }
  return value
    .slice(0, 24)
    .map((option) => {
      const loaded =
        typeof option.loaded === "boolean" ? `, loaded=${option.loaded ? "yes" : "no"}` : "";
      return `- ${option.value} (${option.source}${loaded})`;
    })
    .join("\n");
}

function formatEffectEntries(
  value: readonly BrowserElementEffectSnapshot[] | null | undefined,
): string {
  if (!value || value.length === 0) {
    return "none";
  }
  return value
    .slice(0, 6)
    .map((effect) =>
      [
        `- ${effect.kind} (${effect.source})`,
        `  animationName: ${effect.animationName || "none"}`,
        `  animationDuration: ${effect.animationDuration || "none"}`,
        `  animationTimingFunction: ${effect.animationTimingFunction || "none"}`,
        `  animationIterationCount: ${effect.animationIterationCount || "none"}`,
        `  backgroundImage: ${truncateText(effect.backgroundImage || "none", 500)}`,
        `  backgroundSize: ${effect.backgroundSize || "none"}`,
        `  backgroundPosition: ${effect.backgroundPosition || "none"}`,
        `  opacity: ${effect.opacity || "none"}`,
        `  filter: ${effect.filter || "none"}`,
      ].join("\n"),
    )
    .join("\n");
}

function formatRequestedFont(
  element: BrowserElementEditorContext,
  previewStyle: BrowserElementStylePatch,
): string {
  const requestedFont = previewStyle.fontFamily?.trim();
  if (!requestedFont) {
    return "none";
  }
  const requestedKey = fontOptionKey(requestedFont);
  const match = element.availableFonts?.find(
    (option) => fontOptionKey(option.value) === requestedKey,
  );
  if (!match) {
    return `value: ${requestedFont}\nsource: custom\nloaded: unknown`;
  }
  return [
    `value: ${match.value}`,
    `source: ${match.source}`,
    `loaded: ${match.loaded === true ? "yes" : match.loaded === false ? "no" : "unknown"}`,
  ].join("\n");
}

function indentLines(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatPayloadMetadata(context: BrowserElementEditorContext, prefix = ""): string[] {
  const payload = context.payload;
  if (!payload || (!payload.textTruncated && !payload.outerHTMLTruncated)) {
    return [];
  }
  return [
    `${prefix}payload:`,
    `${prefix}  textLength: ${payload.textLength}`,
    `${prefix}  textTruncated: ${payload.textTruncated ? "yes" : "no"}`,
    `${prefix}  outerHTMLLength: ${payload.outerHTMLLength}`,
    `${prefix}  outerHTMLTruncated: ${payload.outerHTMLTruncated ? "yes" : "no"}`,
  ];
}

function formatSelectedElement(context: BrowserElementEditorContext): string[] {
  return [
    "selectedElement:",
    `  selector: ${context.selector || "(unavailable)"}`,
    `  tag: ${context.tagName.toLowerCase()}`,
    `  role: ${context.role ?? "(none)"}`,
    `  accessibleName: ${context.accessibleName ?? "(none)"}`,
    `  bounds: ${formatRect(context.rect)}`,
    ...formatPayloadMetadata(context, "  "),
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
  const firstLine =
    block.match(/^<browser-(element|drawing|selection|style-edit|live-editor)-selection>/)?.[1] ??
    null;
  if (
    firstLine !== "element" &&
    firstLine !== "drawing" &&
    firstLine !== "selection" &&
    firstLine !== "style-edit" &&
    firstLine !== "live-editor"
  ) {
    return null;
  }

  const title = readPromptBlockField(block, "title");
  const url = readPromptBlockField(block, "url");
  if (firstLine === "live-editor") {
    const selector = readPromptBlockField(block, "selectedSelector");
    const sections = readPromptBlockField(block, "sectionCount");
    const kind: BrowserEditorPromptContextKind = block.includes("<browser-drawing-selection>")
      ? "drawing"
      : block.includes("<browser-style-edit-selection>")
        ? "style-edit"
        : "selection";
    return {
      kind,
      block,
      title,
      url,
      label: "Live Editor Context",
      detail: compactPromptBlockText(
        [
          sections && sections !== "0"
            ? `${sections} context section${sections === "1" ? "" : "s"}`
            : "",
          selector && selector !== "(none)" ? selector : "",
        ]
          .filter(Boolean)
          .join(" · ") ||
          title ||
          url ||
          "Live editor context",
      ),
    };
  }
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
  if (firstLine === "style-edit") {
    const selector = readPromptBlockField(block, "selectedSelector");
    const changed = readPromptBlockField(block, "changedProperties");
    return {
      kind: "style-edit",
      block,
      title,
      url,
      label: "Live Editor Context: style edit",
      detail: compactPromptBlockText(
        [
          changed && changed !== "0" ? `${changed} style change${changed === "1" ? "" : "s"}` : "",
          selector,
        ]
          .filter(Boolean)
          .join(" · ") ||
          title ||
          url ||
          "Style edit context",
      ),
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
    label:
      details.length > 0 ? `Live Editor Context: ${details.join(", ")}` : "Live Editor Context",
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

export function buildUnifiedBrowserEditorPromptBlock(
  blocks: ReadonlyArray<string | null | undefined>,
): string | null {
  const uniqueBlocks: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const trimmed = block?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    uniqueBlocks.push(trimmed);
  }
  if (uniqueBlocks.length === 0) {
    return null;
  }
  const title =
    uniqueBlocks.map((block) => readPromptBlockField(block, "title")).find(Boolean) ?? "(untitled)";
  const url = uniqueBlocks.map((block) => readPromptBlockField(block, "url")).find(Boolean) ?? "";
  const selectedSelector =
    uniqueBlocks
      .map((block) => readPromptBlockField(block, "selectedSelector"))
      .find((selector) => selector && selector !== "(none)") ?? "(none)";
  return [
    "<browser-live-editor-selection>",
    "source: live-editor-context",
    ...(url ? [`url: ${url}`] : []),
    `title: ${sanitizeBrowserEditorBlockText(title)}`,
    `selectedSelector: ${selectedSelector}`,
    `sectionCount: ${uniqueBlocks.length}`,
    "sections:",
    ...uniqueBlocks.flatMap((block, index) => [`--- section ${index + 1} ---`, block]),
    "</browser-live-editor-selection>",
  ].join("\n");
}

function normalizePromptBlockSpacing(prompt: string): string {
  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}

function isBrowserAnnotationPromptBlock(block: string): boolean {
  return (
    (block.startsWith("<browser-drawing-selection>") &&
      /^source:\s*browser-annotation$/m.test(block)) ||
    (block.startsWith("<browser-live-editor-selection>") &&
      /^source:\s*live-editor-context$/m.test(block))
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

export function buildBrowserSelectionPromptBlock(context: BrowserElementEditorContext): string {
  return [
    "<browser-selection-selection>",
    "source: browser-selection",
    `url: ${context.url}`,
    `title: ${sanitizeBrowserEditorBlockText(context.title) || "(untitled)"}`,
    `selectedSelector: ${context.selector || "(unavailable)"}`,
    `tag: ${context.tagName.toLowerCase()}`,
    `role: ${context.role ?? "(none)"}`,
    `accessibleName: ${context.accessibleName ?? "(none)"}`,
    `viewport: ${formatViewport(context.viewport)}`,
    `bounds: ${formatRect(context.rect)}`,
    ...formatPayloadMetadata(context),
    "attributes:",
    formatAttributes(context.attributes),
    `text: ${truncateText(context.text, MAX_TEXT_LENGTH) || "(empty)"}`,
    "outerHTML:",
    truncateText(context.outerHTML, MAX_HTML_LENGTH) || "(empty)",
    "</browser-selection-selection>",
  ].join("\n");
}

export function buildBrowserStyleEditPromptBlock(context: BrowserStyleEditContext): string {
  const previewStyle = normalizeBrowserElementStylePatch(context.previewStyle);
  return [
    "<browser-style-edit-selection>",
    "source: browser-style-edit",
    `url: ${context.element.url}`,
    `title: ${sanitizeBrowserEditorBlockText(context.element.title) || "(untitled)"}`,
    `selectedSelector: ${context.element.selector || "(unavailable)"}`,
    `tag: ${context.element.tagName.toLowerCase()}`,
    `role: ${context.element.role ?? "(none)"}`,
    `accessibleName: ${context.element.accessibleName ?? "(none)"}`,
    `viewport: ${formatViewport(context.element.viewport)}`,
    `bounds: ${formatRect(context.element.rect)}`,
    ...formatPayloadMetadata(context.element),
    `manualOverride: ${context.manualOverride ? "enabled" : "disabled"}`,
    `changedProperties: ${Object.keys(previewStyle).length}`,
    "stylingNote:",
    `  ${BROWSER_STYLE_EDIT_STYLING_NOTE}`,
    "currentComputedStyle:",
    indentLines(formatStyleEntries(context.currentStyle ?? context.element.style), "  "),
    "detectedEffects:",
    indentLines(formatEffectEntries(context.element.effects), "  "),
    "requestedFont:",
    indentLines(formatRequestedFont(context.element, previewStyle), "  "),
    "availableFontOptions:",
    indentLines(formatFontOptions(context.element.availableFonts), "  "),
    "previewStyleRequest:",
    indentLines(formatStyleEntries(previewStyle), "  "),
    "attributes:",
    formatAttributes(context.element.attributes),
    `text: ${truncateText(context.element.text, MAX_TEXT_LENGTH) || "(empty)"}`,
    "outerHTML:",
    truncateText(context.element.outerHTML, MAX_HTML_LENGTH) || "(empty)",
    "</browser-style-edit-selection>",
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
    `title: ${sanitizeBrowserEditorBlockText(context.title) || "(untitled)"}`,
    `viewport: ${formatViewport(context.viewport)}`,
    ...(context.document ? [`document: ${formatDocumentSize(context.document)}`] : []),
    ...(context.scroll ? [`scroll: ${formatScrollPosition(context.scroll)}`] : []),
    ...(context.capture ? [`capture: ${formatRect(context.capture)}`] : []),
    ...(selectedSelector
      ? [`selectedSelector: ${selectedSelector}`]
      : ["selectedSelector: (none)"]),
    ...(selectedElement ? formatSelectedElement(selectedElement) : ["selectedElement: (none)"]),
    `strokeCount: ${context.strokes.length}`,
    "strokes:",
    ...context.strokes.map(
      (stroke, index) => `- stroke ${index + 1}: ${formatStrokeSummary(stroke)}`,
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
