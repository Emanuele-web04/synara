// FILE: dither.ts
// Purpose: The backdrop's pixels (ported from HoloBot's packages/ui src/dither.ts and
//          tokens/backdrop.ts, "Dither visibility"): a band where neutral grey dots stand on the
//          page, densest along its bottom row. Each dot is a square of `dot` device pixels;
//          whether a cell is a dot is an 8x8 Bayer threshold against the share wanted at its row,
//          which grows from none at the band's top to `coverage` at its bottom. With an `edge`,
//          the pixels right next to a dot are a darker grey, so the dots read as dots on dark grey
//          rather than as a lighter band. Flat colors only: no blur, no tint, no in-between pixels.
//          Unlike HoloBot's, the pixels between the dots stay transparent, so the band sits on
//          whatever surface the page has (Synara's themes, the route card).
// Layer: SynBot kit
// Exports: DITHER, DitherLook, ditherBand

export const DITHER = {
  /** Grey level of a dot, as a share of white (sRGB): 0.13 is #212121, visible on the near-black
   * without reading as a band. */
  luminance: 0.13,
  /** How far up the dots reach, as a share of the pane's height. */
  fade: 0.4,
  /** Side of a dot in device pixels (drawn 1:1: a canvas pixel is a device pixel). */
  dot: 1,
  /** Share of the Bayer cells that are dots along the bottom edge (more would merge them into a
   * flat band); it falls evenly to none at the top of the fade. */
  coverage: 0.35,
  /** Grey level of the pixels right beside a dot (left, right, above, below), darker than the
   * near-black, so a dot reads as a dot on dark grey rather than as a lighter band; 0.02 is
   * #050505. null: none. */
  edge: 0.02 as number | null,
  /** After a resize, wait this long for the next one before drawing again (ms). */
  settleMs: 120,
} as const;

/** Thresholds of the 8x8 Bayer matrix (0..64). */
const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
] as const;

export interface DitherLook {
  /** A dot's grey level, 0..1 of white. */
  readonly luminance: number;
  /** A dot's side, in device pixels. */
  readonly dot: number;
  /** Share of cells that are dots on the bottom row. */
  readonly coverage: number;
  /** Grey level (0..1 of white) of the pixels beside a dot (left, right, above, below); null:
   * none. */
  readonly edge: number | null;
}

const level = (share: number) => Math.round(Math.min(1, Math.max(0, share)) * 255);

/** RGBA pixels of the band, `width` x `height` device pixels, its bottom row the densest; the
 * pixels that are neither a dot nor a dot's edge are transparent. */
export function ditherBand(width: number, height: number, look: DitherLook): Uint8ClampedArray {
  const dot = Math.max(1, Math.round(look.dot));
  const dots = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const cell = Math.floor(y / dot);
    // The share at the cell's middle row, so every dot is a whole square.
    const share = (Math.min(height, (cell + 0.5) * dot) / height) * look.coverage;
    const thresholds = BAYER[cell % 8]!;
    for (let x = 0; x < width; x++) {
      dots[y * width + x] = (thresholds[Math.floor(x / dot) % 8]! + 0.5) / 64 < share ? 1 : 0;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const grey = level(look.luminance);
  const edge = look.edge === null ? null : level(look.edge);
  /** A dot right next to (x, y): left, right, above or below. */
  const beside = (x: number, y: number, i: number) =>
    (x > 0 && dots[i - 1] === 1) ||
    (x < width - 1 && dots[i + 1] === 1) ||
    (y > 0 && dots[i - width] === 1) ||
    (y < height - 1 && dots[i + width] === 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const value = dots[i] ? grey : edge !== null && beside(x, y, i) ? edge : null;
      if (value === null) continue;
      out[i * 4] = value;
      out[i * 4 + 1] = value;
      out[i * 4 + 2] = value;
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}
