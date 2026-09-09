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

function splitWikiLinks(node: Text, source: string, root: string | undefined): RootContent[] | null {
  const start = node.position?.start;
  const endOffset = node.position?.end.offset;
  if (start?.offset === undefined || endOffset === undefined || !node.value.includes("[[")) {
    return null;
  }
  const raw = source.slice(start.offset, endOffset);
  // Custom Markdown transforms may have already rewritten this node. Leave it
  // alone when its source no longer describes the displayed text reliably.
  if (decodeString(raw) !== node.value) return null;
  const parts: RootContent[] = [];
  let cursor = 0;
  let point = start;
  for (const match of raw.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)) {
    if (raw[match.index - 1] === "!" || isEscaped(raw, match.index)) continue;
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
    const labelStart = advancePoint(point, match[0].slice(0, match[2] === undefined ? 2 : match[0].indexOf("|") + 1));
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
        } else if (!["link", "linkReference", "code", "inlineCode", "html"].includes(node.type) && "children" in node) {
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
