// FILE: InlineVisualTable.tsx
// Purpose: The table block of a native inline visual: hairline rows, tabular numbers,
//          click-to-sort headers, an emphasized row, and long tables folded to ten rows.
// Layer: Chat transcript row content
// Exports: InlineVisualTable

import type { InlineVisualBlock } from "@synara/contracts";

import { ArrowDownIcon, ArrowUpIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  formatVisualNumber,
  sortTableRows,
  useInlineVisualState,
  type TableCell,
  type TableSort,
} from "./inlineVisualBlocks.logic";
import { InlineVisualSurface } from "./InlineVisualSurface";
import { useTranslation } from "~/i18n";

type TableBlock = Extract<InlineVisualBlock, { type: "table" }>;
type ColumnFormat = TableBlock["columns"][number]["format"];

const FOLDED_ROWS = 10;

export function InlineVisualTable({
  block,
  stateKey,
}: {
  readonly block: TableBlock;
  readonly stateKey: string;
}) {
  const { t, formatLocale } = useTranslation();

  const [sort, setSort] = useInlineVisualState<TableSort>(`${stateKey}:sort`, null);
  const [expanded, setExpanded] = useInlineVisualState(`${stateKey}:expanded`, false);
  const rows = sortTableRows(block.rows, sort, formatLocale);
  const foldable = rows.length > FOLDED_ROWS + 2;
  const shown = foldable && !expanded ? rows.slice(0, FOLDED_ROWS) : rows;
  // Numeric columns right-align: declared, or every non-empty cell is a number.
  const numeric = block.columns.map(
    (column, index) =>
      column.format === "number" ||
      column.format === "percent" ||
      (column.format === undefined &&
        block.rows.every((row) => row[index] === null || typeof row[index] === "number")),
  );
  const toggleSort = (column: number) =>
    setSort((previous) =>
      previous?.column !== column
        ? { column, direction: numeric[column] ? "desc" : "asc" }
        : previous.direction === (numeric[column] ? "desc" : "asc")
          ? { column, direction: numeric[column] ? "asc" : "desc" }
          : null,
    );

  return (
    <InlineVisualSurface title={block.title} className="pb-1.5">
      <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full border-collapse text-chat-sm tabular-nums">
          <thead>
            <tr>
              {block.columns.map((column, index) => {
                const active = sort?.column === index ? sort.direction : null;
                return (
                  <th
                    key={`${column.label}:${index}`}
                    scope="col"
                    aria-sort={
                      active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined
                    }
                    className={cn(
                      "border-b border-[var(--rule)] p-0 pb-2 font-medium text-muted-foreground",
                      numeric[index] ? "text-right" : "text-left",
                      index > 0 && "ps-4",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(index)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-0 whitespace-nowrap hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--ring)]",
                        numeric[index] && "flex-row-reverse",
                        active && "text-foreground",
                      )}
                    >
                      {column.label}
                      {active === "asc" ? (
                        <ArrowUpIcon className="size-3" aria-hidden />
                      ) : active === "desc" ? (
                        <ArrowDownIcon className="size-3" aria-hidden />
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr
                key={row.index}
                className={cn(
                  "border-b border-[var(--rule)] last:border-b-0",
                  row.index === block.highlightRow &&
                    "bg-[color:color-mix(in_srgb,var(--chart-accent)_8%,transparent)] font-medium",
                )}
              >
                {block.columns.map((column, index) => (
                  <td
                    key={index}
                    className={cn(
                      "py-2 align-top",
                      index > 0 && "ps-4",
                      numeric[index] ? "text-right whitespace-nowrap" : "text-left",
                      index === 0 ? "text-foreground" : "text-foreground/90",
                    )}
                  >
                    {formatCell(row.cells[index] ?? null, column.format, formatLocale)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {foldable ? (
        <div className="-mx-4 border-t border-[var(--rule)] px-4 pt-1.5">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="rounded text-chat-sm text-muted-foreground hover:text-foreground"
          >
            {expanded
              ? t("Show fewer rows")
              : t("Show all {{value0}} rows", { value0: rows.length })}
          </button>
        </div>
      ) : null}
    </InlineVisualSurface>
  );
}

function formatCell(cell: TableCell, format: ColumnFormat, formatLocale: string): string {
  if (cell === null) return "—";
  if (typeof cell === "string") return cell;
  return format === "percent"
    ? formatVisualNumber(cell, { unit: "%" }, formatLocale)
    : formatVisualNumber(cell, {}, formatLocale);
}
