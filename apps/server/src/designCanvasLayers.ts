import { randomUUID } from "node:crypto";
import {
  defaultTreeAdapter,
  html as htmlNamespaces,
  parseFragment,
  type DefaultTreeAdapterTypes,
} from "parse5";
import postcss from "postcss";
import {
  DESIGN_CANVAS_MAX_DEPTH,
  DESIGN_CANVAS_MAX_LAYERS,
  DESIGN_CANVAS_MAX_SVG_LAYERS,
  type DesignLayer,
  type DesignLayerAppliedEdit,
  type DesignLayerDuplicate,
  type DesignLayerEdit,
  type DesignLayerTree,
} from "@synara/contracts";
import {
  DESIGN_HTML_TAGS,
  DESIGN_LAYER_ATTRIBUTE,
  DESIGN_VOID_TAGS,
  declaredStyles,
  isDesignAttributeAllowed,
  serializeDesignLayers,
  validateDesignLayers,
} from "@synara/shared/designCanvasLayers";
import {
  DESIGN_SVG_TAGS,
  DESIGN_SVG_TEXT_TAGS,
  designSvgAttributeProblem,
} from "@synara/shared/designCanvasSvg";
import { designTextBlockKind } from "@synara/shared/designCanvasText";
import {
  inlineDesignStyles,
  parseDeclarations,
  sanitizeDeclarationValue,
} from "./designCanvasInline";

/**
 * A part of an inline SVG the import left out for safety: what it was (`<script>`, `onclick on
 * <path>`) and why. Agent imports list it under `dropped`; editor imports refuse instead.
 */
export type RejectedSvgPart = (part: { what: string; reason: string }) => void;

/** Editor imports are strict: an SVG part the subset refuses refuses the whole import. */
export const refuseSvgPart: RejectedSvgPart = ({ what, reason }) => {
  throw new Error(`Unsupported SVG: ${what} (${reason}).`);
};

/** Adds one line to an agent's `dropped` list: each line once, at most 100 lines. */
export const reportTo =
  (dropped: string[]) =>
  (message: string): void => {
    if (!dropped.includes(message) && dropped.length < 100) dropped.push(message);
  };

/** The agent rule: the part is left out and named under `dropped`, never stored. */
export const reportSvgPart =
  (dropped: string[]): RejectedSvgPart =>
  ({ what, reason }) =>
    reportTo(dropped)(`Dropped ${what} in an SVG: ${reason}`);

/**
 * HTML tags that are removed with everything inside them: they run, load or embed something,
 * or are document metadata or hidden fallback content that a static frame never shows.
 */
const REMOVED_HTML_TAGS: Readonly<Record<string, string>> = (() => {
  const groups: Array<[reason: string, tags: string]> = [
    ["scripts never run on the canvas", "script noscript template"],
    [
      "embedded documents never load on the canvas",
      "iframe frame frameset object embed applet param portal fencedframe",
    ],
    ["document metadata is not part of a frame", "head title meta link base basefont bgsound"],
    ["media sources never load on the canvas", "source track"],
    ["image maps are not supported", "map area"],
    ["it is never shown", "datalist noembed noframes"],
    ["it draws nothing", "wbr keygen"],
  ];
  return Object.fromEntries(
    groups.flatMap(([reason, tags]) => tags.split(" ").map((tag) => [tag, reason])),
  );
})();

/**
 * HTML tags Synara has no layer for that render inertly as a neutral tag, so their content is
 * kept: phrasing tags as `span`, lists as `ul`, raw-text blocks as `pre`, anything else
 * (forms, fieldsets, dialogs, custom elements) as `div`.
 */
const MAPPED_HTML_TAGS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    "abbr acronym bdi bdo big blink cite data del dfn font ins kbd nobr output picture q rp rt ruby samp slot strike time tt var"
      .split(" ")
      .map((tag) => [tag, "span"]),
  ),
  menu: "ul",
  dir: "ul",
  xmp: "pre",
  listing: "pre",
  plaintext: "pre",
};

/**
 * The look of a mapped tag that its neutral tag lacks, as a stylesheet matched against the tag
 * the HTML used. It comes before the design's own rules, so anything the design says wins.
 */
export const DESIGN_MAPPED_TAG_CSS = [
  "kbd,samp,tt{font-family:monospace}",
  "cite,dfn,var,address{font-style:italic}",
  "del,strike{text-decoration-line:line-through}",
  "ins{text-decoration-line:underline}",
  "big{font-size:larger}",
  "center{text-align:center}",
  "nobr{white-space:nowrap}",
].join("\n");

/** Parents whose content model the HTML parser enforces: a rewritten tag here is unwrapped. */
const STRUCTURED_PARENTS = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "colgroup",
  "select",
  "optgroup",
]);
/** Inline boxes whose content flows with the text around them. */
const INLINE_FLOW_TAGS = new Set(
  "span a b i u s em strong small sub sup mark code label".split(" "),
);
/** Inline-level by default: inline flow boxes plus replaced and control elements. */
const INLINE_LEVEL_TAGS = new Set([
  ...INLINE_FLOW_TAGS,
  ..."button input textarea select img br progress meter svg".split(" "),
]);
const HTML_WHITESPACE = /^[ \t\n\f\r]*$/;
const displayOf = (style: string) => declaredStyles(style).get("display")?.trim().toLowerCase();
const preservesWhitespace = (tag: string, style: string) => {
  if (tag === "pre" || tag === "textarea") return true;
  const declared = declaredStyles(style);
  return (
    /^(?:pre|pre-wrap|pre-line|break-spaces)\b/i.test(declared.get("white-space")?.trim() ?? "") ||
    /preserve|break-spaces/i.test(declared.get("white-space-collapse") ?? "")
  );
};
/** Whether an element sits in a line with the text around it (unknown displays count as inline). */
function isInlineLevel(tag: string, style: string): boolean {
  const display = displayOf(style);
  if (display) return !/^(?:block|flex|grid|table|list-item|flow-root)\b/.test(display);
  return INLINE_LEVEL_TAGS.has(tag);
}

/** A parent element, as the import sees it: the tag it stores and its own inline style. */
export type DesignImportAncestor = { tag: string; style: string };

export type DesignImportOptions = {
  /**
   * Agent imports: one line per kind of change made to the HTML (tags rewritten or removed,
   * attributes left out), for `dropped`. Editor imports pass nothing and take the same changes
   * silently.
   */
  note?: (message: string) => void;
  /** Filled with the tag the HTML used for each layer stored under a neutral tag. */
  sourceTags?: Map<string, string>;
  /** Where the forest goes, nearest first, ending with the frame root (a `div`). */
  ancestors?: readonly DesignImportAncestor[];
};

/** The first 10 items, then a count of the rest. */
const listOf = (items: ReadonlySet<string>) =>
  [...items].slice(0, 10).join(", ") + (items.size > 10 ? `, and ${items.size - 10} more` : "");

/** One line per kind of change, each listing what it changed. */
function importNotes() {
  const kinds = {
    replaced: new Set<string>(),
    removed: new Set<string>(),
    links: new Set<string>(),
    sources: new Set<string>(),
    handlers: new Set<string>(),
    identity: new Set<string>(),
    attributes: new Set<string>(),
  };
  const attribute = (tag: string, name: string) => {
    const item = `${name} on <${tag}>`;
    if (name === "href") kinds.links.add(item);
    else if (/^(?:src|srcset|poster|background|data|lowsrc|dynsrc|formaction|action)$/.test(name))
      kinds.sources.add(item);
    else if (/^on/i.test(name)) kinds.handlers.add(item);
    else if (name === DESIGN_LAYER_ATTRIBUTE) kinds.identity.add(item);
    else kinds.attributes.add(item);
  };
  const lines = () =>
    [
      kinds.replaced.size &&
        `Replaced tags the canvas has no layer for, keeping their content: ${listOf(kinds.replaced)}`,
      kinds.removed.size && `Dropped tags with everything inside them: ${listOf(kinds.removed)}`,
      kinds.links.size &&
        `Dropped link targets (links never navigate on the canvas): ${listOf(kinds.links)}`,
      kinds.sources.size &&
        `Dropped external sources (only an img src loads, and only synara-asset:ID or data:image; import files with synara_import_canvas_asset): ${listOf(kinds.sources)}`,
      kinds.handlers.size &&
        `Dropped event handlers (scripts never run on the canvas): ${listOf(kinds.handlers)}`,
      kinds.identity.size &&
        `Dropped layer IDs written in the HTML (Synara gives new layers new IDs): ${listOf(kinds.identity)}`,
      kinds.attributes.size &&
        `Dropped attributes canvas layers do not keep: ${listOf(kinds.attributes)}`,
    ].filter((line): line is string => typeof line === "string");
  return { kinds, attribute, lines };
}

const SVG_ELEMENT_REASONS: Readonly<Record<string, string>> = {
  script: "scripts never run on the canvas",
  foreignObject: "it would embed HTML inside the SVG",
  style: "SVG stylesheets are not supported; use presentation attributes or inline styles",
  use: "references to other content are not supported",
  image: "images inside an SVG are not supported; use an img layer with a canvas asset",
  feImage: "images inside an SVG are not supported",
  a: "links are not supported",
  iframe: "embedded documents are not supported",
  embed: "embedded documents are not supported",
  object: "embedded documents are not supported",
  animate: "frames are static",
  animateMotion: "frames are static",
  animateTransform: "frames are static",
  animateColor: "frames are static",
  set: "frames are static",
  filter: "SVG filters are not supported; use the CSS filter property",
};
// Inert, and written by most SVG exporters: dropped without a report.
const IGNORED_SVG_ATTRIBUTES = new Set(["version", "baseProfile", "focusable"]);
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
/**
 * Removes every DOCTYPE that has an internal subset (entity declarations), in one linear pass:
 * the HTML parser expands no custom entities, and the declarations are never kept. An
 * unterminated subset takes the rest of the source with it.
 */
function stripDoctypeSubsets(source: string, found: () => void): string {
  const lower = source.toLowerCase();
  let result = "";
  let from = 0;
  for (
    let at = lower.indexOf("<!doctype", from);
    at !== -1;
    at = lower.indexOf("<!doctype", from)
  ) {
    const close = lower.indexOf(">", at);
    if (!lower.slice(at, close === -1 ? undefined : close).includes("[")) {
      if (close === -1) break;
      result += source.slice(from, close + 1);
      from = close + 1;
      continue;
    }
    found();
    result += source.slice(from, at);
    const end = lower.indexOf("]", at);
    const final = end === -1 ? -1 : lower.indexOf(">", end);
    from = final === -1 ? source.length : final + 1;
  }
  return result + source.slice(from);
}

type ParsedElement = DefaultTreeAdapterTypes.Element;

/** parse5 nodes in an element's subtree, to refuse an oversized SVG before importing it. */
function countSubtree(node: DefaultTreeAdapterTypes.ChildNode, limit: number): number {
  let count = 1;
  if ("childNodes" in node)
    for (const child of node.childNodes) {
      if (count > limit) break;
      count += countSubtree(child, limit - count);
    }
  return count;
}

const styleOf = (node: DefaultTreeAdapterTypes.Element) =>
  node.attrs.find((attr) => !attr.namespace && attr.name === "style")?.value ?? "";

/** A parsed child as its parent's whitespace rule sees it. */
type ChildKind = "blank" | "inline" | "block" | "none";

/**
 * HTML is imported once. Identity belongs to the model, never to user-supplied attributes.
 * Inline SVG is kept to the subset in `@synara/shared/designCanvasSvg`; every part outside it
 * goes to `rejected` (strict by default) and is never stored. An HTML tag Synara has no layer
 * for is stored as a neutral tag with its content, unless it runs, loads or embeds something
 * (then it goes with its content); attributes a layer cannot keep are left out. Whitespace-only
 * text is a layer only where it can show: between inline content, inside inline text, and in
 * `pre` or preserved white space. `options.note` hears about every change but whitespace.
 */
export function importDesignLayers(
  source: string,
  makeId = () => `layer_${randomUUID()}`,
  parentTag?: string,
  styleSheets: string[] = [],
  rejected: RejectedSvgPart = refuseSvgPart,
  options: DesignImportOptions = {},
): DesignLayerTree {
  // Content inserted into an SVG element is parsed as SVG, as a browser parses it there.
  const svgParent = parentTag !== undefined && DESIGN_SVG_TAGS.has(parentTag);
  const context = parentTag
    ? defaultTreeAdapter.createElement(
        parentTag,
        svgParent ? htmlNamespaces.NS.SVG : htmlNamespaces.NS.HTML,
        [],
      )
    : null;
  // The HTML parser expands no custom entities; the subset that declares them is not kept.
  const cleaned = stripDoctypeSubsets(source, () =>
    rejected({ what: "<!DOCTYPE>", reason: "XML entity declarations are not supported" }),
  );
  const fragment = parseFragment(context, cleaned, { scriptingEnabled: true });
  const nodes: DesignLayer[] = [];
  const checkLimits = (depth: number) => {
    if (depth > DESIGN_CANVAS_MAX_DEPTH) throw new Error("Layer nesting exceeds 64 levels.");
    if (nodes.length >= DESIGN_CANVAS_MAX_LAYERS)
      throw new Error(
        `View exceeds its ${DESIGN_CANVAS_MAX_LAYERS.toLocaleString("en-US")}-layer limit.`,
      );
  };
  /** The attributes an SVG element keeps; the rest are reported, never stored. */
  const svgAttributes = (node: ParsedElement) => {
    const kept: Record<string, string> = {};
    for (const attr of node.attrs) {
      const shown = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      let name = attr.name;
      if (attr.namespace === XMLNS_NAMESPACE) {
        // The standard declarations every SVG file carries; any other is a namespace trick.
        if (
          (shown === "xmlns" && attr.value === htmlNamespaces.NS.SVG) ||
          (shown === "xmlns:xlink" && attr.value === XLINK_NAMESPACE)
        )
          continue;
        rejected({
          what: `${shown} on <${node.tagName}>`,
          reason: "XML namespace attributes are not supported",
        });
        continue;
      }
      if (attr.namespace === XLINK_NAMESPACE && attr.name === "href") name = "href";
      else if (attr.namespace) {
        rejected({
          what: `${shown} on <${node.tagName}>`,
          reason: "XML namespace attributes are not supported",
        });
        continue;
      }
      if (IGNORED_SVG_ATTRIBUTES.has(name)) continue;
      const problem =
        name === DESIGN_LAYER_ATTRIBUTE
          ? "is reserved"
          : designSvgAttributeProblem(node.tagName, name, attr.value);
      if (problem) {
        rejected({ what: `${shown} on <${node.tagName}>`, reason: problem });
        continue;
      }
      kept[name] = attr.value;
    }
    return kept;
  };
  const copySvg = (
    node: DefaultTreeAdapterTypes.ChildNode,
    depth: number,
    parent: string,
  ): string | undefined => {
    checkLimits(depth);
    if ("value" in node) {
      // SVG renders text only in elements Synara does not allow; title and desc keep theirs.
      if (!DESIGN_SVG_TEXT_TAGS.has(parent)) return;
      const id = makeId();
      nodes.push({ id, type: "text", text: node.value });
      return id;
    }
    if (!("tagName" in node)) return;
    const tag = node.tagName;
    if (node.namespaceURI !== htmlNamespaces.NS.SVG || DESIGN_SVG_TEXT_TAGS.has(parent)) {
      rejected({ what: `<${tag}>`, reason: "markup is not allowed here" });
      return;
    }
    if (!DESIGN_SVG_TAGS.has(tag)) {
      rejected({
        what: `<${tag}>`,
        reason: SVG_ELEMENT_REASONS[tag] ?? "it is not in Synara's SVG subset",
      });
      return;
    }
    const id = makeId();
    const children: string[] = [];
    nodes.push({ id, type: "element", tag, attributes: svgAttributes(node), children });
    for (const child of node.childNodes) {
      const childId = copySvg(child, depth + 1, tag);
      if (childId) children.push(childId);
    }
    return id;
  };
  const notes = importNotes();
  /** The stored parent, whether a paragraph encloses it, and whether white space is kept. */
  type Context = { parent: DesignImportAncestor; inParagraph: boolean; preserve: boolean };
  type Fate =
    | { kind: "keep"; tag: string; style: string }
    | { kind: "unwrap" }
    | { kind: "remove"; reason: string };
  /** What a parsed HTML element becomes under `context`; the same answer on every call. */
  const fateOf = (node: ParsedElement, context: Context): Fate => {
    const source = node.tagName;
    if (DESIGN_HTML_TAGS.has(source)) return { kind: "keep", tag: source, style: "" };
    const reason = REMOVED_HTML_TAGS[source];
    if (reason) return { kind: "remove", reason };
    // Table and select parts admit no neutral tag: the parser would move it out again.
    if (STRUCTURED_PARENTS.has(context.parent.tag)) return { kind: "unwrap" };
    const tag = MAPPED_HTML_TAGS[source] ?? "div";
    // A div would close the enclosing paragraph on the next parse; a block span does not.
    return tag === "div" && context.inParagraph
      ? { kind: "keep", tag: "span", style: "display:block" }
      : { kind: "keep", tag, style: "" };
  };
  const kindOf = (node: DefaultTreeAdapterTypes.ChildNode, context: Context): ChildKind => {
    if ("value" in node) return HTML_WHITESPACE.test(node.value) ? "blank" : "inline";
    if (!("tagName" in node)) return "none";
    if (node.namespaceURI === htmlNamespaces.NS.SVG && node.tagName === "svg")
      return isInlineLevel("svg", styleOf(node)) ? "inline" : "block";
    if (node.namespaceURI !== htmlNamespaces.NS.HTML || node.tagName === "style") return "none";
    const fate = fateOf(node, context);
    if (fate.kind === "remove") return "none";
    if (fate.kind === "unwrap") return "block";
    return isInlineLevel(fate.tag, `${fate.style};${styleOf(node)}`) ? "inline" : "block";
  };
  /**
   * Children in order. Whitespace-only text is kept in preserved white space, inside inline
   * text, and between two inline neighbours; never in flex, grid, table or select parents,
   * where the browser does not render it. `openEdges`: the list joins siblings this import
   * does not see (HTML inserted into an element), which count as inline.
   */
  const copyChildren = (
    parent: { childNodes: DefaultTreeAdapterTypes.ChildNode[] },
    depth: number,
    context: Context,
    openEdges = false,
  ): string[] => {
    const kinds = parent.childNodes.map((child) => kindOf(child, context));
    const display = displayOf(context.parent.style) ?? "";
    const neverShown = STRUCTURED_PARENTS.has(context.parent.tag) || /flex|grid/.test(display);
    const flows = display
      ? display === "inline" || display === "contents"
      : INLINE_FLOW_TAGS.has(context.parent.tag);
    const inlineBeside = (index: number, step: 1 | -1) => {
      for (let at = index + step; at >= 0 && at < kinds.length; at += step) {
        if (kinds[at] === "inline") return true;
        if (kinds[at] === "block") return false;
      }
      return openEdges;
    };
    const ids: string[] = [];
    parent.childNodes.forEach((child, index) => {
      if (
        kinds[index] === "blank" &&
        (neverShown ||
          !(context.preserve || flows || (inlineBeside(index, -1) && inlineBeside(index, 1))))
      )
        return;
      ids.push(...copy(child, depth, context));
    });
    return ids;
  };
  const copy = (
    node: DefaultTreeAdapterTypes.ChildNode,
    depth: number,
    context: Context,
  ): string[] => {
    checkLimits(depth);
    if ("value" in node) {
      const id = makeId();
      nodes.push({ id, type: "text", text: node.value });
      return [id];
    }
    if (!("tagName" in node)) return [];
    if (node.namespaceURI === htmlNamespaces.NS.SVG && node.tagName === "svg") {
      if (countSubtree(node, DESIGN_CANVAS_MAX_SVG_LAYERS) > DESIGN_CANVAS_MAX_SVG_LAYERS) {
        rejected({
          what: "<svg>",
          reason: `it holds more than ${DESIGN_CANVAS_MAX_SVG_LAYERS.toLocaleString("en-US")} nodes`,
        });
        return [];
      }
      const id = copySvg(node, depth, "");
      return id ? [id] : [];
    }
    if (node.namespaceURI !== htmlNamespaces.NS.HTML) {
      notes.kinds.removed.add(
        `<${node.tagName}> (MathML is not supported; write the formula as text or inline SVG)`,
      );
      return [];
    }
    if (node.tagName === "style") {
      // Stylesheets are not layers: the caller inlines them into element styles.
      styleSheets.push(
        node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""),
      );
      return [];
    }
    const fate = fateOf(node, context);
    if (fate.kind === "remove") {
      notes.kinds.removed.add(`<${node.tagName}> (${fate.reason})`);
      return [];
    }
    if (fate.kind === "unwrap") {
      notes.kinds.replaced.add(`<${node.tagName}> by its content (inside <${context.parent.tag}>)`);
      return copyChildren(node, depth, context);
    }
    const id = makeId();
    const children: string[] = [];
    const attributes: Record<string, string> = {};
    for (const attr of node.attrs) {
      if (!attr.namespace && isDesignAttributeAllowed(fate.tag, attr.name, attr.value))
        attributes[attr.name] = attr.value;
      else notes.attribute(node.tagName, attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name);
    }
    if (fate.style)
      attributes.style = attributes.style ? `${fate.style};${attributes.style}` : fate.style;
    if (fate.tag !== node.tagName) {
      notes.kinds.replaced.add(
        `<${node.tagName}> as <${fate.tag}${fate.style ? ` style="${fate.style}"` : ""}>`,
      );
      options.sourceTags?.set(id, node.tagName);
    }
    nodes.push({ id, type: "element", tag: fate.tag, attributes, children });
    const style = attributes.style ?? "";
    children.push(
      ...copyChildren(node, depth + 1, {
        parent: { tag: fate.tag, style },
        inParagraph: context.inParagraph || fate.tag === "p",
        preserve: context.preserve || preservesWhitespace(fate.tag, style),
      }),
    );
    return [id];
  };
  const ancestors = options.ancestors ?? [];
  const roots = svgParent
    ? fragment.childNodes
        .map((node) => copySvg(node, 0, parentTag ?? ""))
        .filter((id): id is string => id !== undefined)
    : copyChildren(
        fragment,
        0,
        {
          parent: ancestors[0] ?? { tag: parentTag ?? "div", style: "" },
          inParagraph: parentTag === "p" || ancestors.some((item) => item.tag === "p"),
          preserve:
            (parentTag !== undefined && preservesWhitespace(parentTag, "")) ||
            ancestors.some((item) => preservesWhitespace(item.tag, item.style)),
        },
        parentTag !== undefined,
      );
  const tree = { roots, nodes };
  validateDesignLayers(tree, parentTag === undefined ? undefined : { parentTag });
  if (options.note) for (const line of notes.lines()) options.note(line);
  return tree;
}

/** Refuse mutations the HTML parser would reparent, drop or reinterpret on display. */
function assertRenderable(tree: DesignLayerTree) {
  type Token = [kind: string, value: string];
  const expected: Token[] = [],
    actual: Token[] = [];
  const text = (into: Token[], value: string) => {
    if (!value) return;
    const last = into.at(-1);
    if (last?.[0] === "text") last[1] += value;
    else into.push(["text", value]);
  };
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const visit = (id: string) => {
    const node = nodes.get(id)!;
    if (node.type === "text") {
      text(expected, node.text);
      return;
    }
    expected.push(["open", `${node.tag}:${node.id}`]);
    for (const child of node.children) visit(child);
    expected.push(["close", node.tag]);
  };
  tree.roots.forEach((id) => visit(id));
  const inspect = (node: DefaultTreeAdapterTypes.ChildNode) => {
    if ("value" in node) text(actual, node.value);
    else if ("tagName" in node) {
      const id = node.attrs.find((attr) => attr.name === DESIGN_LAYER_ATTRIBUTE)?.value;
      actual.push(["open", `${node.tagName}:${id ?? "unowned"}`]);
      node.childNodes.forEach(inspect);
      actual.push(["close", node.tagName]);
    }
  };
  parseFragment(serializeDesignLayers(tree)).childNodes.forEach(inspect);
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error(
      "Invalid HTML layer nesting. Choose a compatible parent; the browser would change this structure.",
    );
}

const styleEntries = (style: string) =>
  parseDeclarations(style).map((item) => [
    item.prop,
    `${item.value}${item.important ? " !important" : ""}`,
  ]);

/** `key: value` as exactly one declaration of that property, or a refusal. */
function singleDeclaration(property: string, key: string, value: string): postcss.Declaration {
  const candidate = postcss.parse(`a{${key}:${value}}`);
  const rule = candidate.first;
  const declaration = rule?.type === "rule" ? rule.first : undefined;
  if (
    candidate.nodes.length !== 1 ||
    rule?.type !== "rule" ||
    rule.nodes.length !== 1 ||
    declaration?.type !== "decl" ||
    declaration.prop !== key
  )
    throw new Error(`Supply exactly one CSS value for ${property}.`);
  return declaration;
}

/**
 * Vendor-prefixed properties a style patch may name: the ones the inspector writes (text
 * stroke, line clamp, the backdrop filter fallback). Any other prefixed name is refused as
 * invalid, as before, so nothing like `-webkit-app-region` can be set through a patch.
 */
const PATCHABLE_PREFIXED_PROPERTIES = new Set([
  "-webkit-text-stroke",
  "-webkit-text-stroke-width",
  "-webkit-text-stroke-color",
  "-webkit-line-clamp",
  "-webkit-box-orient",
  "-webkit-backdrop-filter",
]);

const isPatchableProperty = (property: string) =>
  /^(?:--[a-zA-Z_][a-zA-Z0-9_-]*|[a-zA-Z][a-zA-Z0-9-]*)$/.test(property) ||
  PATCHABLE_PREFIXED_PROPERTIES.has(property.toLowerCase());

/** Called for a declaration the sanitizer rejects, instead of refusing the whole patch. */
export type RejectedDeclaration = (property: string, value: string, reason: string) => void;

/**
 * Patches inline declarations. A value the sanitizer rejects refuses the patch, or, with
 * `rejected`, is left out (the layer keeps what it had for that property) and reported.
 * Input that is not a declaration at all (an invalid property name, several values, broken
 * syntax) always refuses: a rejected value is never stored either way.
 */
export function patchStyles(
  source: string,
  patch: Readonly<Record<string, string | null>>,
  rejected?: RejectedDeclaration,
): string {
  const root = postcss.parse(`a{${source}}`);
  const rule = root.first;
  if (
    root.nodes.length !== 1 ||
    rule?.type !== "rule" ||
    rule.nodes.some((node) => node.type !== "decl" && node.type !== "comment")
  )
    throw new Error("Invalid inline CSS declarations.");
  if (Object.keys(patch).length > 100)
    throw new Error("At most 100 style properties per operation.");
  for (const [property, value] of Object.entries(patch)) {
    if (!isPatchableProperty(property)) throw new Error(`Invalid CSS property: ${property}`);
    const key = property.startsWith("--") ? property : property.toLowerCase();
    let replacement: postcss.Declaration | null = null;
    if (value !== null) {
      // Malformed input refuses before the sanitizer is asked: it is never "just dropped".
      singleDeclaration(property, key, value);
      const safe = sanitizeDeclarationValue(key, value);
      if ("reason" in safe) {
        if (!rejected) throw new Error(`Unsupported CSS: ${safe.reason}.`);
        rejected(key, value, safe.reason);
        continue;
      }
      replacement = singleDeclaration(property, key, safe.value).clone();
    }
    for (const declaration of [...rule.nodes]) {
      if (
        declaration.type === "decl" &&
        (declaration.prop.startsWith("--") ? declaration.prop : declaration.prop.toLowerCase()) ===
          key
      )
        declaration.remove();
    }
    if (replacement) rule.append(replacement);
  }
  return rule.nodes.map((node) => node.toString()).join(";");
}

const position = (beforeId: string | undefined) => (beforeId === undefined ? {} : { beforeId });
const newLayerId = () => `layer_${randomUUID()}`;

type MutableElement = {
  id: string;
  type: "element";
  tag: string;
  attributes: Record<string, string>;
  children: string[];
};
type MutableLayer = MutableElement | { id: string; type: "text"; text: string };

export type DesignLayerEditOptions = {
  /**
   * Agent edits (the MCP tools). A declaration the sanitizer rejects (in set_styles,
   * set_frame_styles or a style attribute) is left out and listed in `dropped` while the rest
   * of the batch applies, and a refused batch names the operation that stopped it (index,
   * type, layer). Editor edits keep the strict rule, where such a value refuses the batch,
   * and the plain messages the editor's error toast shows.
   */
  agent?: boolean;
};

export type DesignLayerEditResult = {
  layers: DesignLayerTree;
  createdNodeIds: string[];
  frameStyle: string;
  dropped: string[];
  applied: DesignLayerAppliedEdit[];
  duplicates: DesignLayerDuplicate[];
};

type FrameContext = { style: string; width: number; height: number };

/** "operations[2] (set_styles on layer x)": how a refusal names the operation it stopped at. */
function describeOperation(index: number, operation: DesignLayerEdit): string {
  const target =
    "nodeId" in operation
      ? ` on layer ${operation.nodeId}`
      : "parentId" in operation
        ? operation.parentId === null
          ? " at the frame root"
          : ` under layer ${operation.parentId}`
        : " on the frame";
  return `operations[${index}] (${operation.type}${target})`;
}

const refusal = (index: number, operation: DesignLayerEdit, cause: unknown) =>
  new Error(
    `${describeOperation(index, operation)} was refused: ${cause instanceof Error ? cause.message : String(cause)} Nothing in this batch was applied.`,
    { cause },
  );

function applyDesignLayerOperations(
  original: DesignLayerTree,
  operations: readonly DesignLayerEdit[],
  frame: FrameContext,
  options: DesignLayerEditOptions,
): DesignLayerEditResult {
  let frameStyle = frame.style;
  const dropped: string[] = [];
  const applied: DesignLayerAppliedEdit[] = [];
  const duplicates: DesignLayerDuplicate[] = [];
  const tree = structuredClone(original) as { roots: string[]; nodes: MutableLayer[] };
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const createdNodeIds: string[] = [];
  const requireNode = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Layer not found: ${id}. Read the current layers before retrying.`);
    return node;
  };
  const parentOf = (id: string) =>
    (tree.nodes.find((node) => node.type === "element" && node.children.includes(id)) as
      | MutableElement
      | undefined) ?? null;
  /** A text layer has no style, attributes or children: the refusal names its element. */
  const requireElement = (id: string) => {
    const node = requireNode(id);
    if (node.type === "element") return node;
    const holder = parentOf(id);
    throw new Error(
      holder
        ? `Layer ${id} is a text layer, which takes no styles, attributes or children; use the element that holds it, layer ${holder.id} (<${holder.tag}>).`
        : "This operation requires an element layer.",
    );
  };
  /** The text layers an element holds, as a refused set_text names them (the first five). */
  const textLayersInside = (element: MutableElement) => {
    const found: string[] = [];
    const visit = (id: string) => {
      const node = nodes.get(id);
      if (node?.type === "text") {
        if (node.text.trim()) found.push(`${id} ${JSON.stringify(node.text.trim().slice(0, 40))}`);
      } else node?.children.forEach(visit);
    };
    element.children.forEach(visit);
    const where = `Layer ${element.id} (<${element.tag}>)`;
    if (found.length === 0)
      return `${where} holds no text; insert text into it with insert_html instead.`;
    const more = found.length > 5 ? `; and ${found.length - 5} more` : "";
    return `${where} holds other layers; set_text one of its text layers: ${found.slice(0, 5).join("; ")}${more}.`;
  };
  const childrenOf = (parentId: string | null) => {
    if (parentId === null) return tree.roots;
    const parent = requireElement(parentId);
    if (DESIGN_VOID_TAGS.has(parent.tag)) throw new Error("This element cannot contain children.");
    return parent.children;
  };
  const detach = (id: string) => {
    const parent = parentOf(id);
    const siblings = parent ? parent.children : tree.roots;
    const index = siblings.indexOf(id);
    if (index < 0) throw new Error("Layer has no parent.");
    siblings.splice(index, 1);
  };
  const insert = (children: string[], ids: readonly string[], beforeId?: string) => {
    const index = beforeId === undefined ? children.length : children.indexOf(beforeId);
    if (index < 0) throw new Error("beforeId must identify a child of the destination parent.");
    children.splice(index, 0, ...ids);
  };
  const add = (layers: DesignLayerTree) => {
    for (const node of layers.nodes) {
      const mutable = structuredClone(node) as MutableLayer;
      nodes.set(node.id, mutable);
      tree.nodes.push(mutable);
      createdNodeIds.push(node.id);
    }
  };
  const remove = (id: string) => {
    const drop = (nodeId: string) => {
      const node = requireNode(nodeId);
      if (node.type === "element") node.children.forEach(drop);
      nodes.delete(nodeId);
    };
    detach(id);
    drop(id);
    tree.nodes = tree.nodes.filter((node) => nodes.has(node.id));
  };
  /** The elements a layer would sit in, nearest first, ending with the frame root. */
  const ancestorsOf = (parentId: string | null): DesignImportAncestor[] => {
    const chain: DesignImportAncestor[] = [];
    for (let id = parentId; id !== null; ) {
      const node = requireElement(id);
      chain.push({ tag: node.tag, style: node.attributes.style ?? "" });
      id = parentOf(id)?.id ?? null;
    }
    return [...chain, { tag: "div", style: frameStyle }];
  };
  /** Parsed once, stylesheets inlined; what the import changed and the inliner dropped is reported. */
  const importHtml = (html: string, css: string | undefined, parentId: string | null) => {
    const sheets = css ? [css] : [];
    const sourceTags = new Map<string, string>();
    const parsed = importDesignLayers(
      html,
      undefined,
      parentId === null ? undefined : requireElement(parentId).tag,
      sheets,
      options.agent ? reportSvgPart(dropped) : refuseSvgPart,
      {
        ...(options.agent ? { note: reportTo(dropped) } : {}),
        sourceTags,
        ancestors: ancestorsOf(parentId),
      },
    );
    const inlined = inlineDesignStyles({
      layers: parsed,
      css: [...(sourceTags.size > 0 ? [DESIGN_MAPPED_TAG_CSS] : []), ...sheets].join("\n"),
      width: frame.width,
      height: frame.height,
      sourceTags,
    });
    dropped.push(...inlined.dropped);
    if (inlined.frameDeclarations)
      dropped.push("Ignored html/body/:root rules in inserted HTML; use set_frame_styles");
    return inlined.layers;
  };
  operations.forEach((operation, index) => {
    const rejected: RejectedDeclaration | undefined = options.agent
      ? (property, _value, reason) => {
          // The value itself is left out: the receipt keeps this text, and nothing the
          // sanitizer rejected is stored anywhere.
          const where =
            "nodeId" in operation ? `on layer ${operation.nodeId}` : "on the frame style";
          dropped.push(`Dropped ${property} ${where} (operations[${index}]): ${reason}`);
        }
      : undefined;
    try {
      switch (operation.type) {
        case "set_text": {
          const node = requireNode(operation.nodeId);
          const text = operation.text.replace(/\r\n?/g, "\n");
          if (node.type === "text") {
            node.text = text;
            applied.push({ type: "set_text", nodeId: node.id, text });
            break;
          }
          // A text block's element: all of its content becomes this one plain text, its
          // styled spans included.
          if (designTextBlockKind(nodes, node.id) === null)
            throw new Error(
              `set_text requires a text-layer ID, or the ID of an element that holds only text and styled spans. ${textLayersInside(node)}`,
            );
          const kept = node.children.find((id) => nodes.get(id)?.type === "text");
          const removed = node.children.filter((id) => id !== kept);
          const spans = removed.filter((id) => nodes.get(id)?.type === "element").length;
          for (const id of removed) {
            remove(id);
            applied.push({ type: "delete", nodeId: id });
          }
          const keptNode = kept === undefined ? undefined : nodes.get(kept);
          if (keptNode?.type === "text") {
            keptNode.text = text;
            applied.push({ type: "set_text", nodeId: keptNode.id, text });
          } else if (text) {
            const textId = newLayerId();
            const layers: DesignLayerTree = {
              roots: [textId],
              nodes: [{ id: textId, type: "text", text }],
            };
            insert(node.children, layers.roots);
            add(layers);
            applied.push({
              type: "insert_layers",
              parentId: node.id,
              layers: structuredClone(layers),
            });
          }
          if (spans > 0 && options.agent)
            dropped.push(
              `set_text on text block ${node.id} (operations[${index}]) removed ${spans} styled span${spans === 1 ? "" : "s"}; the block is plain text now`,
            );
          break;
        }
        case "set_attributes": {
          const node = requireElement(operation.nodeId);
          if (Object.keys(operation.attributes).length > 100)
            throw new Error("At most 100 attributes per operation.");
          const resolved: Record<string, string | null> = {};
          for (const [key, value] of Object.entries(operation.attributes)) {
            if (
              !(value === null && key === "src" && node.tag === "img") &&
              // Removing an SVG attribute is always safe; its value rules apply to new values.
              !(value === null && DESIGN_SVG_TAGS.has(node.tag)) &&
              !isDesignAttributeAllowed(node.tag, key, value ?? "")
            )
              throw new Error(
                DESIGN_SVG_TAGS.has(node.tag)
                  ? `Unsupported SVG attribute ${key} on <${node.tag}>: ${designSvgAttributeProblem(node.tag, key, value ?? "") ?? "refused"}.`
                  : `Unsupported layer attribute: ${key}`,
              );
            if (value === null) delete node.attributes[key];
            else if (key === "style") {
              // Same value checks as set_styles; an empty result removes the attribute.
              const style = patchStyles("", Object.fromEntries(styleEntries(value)), rejected);
              if (style) node.attributes.style = style;
              else delete node.attributes.style;
            } else node.attributes[key] = value;
            resolved[key] = node.attributes[key] ?? null;
          }
          applied.push({ type: "set_attributes", nodeId: node.id, attributes: resolved });
          break;
        }
        case "set_styles": {
          const node = requireElement(operation.nodeId);
          const style = patchStyles(node.attributes.style ?? "", operation.styles, rejected);
          if (style) node.attributes.style = style;
          else delete node.attributes.style;
          applied.push({
            type: "set_attributes",
            nodeId: node.id,
            attributes: { style: style || null },
          });
          break;
        }
        case "set_frame_styles": {
          frameStyle = patchStyles(frameStyle, operation.styles, rejected);
          break;
        }
        case "insert_html": {
          const children = childrenOf(operation.parentId);
          const layers = importHtml(operation.html, operation.css, operation.parentId);
          insert(children, layers.roots, operation.beforeId);
          add(layers);
          applied.push({
            type: "insert_layers",
            parentId: operation.parentId,
            ...position(operation.beforeId),
            layers: structuredClone(layers),
          });
          break;
        }
        case "insert_layers": {
          const children = childrenOf(operation.parentId);
          validateDesignLayers(
            operation.layers,
            operation.parentId === null
              ? undefined
              : { parentTag: requireElement(operation.parentId).tag },
          );
          for (const node of operation.layers.nodes) {
            if (nodes.has(node.id))
              throw new Error(
                `Layer ID already exists: ${node.id}. Use insert_html for new layers.`,
              );
            if (node.type === "element" && node.attributes.style)
              patchStyles("", Object.fromEntries(styleEntries(node.attributes.style)));
          }
          insert(children, operation.layers.roots, operation.beforeId);
          add(operation.layers);
          applied.push({
            type: "insert_layers",
            parentId: operation.parentId,
            ...position(operation.beforeId),
            layers: structuredClone(operation.layers),
          });
          break;
        }
        case "duplicate": {
          const source = requireNode(operation.nodeId);
          const sourceParent = parentOf(source.id);
          if (!sourceParent && !tree.roots.includes(source.id))
            throw new Error("Layer has no parent.");
          const parentId =
            operation.parentId === undefined ? (sourceParent?.id ?? null) : operation.parentId;
          const children = childrenOf(parentId);
          let beforeId = operation.beforeId;
          if (beforeId === undefined && operation.parentId === undefined) {
            const siblings = sourceParent ? sourceParent.children : tree.roots;
            beforeId = siblings[siblings.indexOf(source.id) + 1];
          }
          const idMap: Record<string, string> = {};
          const copies: DesignLayer[] = [];
          const copy = (id: string): string => {
            const node = requireNode(id);
            const copyId = newLayerId();
            idMap[id] = copyId;
            if (node.type === "text") {
              copies.push({ id: copyId, type: "text", text: node.text });
              return copyId;
            }
            const children: string[] = [];
            copies.push({
              id: copyId,
              type: "element",
              tag: node.tag,
              attributes: { ...node.attributes },
              children,
            });
            for (const child of node.children) children.push(copy(child));
            return copyId;
          };
          const rootId = copy(source.id);
          const layers = { roots: [rootId], nodes: copies };
          insert(children, layers.roots, beforeId);
          add(layers);
          applied.push({
            type: "insert_layers",
            parentId,
            ...position(beforeId),
            layers: structuredClone(layers),
          });
          duplicates.push({ sourceId: source.id, newId: rootId, idMap });
          break;
        }
        case "replace_html": {
          const target = requireNode(operation.nodeId);
          const parent = parentOf(target.id);
          if (!parent && !tree.roots.includes(target.id)) throw new Error("Layer has no parent.");
          const layers = importHtml(operation.html, operation.css, parent?.id ?? null);
          insert(parent ? parent.children : tree.roots, layers.roots, target.id);
          add(layers);
          remove(target.id);
          applied.push(
            {
              type: "insert_layers",
              parentId: parent?.id ?? null,
              beforeId: target.id,
              layers: structuredClone(layers),
            },
            { type: "delete", nodeId: target.id },
          );
          break;
        }
        case "move": {
          requireNode(operation.nodeId);
          const children = childrenOf(operation.parentId);
          detach(operation.nodeId);
          insert(children, [operation.nodeId], operation.beforeId);
          applied.push({
            type: "move",
            nodeId: operation.nodeId,
            parentId: operation.parentId,
            ...position(operation.beforeId),
          });
          break;
        }
        case "delete": {
          remove(operation.nodeId);
          applied.push({ type: "delete", nodeId: operation.nodeId });
          break;
        }
      }
      validateDesignLayers(tree);
    } catch (error) {
      throw options.agent ? refusal(index, operation, error) : error;
    }
  });
  return {
    layers: tree,
    createdNodeIds: createdNodeIds.filter((id) => nodes.has(id)),
    frameStyle,
    dropped: [...new Set(dropped)],
    applied,
    duplicates,
  };
}

/** Operations that can change how the browser would nest the frame's elements. */
const STRUCTURAL = new Set<DesignLayerEdit["type"]>([
  "insert_html",
  "insert_layers",
  "duplicate",
  "replace_html",
  "move",
]);

/**
 * Work on a private draft; any invalid operation refuses the entire batch, and the error
 * names it (index, type, layer). `applied` lists the edits as they were applied (resolved
 * styles, created layers), for clients to replay.
 */
export function editDesignLayers(
  original: DesignLayerTree,
  operations: readonly DesignLayerEdit[],
  frame: FrameContext = { style: "", width: 1440, height: 1024 },
  options: DesignLayerEditOptions = {},
): DesignLayerEditResult {
  validateDesignLayers(original);
  const result = applyDesignLayerOperations(original, operations, frame, options);
  try {
    assertRenderable(result.layers);
  } catch (error) {
    if (!options.agent) throw error;
    // Only on refusal: replay growing prefixes to find the operation that broke the nesting.
    for (let index = 0; index < operations.length - 1; index++) {
      if (!STRUCTURAL.has(operations[index]!.type)) continue;
      const prefix = applyDesignLayerOperations(
        original,
        operations.slice(0, index + 1),
        frame,
        options,
      );
      try {
        assertRenderable(prefix.layers);
      } catch {
        throw refusal(index, operations[index]!, error);
      }
    }
    const last = operations.findLastIndex((operation) => STRUCTURAL.has(operation.type));
    const index = last >= 0 ? last : operations.length - 1;
    throw refusal(index, operations[index]!, error);
  }
  return result;
}
