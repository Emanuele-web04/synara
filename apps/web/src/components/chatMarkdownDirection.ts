// FILE: chatMarkdownDirection.ts
// Purpose: Block-level text direction resolution for chat markdown so Arabic
// (and, defensively, Hebrew) prose renders RTL inside chat messages without
// touching stored text, find offsets, links, or non-chat consumers.
// Layer: Web chat presentation logic
// Exports: resolveBlockDirection, isPureTechnicalLinkText, rehypeChatBlockDirection
//
// Link classification table (mirrors the `a` override in ChatMarkdown.tsx and
// markdown-links.ts at the render layer):
//   - bare URL autolink (link text === href, http/https variants)  -> technical
//   - scheme URL text (https://..., mailto:...)                    -> technical
//   - whitespace-free text with path separators (src/main.ts)      -> technical
//   - whitespace-free file name with extension (notes.md)          -> technical
//   - everything else (Arabic/English words, spaces, mixed prose)  -> human label
// Technical links get dir="ltr" and are excluded from their parent block's
// direction majority; human labels inherit the parent block direction.

import { COMPOSER_CHIP_TAG_NAME, TERMINAL_CONTEXT_CHIP_TAG_NAME } from "../lib/remarkComposerChips";

const RTL_SCRIPT_PATTERN = /[\p{Script_Extensions=Arabic}\p{Script_Extensions=Hebrew}]/u;
const LETTER_PATTERN = /\p{Letter}/u;
const SCHEME_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILE_NAME_PATTERN = /^[^.\s]+\.[A-Za-z0-9]{1,8}$/;

export type BlockDirection = "rtl" | "ltr";

/**
 * Resolves the dominant strong direction of `text` in a single pass over code
 * points. Code points in the Arabic or Hebrew script count as RTL, any other
 * letter counts as LTR, and digits, emoji, spaces, punctuation and combining
 * marks are neutral. Ties resolve to the first strong code point; text with no
 * strong code point resolves to `null`.
 */
export function resolveBlockDirection(text: string): BlockDirection | null {
  let rtlCount = 0;
  let ltrCount = 0;
  let firstStrong: BlockDirection | null = null;
  for (const char of text) {
    // Script_Extensions also contains Arabic-script digits, punctuation and
    // combining marks. They are neutral by policy, so only letters reach the
    // direction classifier.
    if (!LETTER_PATTERN.test(char)) continue;
    if (RTL_SCRIPT_PATTERN.test(char)) {
      rtlCount += 1;
      if (firstStrong === null) firstStrong = "rtl";
    } else {
      ltrCount += 1;
      if (firstStrong === null) firstStrong = "ltr";
    }
  }
  if (rtlCount > ltrCount) return "rtl";
  if (ltrCount > rtlCount) return "ltr";
  return rtlCount > 0 ? firstStrong : null;
}

/**
 * Whether link text is a pure technical representation (URL or path) rather
 * than a human-readable label. Such links are isolated LTR and excluded from
 * the parent block's direction majority.
 */
export function isPureTechnicalLinkText(text: string, href: string | undefined): boolean {
  if (text.length === 0) return false;
  if (
    href !== undefined &&
    (text === href || `http://${text}` === href || `https://${text}` === href)
  ) {
    return true;
  }
  if (SCHEME_URL_PATTERN.test(text)) return true;
  if (/\s/.test(text)) return false;
  return /[\\/]/.test(text) || FILE_NAME_PATTERN.test(text);
}

interface DirectionHastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: DirectionHastNode[];
}

const TEXT_BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "th",
  "td",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LIST_CONTAINER_TAGS = new Set(["ul", "ol"]);
const TECHNICAL_CUSTOM_TAGS = new Set([COMPOSER_CHIP_TAG_NAME, TERMINAL_CONTEXT_CHIP_TAG_NAME]);
const MIXED_DIRECTION_LIST_ATTRIBUTE = "data-mixed-direction-list";

function isElementNode(node: DirectionHastNode): node is DirectionHastNode & { tagName: string } {
  return node.type === "element" && typeof node.tagName === "string";
}

function elementClassName(node: DirectionHastNode): string {
  const className = node.properties?.className;
  if (typeof className === "string") return className;
  if (Array.isArray(className)) return className.map(String).join(" ");
  return "";
}

function isKatexElement(node: DirectionHastNode): boolean {
  return elementClassName(node).includes("katex");
}

function elementHref(node: DirectionHastNode): string | undefined {
  const href = node.properties?.href;
  return typeof href === "string" ? href : undefined;
}

function setElementDirection(node: DirectionHastNode, direction: BlockDirection): void {
  const properties = (node.properties ??= {});
  if (properties.dir !== direction) properties.dir = direction;
}

/** Stops descent for technical islands: code, KaTeX/MathML, media and controls. */
function isTechnicalIsland(node: DirectionHastNode): boolean {
  const tag = node.tagName;
  return (
    tag === "code" ||
    tag === "pre" ||
    tag === "math" ||
    tag === "img" ||
    tag === "input" ||
    (tag !== undefined && TECHNICAL_CUSTOM_TAGS.has(tag)) ||
    isKatexElement(node)
  );
}

/**
 * Concatenates all text under `node`, skipping technical islands. Used both
 * for block majorities and for classifying the text carried by a link element
 * (which must not re-enter the link-aware collector).
 */
function collectDescendantText(node: DirectionHastNode): string {
  let result = "";
  const walk = (current: DirectionHastNode): void => {
    if (current.type === "text") {
      result += current.value ?? "";
      return;
    }
    if (!isElementNode(current) || current.children === undefined) return;
    if (isTechnicalIsland(current)) return;
    for (const child of current.children) walk(child);
  };
  walk(node);
  return result;
}

/**
 * Concatenates the human-readable text under `node`, skipping technical
 * islands and pure-technical links (both are rendered LTR in isolation).
 * Non-technical wrappers (chat-find-text, strong, em, del, spans) and
 * human-labeled links are traversed so their text counts toward the majority.
 */
function collectHumanText(node: DirectionHastNode): string {
  let result = "";
  const walk = (current: DirectionHastNode): void => {
    if (current.type === "text") {
      result += current.value ?? "";
      return;
    }
    if (!isElementNode(current) || current.children === undefined) return;
    if (isTechnicalIsland(current)) return;
    if (
      current.tagName === "a" &&
      isPureTechnicalLinkText(collectDescendantText(current), elementHref(current))
    ) {
      return;
    }
    for (const child of current.children) walk(child);
  };
  walk(node);
  return result;
}

/**
 * Concatenates the direct text of a tight-list item: everything except nested
 * lists and technical islands (a tight item may still carry a sub-list).
 */
function collectTightListItemText(li: DirectionHastNode): string {
  let result = "";
  const walk = (current: DirectionHastNode): void => {
    if (current.type === "text") {
      result += current.value ?? "";
      return;
    }
    if (!isElementNode(current) || current.children === undefined) return;
    if (LIST_CONTAINER_TAGS.has(current.tagName) || isTechnicalIsland(current)) return;
    if (
      current.tagName === "a" &&
      isPureTechnicalLinkText(collectDescendantText(current), elementHref(current))
    ) {
      return;
    }
    for (const child of current.children) walk(child);
  };
  for (const child of li.children ?? []) walk(child);
  return result;
}

function computeListItemDirection(li: DirectionHastNode): BlockDirection | null {
  for (const child of li.children ?? []) {
    if (!isElementNode(child)) continue;
    // Loose list items: the item follows the first direct block (paragraph or heading).
    if (child.tagName === "p" || HEADING_TAGS.has(child.tagName)) {
      return resolveBlockDirection(collectHumanText(child));
    }
  }
  // Tight list items: the item's own inline text (nested lists excluded).
  return resolveBlockDirection(collectTightListItemText(li));
}

const computedDirections = new WeakMap<DirectionHastNode, BlockDirection | null>();

function applyDirectionToTree(root: DirectionHastNode): void {
  const visit = (node: DirectionHastNode): BlockDirection | null => {
    let ownDirection: BlockDirection | null = null;
    if (isElementNode(node)) {
      const tag = node.tagName;
      if (
        tag === "pre" ||
        tag === "code" ||
        tag === "math" ||
        tag === "table" ||
        TECHNICAL_CUSTOM_TAGS.has(tag) ||
        isKatexElement(node)
      ) {
        setElementDirection(node, "ltr");
      }
      if (tag === "a" && isPureTechnicalLinkText(collectDescendantText(node), elementHref(node))) {
        setElementDirection(node, "ltr");
      }
      for (const child of node.children ?? []) visit(child);
      if (tag === "li") {
        ownDirection = computeListItemDirection(node);
      } else if (TEXT_BLOCK_TAGS.has(tag)) {
        const text = collectHumanText(node);
        if (text.length > 0) ownDirection = resolveBlockDirection(text);
      }
      if (LIST_CONTAINER_TAGS.has(tag)) {
        const itemDirections = new Set<BlockDirection>();
        for (const child of node.children ?? []) {
          if (!isElementNode(child) || child.tagName !== "li") continue;
          const direction = computedDirections.get(child);
          if (direction !== undefined && direction !== null) itemDirections.add(direction);
        }
        if (itemDirections.size > 1) {
          const properties = (node.properties ??= {});
          if (properties[MIXED_DIRECTION_LIST_ATTRIBUTE] !== "true") {
            properties[MIXED_DIRECTION_LIST_ATTRIBUTE] = "true";
          }
        } else if (itemDirections.has("rtl")) {
          // A uniform RTL list needs an RTL container so its outside markers
          // use the right-side gutter. Mixed lists stay geometrically LTR and
          // use the scoped inside-marker rule instead.
          setElementDirection(node, "rtl");
        }
      }
      if (ownDirection !== null) setElementDirection(node, ownDirection);
    } else {
      for (const child of node.children ?? []) visit(child);
    }
    computedDirections.set(node, ownDirection);
    return ownDirection;
  };
  visit(root);
}

/**
 * rehype plugin that assigns explicit directions to text-owning blocks. Only
 * attributes are added: text values, positions, find offsets (`data-chat-find-
 * text-start`) and `href` values are never modified. Append after rehypeKatex
 * and rehypeRestoreLiteralDollars so KaTeX output is already in place.
 */
export function rehypeChatBlockDirection(): (tree: unknown) => void {
  const transform = (tree: unknown): void => {
    applyDirectionToTree(tree as DirectionHastNode);
  };
  return transform;
}
