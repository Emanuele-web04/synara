import type { Blockquote, Parent, Root } from "mdast";

export const GITHUB_ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type GithubAlertKind = (typeof GITHUB_ALERT_KINDS)[number];

// GitHub only recognizes the marker alone on the first line of a blockquote.
const ALERT_MARKER_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

function toGithubAlert(node: Blockquote): void {
  const paragraph = node.children[0];
  if (paragraph?.type !== "paragraph") return;
  const text = paragraph.children[0];
  if (text?.type !== "text") return;
  const match = ALERT_MARKER_PATTERN.exec(text.value);
  if (!match) return;
  // A marker followed by inline content on the same line is not an alert.
  if (
    !match[0].endsWith("\n") &&
    match[0].length === text.value.length &&
    paragraph.children.length > 1
  ) {
    const next = paragraph.children[1];
    if (next?.type !== "break") return;
    paragraph.children.splice(1, 1);
  }

  text.value = text.value.slice(match[0].length);
  // Keep find offsets aligned with the source after dropping the marker.
  const start = text.position?.start;
  if (start && start.offset !== undefined) {
    const removed = match[0];
    const newlineIndex = removed.lastIndexOf("\n");
    text.position!.start = {
      line: start.line + (newlineIndex === -1 ? 0 : 1),
      column: newlineIndex === -1 ? start.column + removed.length : 1,
      offset: start.offset + removed.length,
    };
  }
  if (!text.value) paragraph.children.shift();
  if (paragraph.children.length === 0) node.children.shift();

  node.data = {
    ...node.data,
    hProperties: {
      ...node.data?.hProperties,
      "data-github-alert": match[1]!.toLowerCase(),
    },
  };
}

function visit(node: Parent): void {
  for (const child of node.children) {
    if (child.type === "blockquote") toGithubAlert(child);
    if ("children" in child) visit(child);
  }
}

// Renders GitHub's `> [!NOTE]` blockquote alerts; the marker is left as plain
// text by remark-gfm, so tag the blockquote for the renderer and strip it.
export function remarkGithubAlerts() {
  return (tree: Root) => visit(tree);
}
