// FILE: canvasExportSettings.ts
// Purpose: The export row rules: size strings, suffixes, default and added rows, file
//          names, the pixel budget and combined-PDF page order. Pure, so it is unit tested.
// Layer: Web utility
// Exports: export row helpers used by the inspector, the canvas commands and canvasExport

import type { CanvasExportEntry, CanvasExportFormat } from "@synara/contracts";

export type CanvasExportUnit = "x" | "w" | "h" | "p";
export type CanvasExportQuality = NonNullable<CanvasExportEntry["quality"]>;

/** The Size menu, in its three groups. 1.5x has no preset but can be typed. */
export const EXPORT_SCALE_PRESETS: readonly (readonly string[])[] = [
  ["0.5x", "1x", "2x", "3x", "4x"],
  ["720p", "1080p", "1440p", "2160p"],
  ["512w", "512h"],
];

/** The output is capped at 16000 × 16000 px of area, then at 16000 px per side. */
export const MAX_EXPORT_SIDE = 16_000;
export const MAX_EXPORT_PIXELS = MAX_EXPORT_SIDE * MAX_EXPORT_SIDE;

const SCALE_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)(x|w|h|p|px)?$/;

/**
 * Reads what was typed in the Size field: `2`, `2x`, `512w`, `512px` (a width), `512h` or
 * `1080p` (the shorter side). Widths and heights are whole pixels; zero is refused.
 */
export function parseExportScale(text: string): { scale: string } | { error: "zero" | "invalid" } {
  const match = SCALE_PATTERN.exec(text.trim().toLowerCase().replace(/\s+/g, ""));
  if (!match) return { error: "invalid" };
  const unit = (match[2] === "px" ? "w" : (match[2] ?? "x")) as CanvasExportUnit;
  const value = unit === "x" ? Number(match[1]) : Math.trunc(Number(match[1]));
  if (!Number.isFinite(value)) return { error: "invalid" };
  if (value <= 0) return { error: "zero" };
  return { scale: `${Number(value.toFixed(4))}${unit}` };
}

/** A stored size as a number and unit; anything unreadable or not positive exports at 1x. */
export function readExportScale(scale: string): { value: number; unit: CanvasExportUnit } {
  const parsed = parseExportScale(scale);
  if ("error" in parsed) return { value: 1, unit: "x" };
  const unit = parsed.scale.slice(-1) as CanvasExportUnit;
  return { value: Number(parsed.scale.slice(0, -1)), unit };
}

/** Arrow keys step to the next whole number, or by 0.25 below 1x. */
export function stepExportScale(scale: string, direction: 1 | -1): string {
  const { value, unit } = readExportScale(scale);
  if (unit !== "x") return `${Math.max(1, Math.trunc(value) + direction)}${unit}`;
  const quarter = 0.25;
  const next =
    direction > 0
      ? value < 1
        ? Math.floor(value / quarter) * quarter + quarter
        : Math.floor(value) + 1
      : value <= 1
        ? Math.ceil(value / quarter) * quarter - quarter
        : Math.ceil(value) - 1;
  return `${Math.max(quarter, next)}x`;
}

/** The factor that turns the node's box into the output size, inside the pixel budget. */
export function exportScaleFactor(box: { width: number; height: number }, scale: string): number {
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  const { value, unit } = readExportScale(scale);
  const requested =
    unit === "x"
      ? value
      : unit === "w"
        ? value / width
        : unit === "h"
          ? value / height
          : value / Math.min(width, height);
  const byArea = Math.min(requested, Math.sqrt(MAX_EXPORT_PIXELS / (width * height)));
  return Math.min(byArea, MAX_EXPORT_SIDE / width, MAX_EXPORT_SIDE / height);
}

export function exportOutputSize(box: { width: number; height: number }, scale: string) {
  const factor = exportScaleFactor(box, scale);
  return {
    width: Math.max(1, Math.round(box.width * factor)),
    height: Math.max(1, Math.round(box.height * factor)),
  };
}

export const defaultExportSuffix = (scale: string) => (scale === "1x" ? "" : `@${scale}`);

/** Spaces are trimmed and collapsed in the suffix field. */
export const normalizeExportSuffix = (suffix: string) => suffix.trim().replace(/\s+/g, " ");

/**
 * The suffix after a size change: 1x clears it, an empty suffix leaving 1x gets the new
 * size, and the old size inside a suffix is replaced. A custom suffix survives.
 */
export function suffixAfterScaleChange(previous: string, next: string, suffix: string): string {
  if (next === "1x") return "";
  if (previous === "1x" && suffix === "") return `@${next}`;
  return suffix.includes(previous) ? suffix.replace(previous, next) : suffix;
}

export function withExportScale(entry: CanvasExportEntry, scale: string): CanvasExportEntry {
  if (entry.format === "pdf") return entry;
  return { ...entry, scale, suffix: suffixAfterScaleChange(entry.scale, scale, entry.suffix) };
}

/** PDF rows are always 1x; switching to PDF drops a suffix that only named the size. */
export function withExportFormat(
  entry: CanvasExportEntry,
  format: CanvasExportFormat,
): CanvasExportEntry {
  if (format !== "pdf") {
    const { quality: _quality, ...rest } = entry;
    return { ...rest, format };
  }
  return {
    format,
    scale: "1x",
    suffix: entry.suffix === defaultExportSuffix(entry.scale) ? "" : entry.suffix,
    ...(entry.quality ? { quality: entry.quality } : {}),
  };
}

/** The default row: 2x `@2x` in the preferred format, or 1x for PDF. */
export function defaultExportEntry(format: CanvasExportFormat): CanvasExportEntry {
  return format === "pdf"
    ? { format, scale: "1x", suffix: "" }
    : { format, scale: "2x", suffix: "@2x" };
}

/**
 * Rows after `+`: the first unused of 1x, 2x and 3x (else 3x), in the first row's format,
 * inserted on top, except that 1x under a lone 2x row goes below it.
 */
export function addExportEntry(
  entries: readonly CanvasExportEntry[],
  preferred: CanvasExportFormat,
): CanvasExportEntry[] {
  const first = entries[0];
  if (!first) return [defaultExportEntry(preferred)];
  const used = new Set(entries.map((entry) => entry.scale));
  const scale = ["1x", "2x", "3x"].find((candidate) => !used.has(candidate)) ?? "3x";
  const added =
    first.format === "pdf"
      ? defaultExportEntry("pdf")
      : { format: first.format, scale, suffix: defaultExportSuffix(scale) };
  return entries.length === 1 && first.scale === "2x" && added.scale === "1x"
    ? [first, added]
    : [added, ...entries];
}

const sameEntry = (a: CanvasExportEntry, b: CanvasExportEntry) =>
  a.format === b.format &&
  a.scale === b.scale &&
  a.suffix === b.suffix &&
  (a.quality ?? "high") === (b.quality ?? "high");

export const sameExportEntries = (
  a: readonly CanvasExportEntry[],
  b: readonly CanvasExportEntry[],
) => a.length === b.length && a.every((entry, index) => sameEntry(entry, b[index]!));

/** What the section shows for several nodes: nothing, their shared rows, or "mixed". */
export function exportRowsState(
  lists: readonly (readonly CanvasExportEntry[] | undefined)[],
):
  | { kind: "empty" }
  | { kind: "rows"; entries: readonly CanvasExportEntry[] }
  | { kind: "mixed"; first: readonly CanvasExportEntry[] } {
  const rows = lists.map((list) => list ?? []);
  if (rows.every((list) => list.length === 0)) return { kind: "empty" };
  const [first = []] = rows;
  return rows.every((list) => sameExportEntries(list, first))
    ? { kind: "rows", entries: first }
    : { kind: "mixed", first: rows.find((list) => list.length > 0)! };
}

const EXPORT_LABEL_TEXT_LENGTH = 20;

/** A text layer's export label: its first 20 characters, then an ellipsis. */
export function textExportLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXPORT_LABEL_TEXT_LENGTH
    ? `${flat.slice(0, EXPORT_LABEL_TEXT_LENGTH).trimEnd()}…`
    : flat;
}

export const exportFileExtension = (format: CanvasExportFormat) => format;

/** `<label><suffix>.<ext>`, with leading dots stripped and path separators replaced. */
export function exportFileName(label: string, suffix: string, format: CanvasExportFormat): string {
  const name = [...`${label}${suffix}`]
    .filter((char) => char.charCodeAt(0) > 0x1f && char !== "\u007f")
    .join("")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return `${name || "Export"}.${exportFileExtension(format)}`;
}

const QUALITY_RANK: Record<CanvasExportQuality, number> = { low: 0, medium: 1, high: 2 };

/** A combined PDF uses the best quality set on any of the nodes' PDF rows (default High). */
export function combinedPdfQuality(
  lists: readonly (readonly CanvasExportEntry[] | undefined)[],
): CanvasExportQuality {
  const qualities = lists
    .flatMap((list) => list ?? [])
    .filter((entry) => entry.format === "pdf")
    .map((entry) => entry.quality ?? "high");
  if (qualities.length === 0) return "high";
  return qualities.reduce((best, quality) =>
    QUALITY_RANK[quality] > QUALITY_RANK[best] ? quality : best,
  );
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Combined-PDF page order: rows top to bottom, then left to right. A node joins a row when
 * it overlaps the row's first node vertically by at least 15% of the smaller height.
 */
export function combinedPdfOrder<T extends { box: Box }>(nodes: readonly T[]): T[] {
  const sized = nodes
    .filter((node) => node.box.width > 0 && node.box.height > 0)
    .toSorted((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: T[][] = [];
  for (const node of sized) {
    const row = rows.at(-1);
    const head = row?.[0];
    if (row && head) {
      const overlap =
        Math.min(head.box.y + head.box.height, node.box.y + node.box.height) -
        Math.max(head.box.y, node.box.y);
      if (overlap >= 0.15 * Math.min(head.box.height, node.box.height)) {
        row.push(node);
        continue;
      }
    }
    rows.push([node]);
  }
  return rows.flatMap((row) => row.toSorted((a, b) => a.box.x - b.box.x));
}

/** Scale and encoding for PDF pages; the row's own size is ignored. */
export const PDF_QUALITY_SETTINGS: Record<
  CanvasExportQuality,
  { scale: number; jpegQuality: number | null }
> = {
  high: { scale: 2, jpegQuality: null },
  medium: { scale: 1.5, jpegQuality: 0.8 },
  low: { scale: 1, jpegQuality: 0.6 },
};

const PREFERRED_FORMAT_KEY = "synara:canvas-export-format";
const FORMATS: readonly CanvasExportFormat[] = ["png", "jpg", "webp", "avif", "pdf"];

/** The last format picked, per user, kept in local storage. */
export function preferredExportFormat(): CanvasExportFormat {
  try {
    const stored = localStorage.getItem(PREFERRED_FORMAT_KEY);
    return FORMATS.find((format) => format === stored) ?? "png";
  } catch {
    return "png";
  }
}

export function rememberExportFormat(format: CanvasExportFormat) {
  try {
    localStorage.setItem(PREFERRED_FORMAT_KEY, format);
  } catch {
    // Private windows can refuse storage; the default stays PNG.
  }
}
