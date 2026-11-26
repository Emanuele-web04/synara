import { compile, type Options } from "css-select";
import { parse as parseSelector, type Selector } from "css-what";
import postcss, { type AtRule, type ChildNode, type Declaration, type Rule } from "postcss";
import type { DesignLayerTree } from "@synara/contracts";

/**
 * Storage keeps one inline style per element. Agent stylesheets are resolved
 * once, on import, into those inline declarations. Rules that only make sense in a live
 * browser (hover, focus, pseudo-elements, unknown media) are dropped and reported back.
 */

type ElementNode = {
  kind: "element";
  tag: string;
  attributes: Record<string, string>;
  children: LayerNode[];
  parent: ElementNode | DocumentNode;
  id: string | null;
};
type TextNode = { kind: "text"; text: string; parent: ElementNode };
type DocumentNode = { kind: "document"; children: ElementNode[] };
type LayerNode = ElementNode | TextNode;
type AnyNode = LayerNode | DocumentNode;

type CascadedDeclaration = {
  property: string;
  value: string;
  important: boolean;
  specificity: number;
  order: number;
};

const MAX_REPORTED = 30;
const DYNAMIC_PSEUDOS = new Set([
  "hover",
  "focus",
  "focus-within",
  "focus-visible",
  "active",
  "visited",
  "link",
  "any-link",
  "target",
  "target-within",
  "placeholder-shown",
  "autofill",
  "valid",
  "invalid",
  "user-valid",
  "user-invalid",
  "in-range",
  "out-of-range",
  "playing",
  "paused",
  "fullscreen",
  "modal",
  "popover-open",
  "open",
  "closed",
  "defined",
  "host",
  "host-context",
  "state",
]);
// `app-region` turns an area into an Electron window-drag handle that swallows pointer input.
const BLOCKED_PROPERTIES = new Set([
  "behavior",
  "-moz-binding",
  "app-region",
  "-webkit-app-region",
]);
const UNSAFE_VALUE = /(?:image-set|attr|element|expression|paint|cross-fade)\s*\(/i;
const URL_PATTERN = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
const ALLOWED_URL =
  /^(?:synara-asset:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}|data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+)$/;

const adapter: NonNullable<Options<AnyNode, ElementNode>["adapter"]> = {
  isTag: (node): node is ElementNode => node.kind === "element",
  getAttributeValue: (element, name) => element.attributes[name],
  getChildren: (node) => (node.kind === "text" ? [] : node.children),
  getName: (element) => element.tag,
  getParent: (node) => node.parent,
  getSiblings: (node) => (node.kind === "document" ? [node] : node.parent.children),
  getText: (node) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "document") return "";
    return node.children.map((child) => adapter.getText(child)).join("");
  },
  hasAttrib: (element, name) => Object.hasOwn(element.attributes, name),
  removeSubsets: (nodes) =>
    nodes.filter((node) => {
      for (
        let parent = node.kind === "document" ? null : node.parent;
        parent && parent.kind === "element";
        parent = parent.parent
      )
        if (nodes.includes(parent)) return false;
      return true;
    }),
};

function specificityOf(selector: readonly Selector[]): number {
  let ids = 0,
    classes = 0,
    types = 0;
  const nested = (data: unknown) =>
    Array.isArray(data)
      ? Math.max(0, ...(data as Selector[][]).map((part) => specificityOf(part)))
      : 0;
  for (const token of selector) {
    if (token.type === "attribute") {
      if (token.name === "id" && token.action === "equals" && token.ignoreCase === "quirks") ids++;
      else classes++;
    } else if (token.type === "tag" || token.type === "pseudo-element") types++;
    else if (token.type === "pseudo") {
      if (token.name === "where") continue;
      if (["not", "is", "matches", "has", "any"].includes(token.name)) {
        const value = nested(token.data);
        ids += Math.floor(value / 1_000_000);
        classes += Math.floor(value / 1000) % 1000;
        types += value % 1000;
      } else classes++;
    }
  }
  return ids * 1_000_000 + classes * 1000 + types;
}

function unsupportedReason(selector: readonly Selector[]): string | null {
  for (const token of selector) {
    if (token.type === "pseudo-element") return "pseudo-elements are not layers";
    if (token.type === "column-combinator") return "unsupported combinator";
    if (token.type === "pseudo") {
      if (DYNAMIC_PSEUDOS.has(token.name))
        return "interactive states do not exist on a static frame";
      if (Array.isArray(token.data))
        for (const part of token.data as Selector[][]) {
          const reason = unsupportedReason(part);
          if (reason) return reason;
        }
    }
  }
  return null;
}

/** Media queries are evaluated against the frame, which has a fixed width and height. */
function evaluateMedia(params: string, width: number, height: number): boolean | null {
  const length = (value: string) => {
    const match = /^(-?\d*\.?\d+)(px|em|rem)?$/.exec(value.trim());
    if (!match) return null;
    return Number(match[1]) * (match[2] === "em" || match[2] === "rem" ? 16 : 1);
  };
  const feature = (source: string): boolean | null => {
    const [rawName, rawValue] = source.split(":").map((part) => part.trim().toLowerCase());
    const name = rawName ?? "";
    const value = rawValue ?? "";
    if (rawValue === undefined) return ["color", "hover", "pointer"].includes(name) ? true : null;
    if (name === "min-width" || name === "max-width" || name === "width") {
      const target = length(value);
      if (target === null) return null;
      return name === "min-width"
        ? width >= target
        : name === "max-width"
          ? width <= target
          : width === target;
    }
    if (name === "min-height" || name === "max-height") {
      const target = length(value);
      if (target === null) return null;
      return name === "min-height" ? height >= target : height <= target;
    }
    if (name === "orientation") return value === (width > height ? "landscape" : "portrait");
    if (name === "prefers-color-scheme") return value === "light";
    if (name === "prefers-reduced-motion") return value === "no-preference";
    if (name === "hover") return value === "hover";
    if (name === "pointer") return value === "fine";
    return null;
  };
  let any = false;
  for (const query of params.split(",")) {
    let text = query.trim().toLowerCase();
    let negate = false;
    if (text.startsWith("not ")) {
      negate = true;
      text = text.slice(4);
    }
    text = text.replace(/^only\s+/, "");
    let result = true;
    for (const part of text.split(/\s+and\s+/)) {
      const trimmed = part.trim();
      let value: boolean | null;
      if (trimmed.startsWith("(") && trimmed.endsWith(")")) value = feature(trimmed.slice(1, -1));
      else if (trimmed === "all" || trimmed === "screen") value = true;
      else if (trimmed === "print" || trimmed === "speech") value = false;
      else value = null;
      if (value === null) return null;
      result &&= value;
    }
    any ||= negate ? !result : result;
  }
  return any;
}

export function parseDeclarations(source: string): Declaration[] {
  if (!source.trim()) return [];
  const root = postcss.parse(`a{${source}}`);
  const rule = root.first;
  if (root.nodes.length !== 1 || rule?.type !== "rule") throw new Error("Invalid inline CSS.");
  return rule.nodes.filter((node): node is Declaration => node.type === "decl");
}

/** Values are kept faithful except where a host-rendered frame would reach outside itself. */
export function sanitizeDeclarationValue(
  property: string,
  value: string,
  remBase = 16,
): { value: string } | { reason: string } {
  const key = property.startsWith("--") ? property : property.toLowerCase();
  if (BLOCKED_PROPERTIES.has(key)) return { reason: `${property} is not supported` };
  if (UNSAFE_VALUE.test(value)) return { reason: `${property} uses an unsupported CSS function` };
  for (const match of value.matchAll(URL_PATTERN))
    if (!ALLOWED_URL.test(match[2]!.trim()))
      return {
        reason: `${property} loads an external resource; import it with synara_import_canvas_asset`,
      };
  // rem would follow Synara's own root font size once frames render in the host document.
  // Quoted strings (content, font names) are left as written.
  const converted = value
    .split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            /(-?\d*\.?\d+)rem\b/g,
            (_, amount: string) => `${Number((Number(amount) * remBase).toFixed(3))}px`,
          ),
    )
    .join("");
  return { value: converted };
}

function serialize(declarations: readonly CascadedDeclaration[]): string {
  return declarations
    .map(
      ({ property, value, important }) => `${property}:${value}${important ? " !important" : ""}`,
    )
    .join(";");
}

/** rem follows the root element's font-size, which html or :root rules may change. */
function rootFontSize(nodes: readonly ChildNode[], width: number, height: number): number | null {
  let size: number | null = null;
  for (const node of nodes) {
    if (node.type === "atrule") {
      const name = node.name.toLowerCase();
      if (name === "media" && evaluateMedia(node.params, width, height) !== true) continue;
      if (name !== "media" && name !== "supports" && name !== "layer") continue;
      size = rootFontSize(node.nodes ?? [], width, height) ?? size;
      continue;
    }
    if (node.type !== "rule") continue;
    if (!node.selectors.some((selector) => /^(?:html|:root)$/i.test(selector.trim()))) continue;
    for (const declaration of node.nodes)
      if (declaration.type === "decl" && declaration.prop.toLowerCase() === "font-size") {
        const match = /^([\d.]+)(px|%)$/.exec(declaration.value.trim());
        if (match) size = Number(match[1]) * (match[2] === "%" ? 0.16 : 1) || size;
      }
  }
  return size;
}

export type InlinedDesign = {
  layers: DesignLayerTree;
  /** Declarations matched by html, body and :root, applied to the frame itself. */
  frameDeclarations: string;
  dropped: string[];
};

/**
 * Resolve the cascade for the given forest. Normal inline declarations beat stylesheet rules,
 * important rules beat normal inline declarations, and important inline declarations win.
 */
export function inlineDesignStyles(input: {
  layers: DesignLayerTree;
  css: string;
  width: number;
  height: number;
  /**
   * The tag the HTML used for layers stored under a neutral tag (`time` stored as `span`):
   * selectors match that tag, as they would in the HTML the design was written in.
   */
  sourceTags?: ReadonlyMap<string, string>;
}): InlinedDesign {
  const dropped: string[] = [];
  const report = (message: string) => {
    if (!dropped.includes(message) && dropped.length < MAX_REPORTED) dropped.push(message);
  };
  const nodes = new Map(input.layers.nodes.map((node) => [node.id, node]));
  const document: DocumentNode = { kind: "document", children: [] };
  const html: ElementNode = {
    kind: "element",
    tag: "html",
    attributes: {},
    children: [],
    parent: document,
    id: null,
  };
  const body: ElementNode = {
    kind: "element",
    tag: "body",
    attributes: {},
    children: [],
    parent: html,
    id: null,
  };
  document.children.push(html);
  html.children.push(body);
  const elements: ElementNode[] = [html, body];
  const byId = new Map<string, ElementNode>();
  const build = (id: string, parent: ElementNode): LayerNode => {
    const layer = nodes.get(id)!;
    if (layer.type === "text") return { kind: "text", text: layer.text, parent };
    const element: ElementNode = {
      kind: "element",
      tag: input.sourceTags?.get(layer.id) ?? layer.tag,
      attributes: layer.attributes,
      children: [],
      parent,
      id: layer.id,
    };
    elements.push(element);
    byId.set(layer.id, element);
    element.children = layer.children.map((child) => build(child, element));
    return element;
  };
  body.children = input.layers.roots.map((id) => build(id, body)) as ElementNode[];

  const matched = new Map<ElementNode, CascadedDeclaration[]>();
  let order = 0;
  let remBase = 16;

  const applyRule = (rule: Rule) => {
    const declarations = rule.nodes.filter((node): node is Declaration => node.type === "decl");
    for (const selectorText of rule.selectors) {
      let parsed: Selector[][];
      try {
        parsed = parseSelector(selectorText);
      } catch {
        report(`Dropped "${selectorText}": invalid selector`);
        continue;
      }
      for (const selector of parsed) {
        const reason = unsupportedReason(selector);
        if (reason) {
          report(
            `Dropped "${selectorText}": ${reason}; express it as real layers or inline styles`,
          );
          continue;
        }
        let test: (node: AnyNode) => boolean;
        try {
          test = compile<AnyNode, ElementNode>([selector], { adapter });
        } catch {
          report(`Dropped "${selectorText}": unsupported selector`);
          continue;
        }
        const specificity = specificityOf(selector);
        for (const element of elements) {
          if (!test(element)) continue;
          const list = matched.get(element) ?? [];
          matched.set(element, list);
          for (const declaration of declarations) {
            const safe = sanitizeDeclarationValue(declaration.prop, declaration.value, remBase);
            if ("reason" in safe) {
              report(`Dropped ${declaration.prop} in "${selectorText}": ${safe.reason}`);
              continue;
            }
            list.push({
              property: declaration.prop,
              value: safe.value,
              important: declaration.important,
              specificity,
              order: order++,
            });
          }
        }
      }
    }
  };
  const visit = (children: readonly ChildNode[]) => {
    for (const node of children) {
      if (node.type === "rule") applyRule(node);
      else if (node.type === "atrule") {
        const at = node as AtRule;
        const name = at.name.toLowerCase();
        if (name === "media") {
          const result = evaluateMedia(at.params, input.width, input.height);
          if (result === null)
            report(`Dropped @media ${at.params}: cannot be evaluated for a fixed frame`);
          else if (result) visit(at.nodes ?? []);
        } else if (name === "supports" || name === "layer") visit(at.nodes ?? []);
        else if (name === "font-face")
          report("Dropped @font-face: use synara_add_canvas_font or synara_import_canvas_asset");
        else if (name === "import")
          report("Dropped @import: frames cannot load external stylesheets");
        else if (name === "keyframes" || name.endsWith("keyframes"))
          report(`Dropped @${at.name}: frames are static`);
        else if (name !== "charset") report(`Dropped @${at.name}: not supported in static frames`);
      }
    }
  };
  if (input.css.trim()) {
    let sheet: postcss.Root;
    try {
      sheet = postcss.parse(input.css);
    } catch (error) {
      throw new Error(`Invalid CSS: ${error instanceof Error ? error.message : String(error)}`);
    }
    remBase = rootFontSize(sheet.nodes, input.width, input.height) ?? 16;
    visit(sheet.nodes);
  }

  const cascade = (element: ElementNode, inline: string) => {
    const fromRules = (matched.get(element) ?? []).toSorted(
      (a, b) => a.specificity - b.specificity || a.order - b.order,
    );
    const own: CascadedDeclaration[] = [];
    for (const declaration of parseDeclarations(inline)) {
      const safe = sanitizeDeclarationValue(declaration.prop, declaration.value, remBase);
      if ("reason" in safe) {
        report(`Dropped inline ${declaration.prop}: ${safe.reason}`);
        continue;
      }
      own.push({
        property: declaration.prop,
        value: safe.value,
        important: declaration.important,
        specificity: Number.MAX_SAFE_INTEGER,
        order: order++,
      });
    }
    const ordered = [
      ...fromRules.filter((item) => !item.important),
      ...own.filter((item) => !item.important),
      ...fromRules.filter((item) => item.important),
      ...own.filter((item) => item.important),
    ];
    // Later declarations of the same property win; keep only the effective one.
    const last = new Map<string, CascadedDeclaration>();
    for (const item of ordered) {
      const key = item.property.startsWith("--") ? item.property : item.property.toLowerCase();
      last.delete(key);
      last.set(key, item);
    }
    return serialize([...last.values()]);
  };

  const layers: DesignLayerTree = {
    roots: input.layers.roots,
    nodes: input.layers.nodes.map((layer) => {
      if (layer.type === "text") return layer;
      const element = byId.get(layer.id)!;
      const style = cascade(element, layer.attributes.style ?? "");
      const { style: _previous, ...attributes } = layer.attributes;
      return { ...layer, attributes: style ? { ...attributes, style } : attributes };
    }),
  };
  const frameDeclarations = [cascade(html, ""), cascade(body, "")].filter(Boolean).join(";");
  return { layers, frameDeclarations, dropped };
}
