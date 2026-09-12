import { isLocalAbsolutePath, joinWorkspaceRelativePath } from "@synara/shared/path";
import type { Root, RootContent, Text } from "mdast";
import { decodeString } from "micromark-util-decode-string";

import { markdownFilePathHref } from "../markdown-links";

type Point = NonNullable<Text["position"]>["start"];

function advancePoint(start: Point, raw: string): Point {
  const lines = raw.split("\n");
  return {
    line: start.line + lines.length - 1,
    column: lines.length === 1 ? start.column + raw.length : lines[lines.length - 1]!.length + 1,
    offset: (start.offset ?? 0) + raw.length,
  };
}

// Keep decoded escapes/entities in separate spans: following text must use its
// source offset, rather than an index into the shorter, decoded display string.
function sourceTextNodes(raw: string, start: Point): Text[] {
  const nodes: Text[] = [];
  let cursor = 0;
  let point = start;
  const append = (part: string) => {
    if (!part) return;
    const end = advancePoint(point, part);
    nodes.push({ type: "text", value: decodeString(part), position: { start: point, end } });
    point = end;
  };
  for (const match of raw.matchAll(/\\[!-/:-@[-`{-~]|&(?:#[\da-fx]+|[\da-z]+);/gi)) {
    append(raw.slice(cursor, match.index));
    append(match[0]);
    cursor = match.index + match[0].length;
  }
  append(raw.slice(cursor));
  return nodes;
}

function isEscaped(raw: string, index: number): boolean {
  let slashCount = 0;
  while (raw[--index] === "\\") slashCount++;
  return slashCount % 2 === 1;
}

// Shared with dollar protection so filenames cannot be consumed as TeX before
// the Markdown parser and this transformer get to see them.
export function matchWikiLinkAt(source: string, index: number): RegExpExecArray | null {
  if (!source.startsWith("[[", index) || source[index - 1] === "!" || isEscaped(source, index))
    return null;
  const pattern = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/y;
  pattern.lastIndex = index;
  const match = pattern.exec(source);
  if (!match || /\\[\[\]|]/.test(match[0])) return null;
  return match;
}

// mdast omits blockquote/list continuation prefixes from displayed text. Split
// these multiline nodes at source line boundaries before calculating offsets.
function splitContinuationLines(
  node: Text,
  raw: string,
  source: string,
  root: string | undefined,
): RootContent[] | null {
  const rawLines = raw.split("\n");
  const displayLines = node.value.split("\n");
  if (rawLines.length < 2 || rawLines.length !== displayLines.length) return null;
  const parts: RootContent[] = [];
  let point = node.position!.start;
  let changed = false;
  for (let index = 0; index < rawLines.length; index++) {
    const sourceLine = rawLines[index]!;
    const line = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
    const display = displayLines[index]!;
    const decoded = decodeString(line);
    if (!decoded.endsWith(display)) return null;
    const prefixLength = decoded.length - display.length;
    if (!/^[ \t>]*$/.test(line.slice(0, prefixLength))) return null;
    const lineStart = advancePoint(point, line.slice(0, prefixLength));
    const lineEnd = advancePoint(point, line);
    const lineNode: Text = {
      type: "text",
      value: display,
      position: { start: lineStart, end: lineEnd },
    };
    const replacement = splitWikiLinks(lineNode, source, root);
    changed ||= replacement !== null;
    parts.push(...(replacement ?? [lineNode]));
    point = lineEnd;
    if (index < rawLines.length - 1) {
      const end = advancePoint(point, sourceLine.endsWith("\r") ? "\r\n" : "\n");
      parts.push({ type: "text", value: "\n", position: { start: point, end } });
      point = end;
    }
  }
  return changed ? parts : null;
}

function splitWikiLinks(
  node: Text,
  source: string,
  root: string | undefined,
): RootContent[] | null {
  const start = node.position?.start;
  const endOffset = node.position?.end.offset;
  if (start?.offset === undefined || endOffset === undefined || !node.value.includes("[[")) {
    return null;
  }
  const raw = source.slice(start.offset, endOffset);
  // Custom Markdown transforms may have already rewritten this node. Leave it
  // alone when its source no longer describes the displayed text reliably.
  if (decodeString(raw) !== node.value) return splitContinuationLines(node, raw, source, root);
  const parts: RootContent[] = [];
  let cursor = 0;
  let point = start;
  for (let index = raw.indexOf("[["); index !== -1; index = raw.indexOf("[[", index + 2)) {
    const match = matchWikiLinkAt(raw, index);
    if (!match) continue;
    index += match[0].length - 2;
    const target = decodeString(match[1]!).trim();
    // Basic file links only. Heading/block navigation is not implemented by
    // the workspace viewer, so keep that syntax visibly literal.
    if (!target || target.includes("#")) continue;
    if (!isLocalAbsolutePath(target) && /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const path = /\.[^/\\]+$/.test(target) ? target : `${target}.md`;
    if (!root && !isLocalAbsolutePath(path)) continue;
    const absolutePath = isLocalAbsolutePath(path) ? path : joinWorkspaceRelativePath(root!, path);
    const before = raw.slice(cursor, match.index);
    parts.push(...sourceTextNodes(before, point));
    point = advancePoint(point, before);
    const linkEnd = advancePoint(point, match[0]);
    const label = match[2] ?? match[1]!;
    const labelStart = advancePoint(
      point,
      match[0].slice(0, match[2] === undefined ? 2 : match[0].indexOf("|") + 1),
    );
    parts.push({
      type: "link",
      url: markdownFilePathHref(absolutePath),
      children: sourceTextNodes(label, labelStart),
      position: { start: point, end: linkEnd },
    });
    point = linkEnd;
    cursor = match.index + match[0].length;
  }
  if (!parts.length) return null;
  parts.push(...sourceTextNodes(raw.slice(cursor), point));
  return parts;
}

/** Basic Wiki file links use the workspace root; regular links stay file-relative. */
export function remarkWikiLinks(options: { root?: string | undefined } = {}) {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    if (!source.includes("[[")) return;
    function walk(parent: { children: RootContent[] }) {
      let children: RootContent[] | null = null;
      parent.children.forEach((node, index) => {
        let replacement: RootContent[] | null = null;
        if (node.type === "text") {
          replacement = splitWikiLinks(node, source, options.root);
        } else if (
          !["link", "linkReference", "code", "inlineCode", "html"].includes(node.type) &&
          "children" in node
        ) {
          walk(node as { children: RootContent[] });
        }
        if (replacement && !children) children = parent.children.slice(0, index);
        if (children) children.push(...(replacement ?? [node]));
      });
      if (children) parent.children = children;
    }
    walk(tree);
  };
}
