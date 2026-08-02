// FILE: elementInspection.ts
// Purpose: Turns computed DOM styles into the compact readout shown by the annotation inspector card.
// Layer: Desktop browser annotation guest
// Depends on: nothing — pure formatting shared by the guest preload and its unit tests.

export interface ElementStyleSnapshot {
  readonly color: string;
  readonly backgroundColor: string;
  readonly fontWeight: string;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly fontFamily: string;
  /** Top, right, bottom, left computed lengths. */
  readonly padding: readonly [string, string, string, string];
  readonly margin: readonly [string, string, string, string];
  /** Top-left, top-right, bottom-right, bottom-left computed radii. */
  readonly radius: readonly [string, string, string, string];
}

export interface InspectorRow {
  readonly label: string;
  readonly value: string;
}

export interface InspectorCard {
  readonly tag: string;
  readonly size: string;
  readonly rows: readonly InspectorRow[];
}

const HEX_DIGITS = 16;

function formatLength(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric) || !/^-?[\d.]+px$/.test(trimmed)) return trimmed;
  const rounded = Math.round(numeric * 100) / 100;
  return rounded === 0 ? "0" : `${rounded}px`;
}

function hexChannel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(HEX_DIGITS)
    .padStart(2, "0");
}

/**
 * Renders a computed color as the short hex form designers recognise, keeping
 * alpha as an explicit percentage so translucent surfaces stay readable.
 */
export function formatCssColor(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^rgba?\(([^)]*)\)$/i.exec(trimmed);
  if (!match?.[1]) return trimmed;
  // Channels are percentages of 255, alpha is a fraction of 1.
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter((part) => part.length > 0)
    .map((part, index) => {
      const numeric = Number.parseFloat(part);
      if (!part.endsWith("%")) return numeric;
      return index < 3 ? (numeric * 255) / 100 : numeric / 100;
    });
  const [red, green, blue, alpha] = parts;
  if (red === undefined || green === undefined || blue === undefined) return trimmed;
  if (![red, green, blue].every((channel) => Number.isFinite(channel))) return trimmed;
  const opacity = alpha === undefined || !Number.isFinite(alpha) ? 1 : alpha;
  if (opacity <= 0) return "transparent";
  const hex = `#${hexChannel(red)}${hexChannel(green)}${hexChannel(blue)}`;
  return opacity >= 1 ? hex : `${hex} ${Math.round(opacity * 100)}%`;
}

/**
 * Collapses four computed edge lengths into CSS shorthand, or `null` when the
 * box contributes nothing worth showing.
 */
export function formatCssBox(values: readonly [string, string, string, string]): string | null {
  const [top = "0", right = "0", bottom = "0", left = "0"] = values.map(
    (value) => formatLength(value) ?? "0",
  );
  if (top === "0" && right === "0" && bottom === "0" && left === "0") return null;
  if (top === right && right === bottom && bottom === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  if (right === left) return `${top} ${right} ${bottom}`;
  return `${top} ${right} ${bottom} ${left}`;
}

/** Renders the computed font the way a CSS `font` shorthand reads. */
export function formatCssFont(snapshot: ElementStyleSnapshot): string {
  const weight =
    snapshot.fontWeight === "400" || snapshot.fontWeight === "normal"
      ? ""
      : `${snapshot.fontWeight.trim()} `;
  const size = formatLength(snapshot.fontSize) ?? snapshot.fontSize.trim();
  const lineHeight = formatLength(snapshot.lineHeight);
  const metrics =
    lineHeight && snapshot.lineHeight.trim().endsWith("px") ? `${size}/${lineHeight}` : size;
  const family = snapshot.fontFamily.trim();
  return family.length > 0 ? `${weight}${metrics} ${family}` : `${weight}${metrics}`;
}

/** Element box size, rounded the way design tools report it. */
export function formatElementSize(width: number, height: number): string {
  return `${Math.round(width)}×${Math.round(height)}`;
}

/**
 * Builds the hover readout: identity and size in the header, then only the
 * properties that actually carry information for the hovered element.
 */
export function inspectorCardFor(input: {
  readonly tagName: string;
  readonly width: number;
  readonly height: number;
  readonly style: ElementStyleSnapshot;
}): InspectorCard {
  const rows: InspectorRow[] = [];
  const color = formatCssColor(input.style.color);
  if (color && color !== "transparent") rows.push({ label: "color", value: color });
  const background = formatCssColor(input.style.backgroundColor);
  if (background && background !== "transparent") rows.push({ label: "bg", value: background });
  rows.push({ label: "font", value: formatCssFont(input.style) });
  const padding = formatCssBox(input.style.padding);
  if (padding) rows.push({ label: "padding", value: padding });
  const margin = formatCssBox(input.style.margin);
  if (margin) rows.push({ label: "margin", value: margin });
  const radius = formatCssBox(input.style.radius);
  if (radius) rows.push({ label: "radius", value: radius });
  return {
    tag: input.tagName.toLowerCase(),
    size: formatElementSize(input.width, input.height),
    rows,
  };
}
