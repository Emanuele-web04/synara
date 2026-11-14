import type { Paragraph, PhrasingContent, Root, RootContent } from "mdast";

export const MARKDOWN_IMAGE_ROW_CLASS_NAME = "chat-markdown-image-row";

function isWhitespaceText(node: PhrasingContent): boolean {
  return node.type === "text" && node.value.trim() === "";
}

function isImageNode(node: PhrasingContent): boolean {
  if (node.type === "image" || node.type === "imageReference") return true;
  // A linked image (`[![alt](src)](href)`) is still a picture in the flow.
  if (node.type !== "link" && node.type !== "linkReference") return false;
  const content = node.children.filter((child) => !isWhitespaceText(child));
  return content.length > 0 && content.every(isImageNode);
}

function isImageSeparator(node: PhrasingContent): boolean {
  return isWhitespaceText(node) || node.type === "break";
}

function imageRow(children: PhrasingContent[]): PhrasingContent {
  const first = children[0]?.position;
  const last = children.at(-1)?.position;
  // mdast has no block-in-paragraph node; hast data turns this custom node into
  // a span that the stylesheet lays out as its own line.
  const row = {
    type: "chatImageRow",
    children,
    data: { hName: "span", hProperties: { className: [MARKDOWN_IMAGE_ROW_CLASS_NAME] } },
    ...(first && last ? { position: { start: first.start, end: last.end } } : {}),
  };
  return row as unknown as PhrasingContent;
}

function splitImageRows(paragraph: Paragraph): void {
  const { children } = paragraph;
  const hasImage = children.some(isImageNode);
  const hasProse = children.some((child) => !isImageNode(child) && !isImageSeparator(child));
  // Image-only paragraphs already sit on their own; leave them unchanged.
  if (!hasImage || !hasProse) return;

  const next: PhrasingContent[] = [];
  let index = 0;
  while (index < children.length) {
    const child = children[index]!;
    if (!isImageNode(child)) {
      next.push(child);
      index += 1;
      continue;
    }
    // Images separated only by whitespace or line breaks share one row.
    let end = index + 1;
    let lastImage = index;
    while (
      end < children.length &&
      (isImageNode(children[end]!) || isImageSeparator(children[end]!))
    ) {
      if (isImageNode(children[end]!)) lastImage = end;
      end += 1;
    }
    // A line break next to the row would leave an empty line around it.
    while (next.length > 0 && next.at(-1)!.type === "break") next.pop();
    next.push(imageRow(children.slice(index, lastImage + 1)));
    index = lastImage + 1;
    while (index < children.length && isImageSeparator(children[index]!)) index += 1;
  }
  paragraph.children = next;
}

function visit(node: Root | RootContent): void {
  if (node.type === "paragraph") {
    splitImageRows(node);
    return;
  }
  if ("children" in node) {
    for (const child of node.children) visit(child as RootContent);
  }
}

// Agents often write `Caption:\n![shot](path.png)`; a soft line break keeps the
// image inside the caption's paragraph, so it flowed beside the text like an
// inline glyph. Give each run of images in a prose paragraph its own row.
export function remarkImageRows() {
  return (tree: Root) => visit(tree);
}
