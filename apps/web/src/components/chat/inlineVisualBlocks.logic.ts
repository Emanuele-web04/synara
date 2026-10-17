// FILE: inlineVisualBlocks.logic.ts
// Purpose: Pure helpers for the native inline visual blocks: spec decoding, number formatting,
//          chart axis ticks, table sorting, and reader state that survives a row remount.
// Layer: Chat transcript row logic
// Exports: decodeInlineVisualSpec, formatVisualNumber, niceAxisTicks, sortTableRows,
//          useInlineVisualState

import { InlineVisualSpec } from "@synara/contracts";
import { Schema } from "effect";
import { useCallback, useState } from "react";

const decodeSpec = Schema.decodeUnknownOption(Schema.fromJsonString(InlineVisualSpec));

/** The stored spec, or null when it no longer decodes (a newer server's block type). */
export function decodeInlineVisualSpec(source: string): InlineVisualSpec | null {
  const decoded = decodeSpec(source);
  return decoded._tag === "Some" ? decoded.value : null;
}

const formatters = new Map<string, Intl.NumberFormat>();
function numberFormat(minimumFractionDigits: number, maximumFractionDigits: number) {
  const key = `${minimumFractionDigits}:${maximumFractionDigits}`;
  let format = formatters.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(undefined, { minimumFractionDigits, maximumFractionDigits });
    formatters.set(key, format);
  }
  return format;
}

/**
 * Grouped, locale-aware figures. Without explicit decimals, whole numbers stay
 * whole and fractions keep up to two places (more for values under one).
 */
export function formatVisualNumber(
  value: number,
  options: {
    readonly decimals?: number | undefined;
    readonly prefix?: string | undefined;
    readonly unit?: string | undefined;
  } = {},
): string {
  if (!Number.isFinite(value)) return "—";
  const maximum = options.decimals ?? (Number.isInteger(value) ? 0 : Math.abs(value) < 1 ? 4 : 2);
  const minimum = options.decimals ?? 0;
  const sign = value < 0 ? "-" : "";
  const digits = numberFormat(minimum, maximum).format(Math.abs(value));
  const unit = options.unit ? (options.unit === "%" ? "%" : ` ${options.unit}`) : "";
  return `${sign}${options.prefix ?? ""}${digits}${unit}`;
}

/** Rounded axis ticks (1, 2, 2.5, 5 x 10^n) covering min..max, always including zero for bars. */
export function niceAxisTicks(min: number, max: number, targetCount = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  const rough = (max - min) / Math.max(1, targetCount);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ??
    10 * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
    if (ticks.length > 20) break;
  }
  if (ticks[ticks.length - 1]! < max)
    ticks.push(Number((start + step * ticks.length).toPrecision(12)));
  return ticks;
}

export type TableCell = string | number | null;
export type TableSort = { readonly column: number; readonly direction: "asc" | "desc" } | null;

/** Numbers sort numerically, text by locale, and empty cells always last. */
export function sortTableRows(
  rows: ReadonlyArray<ReadonlyArray<TableCell>>,
  sort: TableSort,
): ReadonlyArray<{ readonly index: number; readonly cells: ReadonlyArray<TableCell> }> {
  const indexed = rows.map((cells, index) => ({ index, cells }));
  if (sort === null) return indexed;
  const direction = sort.direction === "asc" ? 1 : -1;
  return indexed.toSorted((left, right) => {
    const a = left.cells[sort.column] ?? null;
    const b = right.cells[sort.column] ?? null;
    if (a === null || b === null) return a === b ? left.index - right.index : a === null ? 1 : -1;
    const order =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true });
    return order === 0 ? left.index - right.index : order * direction;
  });
}

// Reader choices (tab, ticks, inputs, sort) by visual and block. The list can
// unmount a row that scrolls away; the reader expects the visual unchanged when
// it comes back. Bounded: the oldest entries go first.
const READER_STATE_MAX = 2_000;
const readerState = new Map<string, unknown>();

export function useInlineVisualState<T>(
  key: string,
  initial: T | (() => T),
): readonly [T, (next: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() =>
    readerState.has(key)
      ? (readerState.get(key) as T)
      : typeof initial === "function"
        ? (initial as () => T)()
        : initial,
  );
  const update = useCallback(
    (next: T | ((previous: T) => T)) => {
      setValue((previous) => {
        const resolved = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
        readerState.delete(key);
        readerState.set(key, resolved);
        while (readerState.size > READER_STATE_MAX) {
          readerState.delete(readerState.keys().next().value!);
        }
        return resolved;
      });
    },
    [key],
  );
  return [value, update] as const;
}
