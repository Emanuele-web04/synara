// FILE: EmptyChatBackdrop.tsx
// Purpose: Dithered backdrop behind the empty chat landing, in fine accent dots: the
//          onboarding's temple scene (still), or soft drifting gradient waves. Clicks on
//          empty space send a ripple.
// Layer: Web UI decoration (aria-hidden, pointer-events none, hidden for forced colors and
//        high contrast, ripples off under reduced motion)
// Depends on: the active theme's accent color and variant; landing elements marked
//             `data-empty-chat-backdrop-quiet` get a clear zone behind them.

import { useEffect, useRef } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useTheme } from "~/hooks/useTheme";

// One canvas pixel per dot cell; the GPU scales it up and a dot mask cuts it into dots
// (radius per theme in SCENE_LEVELS).
const CELL_PX = 2;
// The temple scene the onboarding landscape is drawn from, dithered by its brightness.
const SCENE_SRC = "/chat/empty-chat-scene.jpg";
const SCENE_MIN_WIDTH_PX = 1600;
const SCENE_ASPECT = 9 / 16;
// Softens the source's own dot pattern so it does not beat against the dither grid.
const SCENE_BLUR_CELLS = 0.6;
// Levels, per theme. Dots follow the scene's tone: below LOW leaves no dots, above
// HIGH is full, and MAX caps coverage so the brightest areas keep some air. The scene fades
// in between FADEFROM and FADE (shares of its height); below THINFROM (share of the pane
// height) density eases down to THINTO at the bottom. DOT is the dot radius in px. INVERT
// inks darkness instead of brightness; BLUR softens the source (cells); SHARPEN is the
// unsharp-mask amount against a wide blur, which outlines shapes.
const SHARPEN_RADIUS_CELLS = 4;
// Light-mode temple: fade the top in by dot opacity, not dot count, so the sky blends into
// the page with no band (thinning would leave stray dots that the cleanup removes).
// Light temple: how far the dot colour moves toward white, and the paper wash strength
// (percent of the accent) behind the dots.
const LIGHT_INK_SOFTEN = 0.28;
const LIGHT_PAPER_PERCENT = 9;
const LIGHT_SKY_MASK = "linear-gradient(to bottom, transparent 0%, #000 42%)";
// Less ink in the quiet zones and softer dots elsewhere keep the whole scene readable.
const DARK_TEMPLE_OPACITY = 0.35;
const DIMMED_QUIET_FLOOR = 0.6;
// The sunlit ground just below the temple outshines the rest; ease it down slightly.
// [x, y] in pane fractions, [rx, ry] radii in pane fractions, and how much to remove.
const GROUND_DIM = { x: 0.55, y: 0.6, rx: 0.16, ry: 0.07, amount: 0.18 } as const;
const SCENE_LEVELS = {
  dark: {
    low: 0.14,
    high: 0.9,
    max: 0.85,
    fadeFrom: 0,
    fade: 0.12,
    thinFrom: 1,
    thinTo: 1,
    dot: 0.8,
    invert: false,
    blur: SCENE_BLUR_CELLS,
    sharpen: 0,
    sharpenFrom: 0,
    sharpenTo: 0,
    thinRight: 0,
    quietFloor: 0.3,
  },
  // Light inks the shadows, like print. An unsharp mask outlines the columns, roof and
  // hills, and a steep curve keeps the ink crisp.
  light: {
    low: 0.6,
    high: 0.8,
    max: 1,
    // The inverted sky inks heavily; the canvas mask fades it in (see LIGHT_SKY_MASK).
    fadeFrom: 0,
    fade: 0.12,
    thinFrom: 0.7,
    thinTo: 0.7,
    dot: 1,
    invert: true,
    blur: 0.3,
    sharpen: 1.6,
    // The sky keeps no sharpening (its texture turns to noise); it ramps in above the roof.
    sharpenFrom: 0.24,
    sharpenTo: 0.36,
    // Extra thinning toward the bottom-right corner, where the hills are darkest.
    thinRight: 0.45,
    quietFloor: DIMMED_QUIET_FLOOR,
  },
} as const;
// Dark Temple quiets the full tray so the scene recedes beneath its translucent surface.
const QUIET_TEXT_SELECTOR = "[data-empty-chat-backdrop-quiet]";
const DARK_TEMPLE_QUIET_SELECTOR = `${QUIET_TEXT_SELECTOR}, [data-composer-tray]`;
const QUIET_SELECTOR = `${QUIET_TEXT_SELECTOR}, [data-empty-landing-controls]`;
const QUIET_PADDING_PX = 12;
const QUIET_FEATHER_PX = 72;
const RIPPLE_SPEED_PX_PER_MS = 0.5;
const RIPPLE_BAND_PX = 26;
const RIPPLE_LIFETIME_MS = 2400;
const RIPPLE_WOBBLE_PX = 22;
const RIPPLE_STRENGTH = 0.7;
// Dark mode: the ring's crest adds dots lit toward white, and a trough follows it.
// Light mode: the crest clears dots instead (a pale ring cut through the ink), since darker
// dots on an already dense field read as a smudge.
const RIPPLE_HIGHLIGHT_MIX = 0.6;
const RIPPLE_TROUGH_STRENGTH = 0.6;
const RIPPLE_TROUGH_LAG_PX = 30;
// Cells farther than this from a ring's radius are untouched by it.
const RIPPLE_REACH_PX = RIPPLE_BAND_PX * 2.5 + RIPPLE_WOBBLE_PX + RIPPLE_TROUGH_LAG_PX;
const MAX_RIPPLES = 4;
// Below this ripple contribution a cell shows the still picture's dot.
const RIPPLE_SETTLED = 0.04;
// A dot with no other dot within this many cells counts as stray and is dropped.
const STRAY_RADIUS_CELLS = 2;
const RIPPLE_FRAME_INTERVAL_MS = 1000 / 40;
// Decoration must never compete with opening a thread: build the field in an idle slot.
const START_DELAY_MS = 400;
const IDLE_TIMEOUT_MS = 1500;
// Clicks on controls and text keep their own meaning and do not ripple.
const INTERACTIVE_SELECTOR =
  "a,button,input,textarea,select,label,[contenteditable='true'],[role='button'],[role='combobox'],[role='menuitem'],[role='option'],[role='textbox'],[role='dialog'],[role='menu'],[role='listbox']";
// A press that travels farther than this is a drag (e.g. selecting text), not a click.
const CLICK_SLOP_PX = 4;

// Classic 8x8 ordered-dither (Bayer) matrix as 0..255 thresholds.
const BAYER_8 = Uint8Array.from(
  [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
    7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ],
  (value) => Math.round(((value + 0.5) / 64) * 255),
);

interface Ripple {
  x: number;
  y: number;
  startMs: number;
  // Random phases so every ripple wobbles differently.
  phaseA: number;
  phaseB: number;
}

// Cell rectangle, inclusive start and exclusive end.
interface CellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface GradientField {
  // Static part per cell: the top glow, its falloff and the quiet zones, 0..1.
  base: Float32Array;
  // Rows below this hold no glow, so frames skip them.
  activeRows: number;
  // Motion sampled on a coarse lattice each frame and interpolated per cell.
  lattice: Float32Array;
  latticeCols: number;
  latticeRows: number;
}

interface Field {
  cols: number;
  rows: number;
  // Dot density per cell, 0..255 (rewritten every frame for the moving gradient).
  density: Uint8Array;
  // The still picture's dots (1 = on); null draws the ordered dither from `density` live.
  dots: Uint8Array | null;
  // Dots fade in opacity with their density (the gradient's soft edge).
  fadeOpacity: boolean;
  gradient: GradientField | null;
  image: ImageData;
}

// Run work in an idle slot (setTimeout where requestIdleCallback is missing); returns a cancel.
function scheduleIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  return image.decode().then(
    () => image,
    () => null,
  );
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function parseHexColor(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  if (Number.isNaN(value)) return [51, 156, 255];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function unionRect(a: CellRect, b: CellRect): CellRect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

// Content boxes of the marked landing elements, in container coordinates.
function measureQuietZones(host: Element, origin: DOMRect, selector: string): DOMRect[] {
  const zones: DOMRect[] = [];
  for (const element of host.querySelectorAll(selector)) {
    // Union of the children, so a wide wrapper only clears what it actually shows.
    const parts = element.children.length > 0 ? Array.from(element.children) : [element];
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const part of parts) {
      const rect = part.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    if (right > left && bottom > top) {
      zones.push(new DOMRect(left - origin.left, top - origin.top, right - left, bottom - top));
    }
  }
  return zones;
}

// FLOOR inside a padded zone, rising to 1 across the feather.
function quietFactor(x: number, y: number, zones: readonly DOMRect[], floor: number): number {
  let factor = 1;
  for (const zone of zones) {
    const dx = Math.max(zone.left - QUIET_PADDING_PX - x, 0, x - zone.right - QUIET_PADDING_PX);
    const dy = Math.max(zone.top - QUIET_PADDING_PX - y, 0, y - zone.bottom - QUIET_PADDING_PX);
    factor = Math.min(factor, smoothstep(0, QUIET_FEATHER_PX, Math.hypot(dx, dy)));
  }
  return floor + (1 - floor) * factor;
}

// Dot density per cell (0..255), from the scene's brightness (darkness when inverted).
function buildDensity(
  scene: HTMLImageElement,
  cols: number,
  rows: number,
  isDark: boolean,
  zones: readonly DOMRect[],
): Uint8Array | null {
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const width = cols * CELL_PX;
  const height = rows * CELL_PX;
  // Cover the pane: tall panes scale the scene up so it never ends below the top edge.
  const sceneWidth = Math.max(width, SCENE_MIN_WIDTH_PX, height / SCENE_ASPECT);
  const sceneHeight = sceneWidth * SCENE_ASPECT;
  const left = (width - sceneWidth) / 2;
  const top = height - sceneHeight;
  const levels = isDark ? SCENE_LEVELS.dark : SCENE_LEVELS.light;
  const draw = (blurCells: number) => {
    ctx.clearRect(0, 0, cols, rows);
    ctx.filter = `blur(${blurCells}px)`;
    ctx.drawImage(
      scene,
      left / CELL_PX,
      top / CELL_PX,
      sceneWidth / CELL_PX,
      sceneHeight / CELL_PX,
    );
    return ctx.getImageData(0, 0, cols, rows).data;
  };
  ctx.imageSmoothingQuality = "high";
  const pixels = draw(levels.blur);
  const wide = levels.sharpen > 0 ? draw(SHARPEN_RADIUS_CELLS) : null;
  // Release the scratch backing store right away.
  canvas.width = 0;
  canvas.height = 0;
  const density = new Uint8Array(cols * rows);
  const fadeStart = top + sceneHeight * levels.fadeFrom;
  const fadeEnd = top + sceneHeight * levels.fade;
  for (let row = 0; row < rows; row += 1) {
    const y = row * CELL_PX + CELL_PX / 2;
    const thin = 1 - (1 - levels.thinTo) * smoothstep(height * levels.thinFrom, height, y);
    // The darkest hills sit in the lower half; thin them from the middle down.
    const rowBottom = smoothstep(height * 0.45, height * 0.8, y);
    const sharpen =
      levels.sharpen *
      smoothstep(top + sceneHeight * levels.sharpenFrom, top + sceneHeight * levels.sharpenTo, y);
    const fade = smoothstep(fadeStart, fadeEnd, y) * thin;
    if (fade === 0) continue;
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const base = index * 4;
      if (pixels[base + 3] === 0) continue;
      let luminance =
        (0.2126 * pixels[base]! + 0.7152 * pixels[base + 1]! + 0.0722 * pixels[base + 2]!) / 255;
      if (wide) {
        const around =
          (0.2126 * wide[base]! + 0.7152 * wide[base + 1]! + 0.0722 * wide[base + 2]!) / 255;
        luminance += sharpen * (luminance - around);
      }
      const tone = smoothstep(levels.low, levels.high, levels.invert ? 1 - luminance : luminance);
      if (tone === 0) continue;
      const right =
        levels.thinRight > 0
          ? 1 - levels.thinRight * rowBottom * smoothstep(width * 0.35, width * 0.85, col * CELL_PX)
          : 1;
      const gx = (col * CELL_PX - width * GROUND_DIM.x) / (width * GROUND_DIM.rx);
      const gy = (y - height * GROUND_DIM.y) / (height * GROUND_DIM.ry);
      const ground = 1 - GROUND_DIM.amount * Math.exp(-(gx * gx + gy * gy));
      const quiet = zones.length > 0 ? quietFactor(col * CELL_PX, y, zones, levels.quietFloor) : 1;
      density[index] = Math.round(255 * levels.max * tone * fade * quiet * right * ground);
    }
  }
  return density;
}

// Gradient style: a soft accent glow along the top that fades into the background, broken
// into gentle patches by smooth value noise, with soft wave bands rolling through it. No
// shape. It moves like the old ASCII field: patches drift and the bands travel.
const GRADIENT_BLOBS = [
  { x: 0.15, y: -0.05, radius: 0.45, strength: 0.9 },
  { x: 0.6, y: 0, radius: 0.4, strength: 0.75 },
  { x: 1, y: 0.15, radius: 0.32, strength: 0.6 },
] as const;
const GRADIENT_PATCH_PX = 260;
const GRADIENT_DETAIL_PX = 110;
// How much the noise breaks up the glow: 0 is a smooth glow, 1 is hard patches.
const GRADIENT_PATCHINESS = 0.85;
// Below this share of the pane height there is nothing.
const GRADIENT_FLOOR_Y = 0.6;
const GRADIENT_MAX_DENSITY = 0.62;
// Faintest dot opacity at the fringe of the glow.
const GRADIENT_MIN_OPACITY = 0.2;
// Peak strength of the haze behind the dots, in percent of the accent.
const GRADIENT_HAZE_PERCENT = 18;
// Fixed seed: the pattern stays the same across resizes and reloads.
const GRADIENT_SEED = 17;
// The noise lattice is rotated so patches never line up with the dot grid.
const GRADIENT_COS = Math.cos(0.6);
const GRADIENT_SIN = Math.sin(0.6);
// Motion, in noise cells per second for the drifts and radians per second for the bands.
const GRADIENT_PATCH_DRIFT = { x: 0.035, y: -0.02 } as const;
const GRADIENT_DETAIL_DRIFT = { x: -0.06, y: 0.03 } as const;
const GRADIENT_WAVE_LENGTH_PX = 95;
const GRADIENT_WAVE_SPEED = 0.55;
// How deep the bands cut into the glow (0 = no bands).
const GRADIENT_WAVE_DEPTH = 0.38;
// The motion is sampled every N cells and interpolated between; patches are far larger.
const GRADIENT_LATTICE_CELLS = 6;
// Redraw cadence: slower once input stops, like the old ASCII field.
const GRADIENT_FRAME_INTERVAL_MS = 1000 / 15;
const GRADIENT_IDLE_FRAME_INTERVAL_MS = 1000 / 6;
const INPUT_IDLE_AFTER_MS = 5000;

function hash2(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + GRADIENT_SEED) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smooth 2D value noise in [0, 1).
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(0, 1, x - x0);
  const fy = smoothstep(0, 1, y - y0);
  const top = hash2(x0, y0) + (hash2(x0 + 1, y0) - hash2(x0, y0)) * fx;
  const bottom = hash2(x0, y0 + 1) + (hash2(x0 + 1, y0 + 1) - hash2(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}

// The gradient's static part: glow from the blobs, the vertical falloff and the quiet zones.
function buildGradientField(
  cols: number,
  rows: number,
  zones: readonly DOMRect[],
  quietFloor: number,
): GradientField {
  const width = cols * CELL_PX;
  const height = rows * CELL_PX;
  // The glow uses squared distance, so scale the falloff once per blob.
  const diagonalSquared = width * width + height * height;
  const blobs = GRADIENT_BLOBS.map((blob) => ({
    x: blob.x * width,
    y: blob.y * height,
    decay: -1.6 / (blob.radius * blob.radius * diagonalSquared),
    strength: blob.strength,
  }));
  const base = new Float32Array(cols * rows);
  let activeRows = 0;
  for (let row = 0; row < rows; row += 1) {
    const y = row * CELL_PX + CELL_PX / 2;
    const falloff = 1 - smoothstep(0, height * GRADIENT_FLOOR_Y, y);
    if (falloff === 0) break;
    activeRows = row + 1;
    for (let col = 0; col < cols; col += 1) {
      const x = col * CELL_PX + CELL_PX / 2;
      let glow = 0;
      for (const blob of blobs) {
        const dx = x - blob.x;
        const dy = y - blob.y;
        glow += blob.strength * Math.exp((dx * dx + dy * dy) * blob.decay);
      }
      const quiet = zones.length > 0 ? quietFactor(x, y, zones, quietFloor) : 1;
      base[row * cols + col] = Math.min(1, glow) * falloff * quiet;
    }
  }
  const latticeCols = Math.ceil(cols / GRADIENT_LATTICE_CELLS) + 1;
  const latticeRows = Math.ceil(activeRows / GRADIENT_LATTICE_CELLS) + 1;
  return {
    base,
    activeRows,
    lattice: new Float32Array(latticeCols * latticeRows),
    latticeCols,
    latticeRows,
  };
}

// Writes the gradient's density for time `seconds`: drifting patches times rolling bands.
function writeGradientDensity(field: Field, gradient: GradientField, seconds: number) {
  const { cols, density } = field;
  const { base, activeRows, lattice, latticeCols, latticeRows } = gradient;
  const step = GRADIENT_LATTICE_CELLS;
  const patchDx = seconds * GRADIENT_PATCH_DRIFT.x;
  const patchDy = seconds * GRADIENT_PATCH_DRIFT.y;
  const detailDx = seconds * GRADIENT_DETAIL_DRIFT.x;
  const detailDy = seconds * GRADIENT_DETAIL_DRIFT.y;
  const wavePhase = seconds * GRADIENT_WAVE_SPEED;
  for (let ly = 0; ly < latticeRows; ly += 1) {
    const y = ly * step * CELL_PX;
    for (let lx = 0; lx < latticeCols; lx += 1) {
      const x = lx * step * CELL_PX;
      const u = x * GRADIENT_COS - y * GRADIENT_SIN;
      const v = x * GRADIENT_SIN + y * GRADIENT_COS;
      const noise =
        0.65 * valueNoise(u / GRADIENT_PATCH_PX + patchDx, v / GRADIENT_PATCH_PX + patchDy) +
        0.35 *
          valueNoise(u / GRADIENT_DETAIL_PX + 31 + detailDx, v / GRADIENT_DETAIL_PX + 7 + detailDy);
      const patch = 1 - GRADIENT_PATCHINESS + GRADIENT_PATCHINESS * smoothstep(0.3, 0.72, noise);
      const band = 0.5 + 0.5 * Math.sin(u / GRADIENT_WAVE_LENGTH_PX - wavePhase + noise * 4);
      lattice[ly * latticeCols + lx] =
        patch * (1 - GRADIENT_WAVE_DEPTH + GRADIENT_WAVE_DEPTH * band);
    }
  }
  for (let row = 0; row < activeRows; row += 1) {
    const ly = Math.floor(row / step);
    const fy = (row - ly * step) / step;
    const top = ly * latticeCols;
    const bottom = Math.min(ly + 1, latticeRows - 1) * latticeCols;
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const level = base[index]!;
      if (level === 0) {
        density[index] = 0;
        continue;
      }
      const lx = Math.floor(col / step);
      const fx = (col - lx * step) / step;
      const lx1 = Math.min(lx + 1, latticeCols - 1);
      const upper = lattice[top + lx]! + (lattice[top + lx1]! - lattice[top + lx]!) * fx;
      const lower = lattice[bottom + lx]! + (lattice[bottom + lx1]! - lattice[bottom + lx]!) * fx;
      const motion = upper + (lower - upper) * fy;
      density[index] = Math.round(255 * GRADIENT_MAX_DENSITY * level * motion);
    }
  }
}

// Dot opacity for a density: faint where few dots remain, full where the glow is strongest.
function fadeOpacityFor(density: number): number {
  const level = Math.min(1, density / (255 * GRADIENT_MAX_DENSITY));
  return Math.round(255 * (GRADIENT_MIN_OPACITY + (1 - GRADIENT_MIN_OPACITY) * level));
}

// The soft accent haze behind the gradient dots, from the same blobs as the glow.
function gradientHaze(accent: string): string {
  return GRADIENT_BLOBS.map(
    (blob) =>
      `radial-gradient(${blob.radius * 140}% ${blob.radius * 120}% at ${blob.x * 100}% ${blob.y * 100}%, color-mix(in oklab, ${accent} ${Math.round(GRADIENT_HAZE_PERCENT * blob.strength)}%, transparent), transparent 70%)`,
  ).join(", ");
}

// The still picture's dots: the ordered dither, minus stray dots with no other dot within
// two cells, so faint haze no longer peppers the scene and shapes keep clean edges.
function ditherDots(density: Uint8Array, cols: number, rows: number): Uint8Array {
  const dots = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      dots[index] = density[index]! > BAYER_8[(row & 7) * 8 + (col & 7)]! ? 1 : 0;
    }
  }
  const clean = dots.slice();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (!dots[index]) continue;
      let lonely = true;
      for (let dy = -STRAY_RADIUS_CELLS; dy <= STRAY_RADIUS_CELLS && lonely; dy += 1) {
        const y = row + dy;
        if (y < 0 || y >= rows) continue;
        for (let dx = -STRAY_RADIUS_CELLS; dx <= STRAY_RADIUS_CELLS; dx += 1) {
          const x = col + dx;
          if ((dx !== 0 || dy !== 0) && x >= 0 && x < cols && dots[y * cols + x]) {
            lonely = false;
            break;
          }
        }
      }
      if (lonely) clean[index] = 0;
    }
  }
  return clean;
}

export type EmptyChatBackdropStyle = "temple" | "gradient";

export function EmptyChatBackdrop(props: { style: EmptyChatBackdropStyle }) {
  const { style } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { activeTheme, resolvedTheme } = useTheme();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { accent } = activeTheme.theme;
  const isDark = resolvedTheme === "dark";
  const darkTemple = isDark && style === "temple";
  const dotRadius = (isDark ? SCENE_LEVELS.dark : SCENE_LEVELS.light).dot;
  const skyMask = !isDark && style === "temple" ? LIGHT_SKY_MASK : null;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!container || !canvas || !ctx) return;

    const rawAccent = parseHexColor(accent);
    // Light temple prints on tinted paper: softer ink so the dots read warm, not stark.
    const accentRgb = (
      !isDark && style === "temple"
        ? rawAccent.map((channel) => Math.round(channel + (255 - channel) * LIGHT_INK_SOFTEN))
        : rawAccent
    ) as [number, number, number];
    const highlightTarget = 255;
    const crestSign = isDark ? 1 : -1;
    const highlightRgb = accentRgb.map((channel) =>
      Math.round(channel + (highlightTarget - channel) * RIPPLE_HIGHLIGHT_MIX),
    ) as [number, number, number];
    let disposed = false;
    let field: Field | null = null;
    let ripples: Ripple[] = [];
    // Cells the last ripple frame touched; the next frame redraws them back to the base.
    let dirty: CellRect | null = null;
    let frameId = 0;
    let timerId = 0;
    let lastFrameMs = 0;
    const startMs = performance.now();
    let lastInputMs = startMs;
    // The gradient moves unless reduced motion asks for a still frame.
    const animate = style === "gradient" && !reduceMotion;
    // The scene is only fetched once the field is first built in an idle slot.
    let scenePromise: Promise<HTMLImageElement | null> | null = null;

    // Writes one cell from its base density plus the ripple contribution.
    const paintCell = (target: Field, col: number, row: number, nowMs: number) => {
      const index = row * target.cols + col;
      let value = target.density[index]! / 255;
      let crest = 0;
      let disturbance = 0;
      if (ripples.length > 0) {
        const x = col * CELL_PX + CELL_PX / 2;
        const y = row * CELL_PX + CELL_PX / 2;
        for (const ripple of ripples) {
          const age = nowMs - ripple.startMs;
          const radius = age * RIPPLE_SPEED_PX_PER_MS;
          const dx = x - ripple.x;
          const dy = y - ripple.y;
          // Canvas coordinates are bounded, so the direct norm is sufficient here.
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (Math.abs(distance - radius) > RIPPLE_REACH_PX) continue;
          const angle = Math.atan2(dy, dx);
          const wobble =
            RIPPLE_WOBBLE_PX *
            (0.6 * Math.sin(angle * 3 + ripple.phaseA + age / 400) +
              0.4 * Math.sin(angle * 5 + ripple.phaseB));
          const offset = (distance + wobble - radius) / RIPPLE_BAND_PX;
          const troughOffset = offset + RIPPLE_TROUGH_LAG_PX / RIPPLE_BAND_PX;
          const life = 1 - age / RIPPLE_LIFETIME_MS;
          const fade = life * life;
          const ring = Math.exp(-offset * offset) * fade;
          crest += ring;
          const trough = Math.exp(-troughOffset * troughOffset) * fade;
          const delta = crestSign * (RIPPLE_STRENGTH * ring - RIPPLE_TROUGH_STRENGTH * trough);
          value += delta;
          disturbance += Math.abs(delta);
        }
      }
      const bytes = target.image.data;
      const base = index * 4;
      const lit = isDark ? Math.min(1, crest * 1.4) : 0;
      bytes[base] = accentRgb[0] + (highlightRgb[0] - accentRgb[0]) * lit;
      bytes[base + 1] = accentRgb[1] + (highlightRgb[1] - accentRgb[1]) * lit;
      bytes[base + 2] = accentRgb[2] + (highlightRgb[2] - accentRgb[2]) * lit;
      // Outside a ring, the still picture; inside, an ordered dither the ring can move.
      const settled = disturbance < RIPPLE_SETTLED;
      const on =
        settled && target.dots
          ? target.dots[index] === 1
          : value * 255 > BAYER_8[(row & 7) * 8 + (col & 7)]!;
      const opacity = target.fadeOpacity && settled ? fadeOpacityFor(target.density[index]!) : 255;
      bytes[base + 3] = on ? opacity : 0;
    };

    const paintRect = (target: Field, rect: CellRect, nowMs: number) => {
      for (let row = rect.y0; row < rect.y1; row += 1) {
        for (let col = rect.x0; col < rect.x1; col += 1) paintCell(target, col, row, nowMs);
      }
      ctx.putImageData(target.image, 0, 0, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
    };

    // Bounding cells of every live ring this frame.
    const rippleRect = (target: Field, nowMs: number): CellRect | null => {
      let rect: CellRect | null = null;
      for (const ripple of ripples) {
        const reach = (nowMs - ripple.startMs) * RIPPLE_SPEED_PX_PER_MS + RIPPLE_REACH_PX;
        const next = {
          x0: Math.max(0, Math.floor((ripple.x - reach) / CELL_PX)),
          y0: Math.max(0, Math.floor((ripple.y - reach) / CELL_PX)),
          x1: Math.min(target.cols, Math.ceil((ripple.x + reach) / CELL_PX)),
          y1: Math.min(target.rows, Math.ceil((ripple.y + reach) / CELL_PX)),
        };
        rect = rect ? unionRect(rect, next) : next;
      }
      return rect;
    };

    const draw = (nowMs: number) => {
      if (!field) return;
      ripples = ripples.filter((ripple) => nowMs - ripple.startMs < RIPPLE_LIFETIME_MS);
      const live = rippleRect(field, nowMs);
      // Repaint where rings are now and where they were, which restores the base there.
      let rect = live && dirty ? unionRect(live, dirty) : (live ?? dirty);
      if (animate && field.gradient) {
        writeGradientDensity(field, field.gradient, (nowMs - startMs) / 1000);
        const glow = { x0: 0, y0: 0, x1: field.cols, y1: field.gradient.activeRows };
        rect = rect ? unionRect(rect, glow) : glow;
      }
      if (rect && rect.x1 > rect.x0 && rect.y1 > rect.y0) paintRect(field, rect, nowMs);
      dirty = live;
    };

    const frameInterval = (nowMs: number) => {
      if (ripples.length > 0 || dirty) return RIPPLE_FRAME_INTERVAL_MS;
      return nowMs - lastInputMs >= INPUT_IDLE_AFTER_MS
        ? GRADIENT_IDLE_FRAME_INTERVAL_MS
        : GRADIENT_FRAME_INTERVAL_MS;
    };

    const scheduleNext = (delayMs: number) => {
      if (delayMs <= 0) {
        frameId = requestAnimationFrame(tick);
        return;
      }
      timerId = window.setTimeout(() => {
        timerId = 0;
        frameId = requestAnimationFrame(tick);
      }, delayMs);
    };

    function tick(nowMs: number) {
      frameId = 0;
      if (disposed || document.hidden || !field) return;
      // Parked under an invisible ancestor (a retained chat owner): do no canvas work, and
      // check again slowly so motion resumes after the pane is shown again.
      if (!container!.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
        if (animate || ripples.length > 0 || dirty) scheduleNext(1000);
        return;
      }
      if (nowMs - lastFrameMs >= frameInterval(nowMs)) {
        lastFrameMs = nowMs;
        draw(nowMs);
      }
      if (ripples.length > 0 || dirty) {
        scheduleNext(0);
      } else if (animate) {
        scheduleNext(Math.max(0, lastFrameMs + frameInterval(nowMs) - nowMs));
      }
      // Otherwise idle: no frames, no timers.
    }
    const wake = () => {
      if (frameId !== 0) return;
      if (timerId !== 0) {
        window.clearTimeout(timerId);
        timerId = 0;
      }
      frameId = requestAnimationFrame(tick);
    };

    const rebuild = async () => {
      const rect = container.getBoundingClientRect();
      const cols = Math.ceil(rect.width / CELL_PX);
      const rows = Math.ceil(rect.height / CELL_PX);
      // Hidden (forced colors, high contrast) or collapsed: keep nothing allocated.
      if (cols === 0 || rows === 0) return;
      const host = container.parentElement ?? container;
      let density: Uint8Array | null;
      let gradient: GradientField | null = null;
      if (style === "gradient") {
        const zones = measureQuietZones(host, container.getBoundingClientRect(), QUIET_SELECTOR);
        gradient = buildGradientField(cols, rows, zones, DIMMED_QUIET_FLOOR);
        density = new Uint8Array(cols * rows);
      } else {
        scenePromise ??= loadImage(SCENE_SRC);
        const scene = await scenePromise;
        if (disposed || !scene) return;
        const zones = measureQuietZones(
          host,
          container.getBoundingClientRect(),
          darkTemple ? DARK_TEMPLE_QUIET_SELECTOR : QUIET_SELECTOR,
        );
        density = buildDensity(scene, cols, rows, isDark, zones);
      }
      if (!density || disposed) return;
      canvas.width = cols;
      canvas.height = rows;
      canvas.style.width = `${cols * CELL_PX}px`;
      canvas.style.height = `${rows * CELL_PX}px`;
      field = {
        cols,
        rows,
        density,
        // The gradient dithers live from its density (its sparse fringe is the fade itself).
        dots: gradient ? null : ditherDots(density, cols, rows),
        fadeOpacity: gradient !== null,
        gradient,
        image: ctx.createImageData(cols, rows),
      };
      const nowMs = performance.now();
      if (gradient) writeGradientDensity(field, gradient, animate ? (nowMs - startMs) / 1000 : 0);
      dirty = null;
      paintRect(field, { x0: 0, y0: 0, x1: cols, y1: rows }, nowMs);
      lastFrameMs = nowMs;
      container.dataset.ready = "true";
      // Lets the landing text add a legibility halo while the backdrop is showing.
      host.dataset.emptyChatBackdropHost = "";
      if (animate || ripples.length > 0) wake();
    };

    // Listen on the landing itself: its heading and composer sit above the canvas.
    const host = container.parentElement ?? container;
    // Ripple on a plain click only, after the press ends: drags, text selections and
    // controls are left alone, and nothing here ever prevents the default action.
    let press: { id: number; x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      press = null;
      if (event.button !== 0 || !event.isPrimary) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return;
      press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = press;
      press = null;
      if (!start || start.id !== event.pointerId || !field) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const rect = container.getBoundingClientRect();
      ripples.push({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        startMs: performance.now(),
        phaseA: Math.random() * Math.PI * 2,
        phaseB: Math.random() * Math.PI * 2,
      });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
      wake();
    };
    // Reduced motion keeps the still picture: no ripples and no drifting gradient.
    if (!reduceMotion) {
      host.addEventListener("pointerdown", onPointerDown, { passive: true });
      host.addEventListener("pointerup", onPointerUp, { passive: true });
    }

    // Setup only ever runs in an idle slot, never in the mount or resize path, so opening
    // or creating a thread is not delayed by it.
    let started = false;
    let cancelIdle: (() => void) | null = null;
    const rebuildWhenIdle = () => {
      cancelIdle?.();
      cancelIdle = scheduleIdle(() => {
        cancelIdle = null;
        void rebuild();
      });
    };
    const startTimer = setTimeout(() => {
      started = true;
      rebuildWhenIdle();
    }, START_DELAY_MS);
    const resizeObserver = new ResizeObserver(() => {
      if (started) rebuildWhenIdle();
    });
    resizeObserver.observe(container);
    const onVisibilityChange = () => {
      if (animate || ripples.length > 0 || dirty) wake();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const onInput = () => {
      lastInputMs = performance.now();
    };
    const inputEvents = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    if (animate) {
      for (const type of inputEvents) {
        window.addEventListener(type, onInput, { passive: true, capture: true });
      }
    }

    return () => {
      disposed = true;
      delete host.dataset.emptyChatBackdropHost;
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointerup", onPointerUp);
      clearTimeout(startTimer);
      cancelIdle?.();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const type of inputEvents) {
        window.removeEventListener(type, onInput, { capture: true });
      }
      if (frameId !== 0) cancelAnimationFrame(frameId);
      window.clearTimeout(timerId);
    };
  }, [accent, darkTemple, isDark, reduceMotion, style]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      data-empty-chat-backdrop={style}
      className="pointer-events-none absolute inset-0 overflow-hidden opacity-0 transition-opacity duration-700 ease-out select-none contrast-more:hidden data-[ready=true]:opacity-100 motion-reduce:transition-none forced-colors:hidden"
    >
      {skyMask ? (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(to bottom, color-mix(in oklab, ${accent} ${LIGHT_PAPER_PERCENT / 3}%, transparent), color-mix(in oklab, ${accent} ${LIGHT_PAPER_PERCENT}%, transparent) 55%)`,
          }}
        />
      ) : null}
      {style === "gradient" ? (
        <div
          className="absolute inset-0 [mask-image:linear-gradient(to_bottom,#000,transparent_70%)]"
          style={{ backgroundImage: gradientHaze(accent) }}
        />
      ) : null}
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 [image-rendering:pixelated]"
        style={{
          opacity: darkTemple ? DARK_TEMPLE_OPACITY : undefined,
          maskImage: [
            `radial-gradient(circle at center, #000 ${dotRadius}px, transparent ${dotRadius + 0.4}px)`,
            ...(skyMask ? [skyMask] : []),
          ].join(", "),
          maskSize: skyMask ? `${CELL_PX}px ${CELL_PX}px, 100% 100%` : `${CELL_PX}px ${CELL_PX}px`,
          maskRepeat: skyMask ? "repeat, no-repeat" : "repeat",
          maskComposite: skyMask ? "intersect" : undefined,
        }}
      />
    </div>
  );
}
