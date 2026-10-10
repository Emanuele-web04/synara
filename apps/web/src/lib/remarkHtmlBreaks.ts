import type { Parent, Root } from "mdast";

const BREAK_TAG_PATTERN = /^<br\s*\/?>$/i;

function visit(node: Parent): void {
  const isBlockContainer =
    node.type === "root" || node.type === "blockquote" || node.type === "listItem";
  node.children = node.children.flatMap((child) => {
    if (child.type === "html" && BREAK_TAG_PATTERN.test(child.value.trim())) {
      // A `<br>` alone on its line is spacing noise between blocks; inline it
      // is a line break (common inside table cells).
      return isBlockContainer ? [] : [{ type: "break", position: child.position }];
    }
    if ("children" in child) visit(child);
    return [child];
  }) as Parent["children"];
}

// Raw HTML renders as literal text, so models' `<br>` tags would show up as
// `<br>` in the transcript; turn them into Markdown line breaks instead.
export function remarkHtmlBreaks() {
  return (tree: Root) => visit(tree);
}
