// FILE: theme.logic.colors.ts
// Purpose: Leaf-level RGB color math and hex/rgba formatting primitives for the theme model.
// Layer: Web appearance domain logic
// Exports: RgbColor type, BLACK/WHITE constants, and pure color parse/mix/format helpers.

export type RgbColor = {
  red: number;
  green: number;
  blue: number;
};

export const BLACK: RgbColor = { blue: 0, green: 0, red: 0 };
export const WHITE: RgbColor = { blue: 255, green: 255, red: 255 };

export function parseHexColor(value: string): RgbColor {
  const hexValue = value.slice(1);
  return {
    blue: Number.parseInt(hexValue.slice(4, 6), 16),
    green: Number.parseInt(hexValue.slice(2, 4), 16),
    red: Number.parseInt(hexValue.slice(0, 2), 16),
  };
}

export function mixHex(from: string, to: string, amount: number): string {
  return formatHex(mixRgb(parseHexColor(from), parseHexColor(to), amount));
}

export function mixRgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const clampedAmount = Math.min(1, Math.max(0, amount));
  return {
    blue: mixChannel(from.blue, to.blue, clampedAmount),
    green: mixChannel(from.green, to.green, clampedAmount),
    red: mixChannel(from.red, to.red, clampedAmount),
  };
}

function mixChannel(from: number, to: number, amount: number): number {
  return Math.round(from + (to - from) * amount);
}

export function formatHex(color: RgbColor): string {
  return `#${formatHexChannel(color.red)}${formatHexChannel(color.green)}${formatHexChannel(color.blue)}`;
}

export function formatOpaqueRgb(color: RgbColor): string {
  return `rgb(${color.red}, ${color.green}, ${color.blue})`;
}

export function formatRgba(color: RgbColor, opacity: number): string {
  return `rgba(${color.red}, ${color.green}, ${color.blue}, ${formatAlpha(opacity)})`;
}

function formatHexChannel(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function formatAlpha(value: number): string {
  return Math.min(1, Math.max(0, value)).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
