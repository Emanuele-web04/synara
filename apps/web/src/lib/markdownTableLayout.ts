// FILE: markdownTableLayout.ts
// Purpose: Give each column of a rendered markdown table a layout kind so short values
//          (numbers with units, IDs, short labels) keep their width while text columns wrap,
//          and keep a number glued to its unit so "3.1–4.9 s" never splits across lines.
// Layer: Chat markdown rendering (rehype plugin + pure helpers)
// Exports: classifyTableCell, resolveTableColumnKinds, glueTableCellText, extractTableMarkdown,
//          rehypeTableLayout
//
// The browser's own table layout does the sizing; this only tells it which columns may wrap.
// One pass over the cells per parse, no DOM measurement. Column kinds, read by index.css:
//   numeric  every filled cell is a number or range, optionally with a unit: no wrap, end-aligned
//   short    every filled cell is short (≤ 3 words, ≤ 24 characters): no wrap
//   label    a short column in a table without a text column: wraps between words only
//   text     anything longer: takes the remaining width and wraps

export type TableCellKind = "empty" | "numeric" | "short" | "text";
export type TableColumnKind = "numeric" | "short" | "label" | "text";

const SHORT_CELL_MAX_CHARS = 24;
const SHORT_CELL_MAX_WORDS = 3;
// Headers render at 0.86 of the chat size (--text-chat-sm in index.css).
const HEADER_SIZE_RATIO = 0.86;

const EMPTY_CELL = /^(?:[-–—?]|n\/?a)$/i;
const NUMBER = String.raw`[$€£¥]?\d[\d,.']*`;
const UNIT = String.raw`(?:[%×]|[A-Za-zµμ]{1,8}(?:\/[A-Za-zµμ]{1,8})?)`;
// "290 MB", "3.1–4.9 s", "−49%", "~4–6 s (+1 s)", "16 ms/frame", "$12.50", "1,400".
const NUMERIC_CELL = new RegExp(
  String.raw`^\(?[~≈<>≤≥±+\-−]?\s?${NUMBER}\s?${UNIT}?(?:\s?[–—-]\s?~?${NUMBER}\s?${UNIT}?)?\)?(?:\s\([^()]{1,16}\))?$`,
  "u",
);

export function classifyTableCell(text: string): TableCellKind {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length === 0 || EMPTY_CELL.test(value)) return "empty";
  if (NUMERIC_CELL.test(value)) return "numeric";
  if (value.length <= SHORT_CELL_MAX_CHARS && value.split(" ").length <= SHORT_CELL_MAX_WORDS) {
    return "short";
  }
  return "text";
}

export function resolveTableColumnKinds(
  columns: readonly (readonly TableCellKind[])[],
): TableColumnKind[] {
  const kinds = columns.map((cells): TableColumnKind => {
    const filled = cells.filter((kind) => kind !== "empty");
    if (filled.length > 0 && filled.every((kind) => kind === "numeric")) return "numeric";
    return filled.includes("text") ? "text" : "short";
  });
  // Unwrappable short columns are only safe when a text column can give up the width.
  return kinds.includes("text") ? kinds : kinds.map((kind) => (kind === "short" ? "label" : kind));
}

const UNIT_AFTER_NUMBER =
  /(\d) (?=(?:ms|µs|μs|ns|s|sec|min|h|hrs?|d|[kKMGT]i?B|B|px|rem|em|%|x|×|fps|[kMG]?Hz|k|M|tokens?|lines?|files?|messages?|rows?|items?|tests?|chars?)(?![\p{L}\p{N}]))/gu;
const SPACED_RANGE = /(\d) ([–—]) (?=\d)/g;
const WORD_BEFORE_REFERENCE = /(\p{L}) (?=#\d)/gu;

/** Swaps the spaces inside "3.1 s", "2 – 5" and "PR #2156" for no-break spaces. Same length. */
export function glueTableCellText(text: string): string {
  if (!text.includes(" ")) return text;
  return text
    .replace(UNIT_AFTER_NUMBER, "$1 ")
    .replace(SPACED_RANGE, "$1 $2 ")
    .replace(WORD_BEFORE_REFERENCE, "$1 ");
}

/**
 * The table's Markdown as written. A table inside a list or quote repeats the container's
 * indent or `>` on each row after the first. Quote spacing can vary between rows.
 */
export function extractTableMarkdown(
  source: string,
  position: { readonly start: number; readonly end: number; readonly column: number },
): string {
  const prefixWidth = Math.max(0, position.column - 1);
  const firstLineStart = source.lastIndexOf("\n", position.start - 1) + 1;
  const quoteDepth = source.slice(firstLineStart, position.start).match(/>/g)?.length ?? 0;
  const quotePrefix = quoteDepth > 0 ? new RegExp(`^(?:[ \t]*>[ \t]?){1,${quoteDepth}}`) : null;
  return source
    .slice(position.start, position.end)
    .split("\n")
    .map((line, index) => {
      if (index === 0) return line;
      if (quotePrefix) return line.replace(quotePrefix, "");
      const prefix = line.slice(0, prefixWidth);
      return /^[ \t]*$/.test(prefix) ? line.slice(prefixWidth) : line;
    })
    .join("\n")
    .trim();
}

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Text inside these keeps its source spacing; a cell holding them is still classified by it.
const VERBATIM_TAGS = new Set(["code", "pre", "math", "svg"]);

function readCell(node: HastNode, glue: boolean): { text: string; multiline: boolean } {
  let text = "";
  let multiline = false;
  const visit = (current: HastNode, glueText: boolean): void => {
    if (current.type === "text" && typeof current.value === "string") {
      if (glueText) current.value = glueTableCellText(current.value);
      text += current.value;
      return;
    }
    if (current.type !== "element" && current.type !== "root") return;
    if (current.tagName === "br" || current.tagName === "ul" || current.tagName === "ol") {
      multiline = true;
    }
    const childGlue = glueText && !VERBATIM_TAGS.has(current.tagName ?? "");
    for (const child of current.children ?? []) visit(child, childGlue);
  };
  visit(node, glue);
  return { text, multiline };
}

function tableRows(table: HastNode): HastNode[][] {
  const rows: HastNode[][] = [];
  const visit = (node: HastNode): void => {
    for (const child of node.children ?? []) {
      if (child.type !== "element") continue;
      if (child.tagName === "tr") {
        rows.push(
          (child.children ?? []).filter(
            (cell) => cell.type === "element" && (cell.tagName === "td" || cell.tagName === "th"),
          ),
        );
      } else if (
        child.tagName === "thead" ||
        child.tagName === "tbody" ||
        child.tagName === "tfoot"
      ) {
        visit(child);
      }
    }
  };
  visit(table);
  return rows;
}

function layoutTable(table: HastNode, normalizeText?: (value: string) => string): void {
  const rows = tableRows(table);
  const columnCount = rows.reduce((count, row) => Math.max(count, row.length), 0);
  const columns = Array.from({ length: columnCount }, (): TableCellKind[] => []);
  const widestValue = Array.from({ length: columnCount }, () => 0);
  const headers: { cell: HastNode; index: number; length: number; kind: TableCellKind }[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      const { text, multiline } = readCell(cell, true);
      const displayText = normalizeText?.(text) ?? text;
      const kind = multiline ? "text" : classifyTableCell(displayText);
      const length = displayText.trim().length;
      if (cell.tagName === "th") {
        headers.push({ cell, index, length, kind });
        return;
      }
      if (kind === "empty") cell.properties = { ...cell.properties, dataTableCell: "empty" };
      columns[index]?.push(kind);
      widestValue[index] = Math.max(widestValue[index] ?? 0, length);
    });
  }
  // A header wider than its column's values may wrap between words rather than widen the column.
  const wrappingHeaders = new Set(
    headers
      .filter(
        ({ index, length, kind }) =>
          kind === "text" || length * HEADER_SIZE_RATIO > (widestValue[index] ?? 0),
      )
      .map(({ cell }) => cell),
  );
  const kinds = resolveTableColumnKinds(columns);
  for (const row of rows) {
    row.forEach((cell, index) => {
      const kind = kinds[index];
      if (!kind) return;
      cell.properties = { ...cell.properties, dataTableColumn: kind };
      if (wrappingHeaders.has(cell)) cell.properties.dataTableHeader = "wrap";
    });
  }
}

/**
 * Marks every table's cells with `data-table-column`, empty cells with
 * `data-table-cell="empty"`, and headers wider than their values with `data-table-header="wrap"`.
 */
export function rehypeTableLayout(normalizeText?: (value: string) => string) {
  const visit = (node: HastNode): void => {
    if (node.type === "element" && node.tagName === "table") {
      layoutTable(node, normalizeText);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  return (tree: HastNode) => visit(tree);
}
