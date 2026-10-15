// FILE: AsciiWaveBackground.tsx
// Purpose: Ambient ASCII field behind the empty-chat landing; clicks send accent ripples.
// Layer: Chat presentation
// Depends on: the active theme's ink and accent colors.

import { useEffect, useRef, type RefObject } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useTheme } from "~/hooks/useTheme";

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const FONT_SIZE_PX = 10;
const LINE_HEIGHT_PX = 13;
// Bound the three full-size RGBA surfaces to roughly 48 MiB, even on Retina/4K displays.
const MAX_BACKING_PIXELS = 4_000_000;
// The idle field drifts slowly, so it redraws rarely on a plain timer; only click ripples,
// which need smooth motion, use animation frames.
const IDLE_FRAME_INTERVAL_MS = 1000 / 15;
const RIPPLE_FRAME_INTERVAL_MS = 1000 / 40;
// Share of cells that swap glyphs each frame; cells inside a ripple swap far more often.
const IDLE_SCRAMBLE_RATE = 0.025;
const RIPPLE_SCRAMBLE_RATE = 0.35;
const RIPPLE_SPEED_PX_PER_MS = 0.55;
const RIPPLE_BAND_PX = 30;
const RIPPLE_LIFETIME_MS = 2600;
const MAX_RIPPLES = 6;
// Ripple edges wobble by up to this many px so they read as water, not circles.
const RIPPLE_WOBBLE_PX = 34;
// Ink only shows inside drifting noise blotches; the rest of the field stays empty.
const PATCH_THRESHOLD_LOW = 0.4;
const PATCH_THRESHOLD_HIGH = 0.78;
const INK_ALPHA_MAX = 0.18;
const COMPOSER_CLEARANCE_PX = 12;
const COMPOSER_FADE_PX = 48;
// The field cycles through these looks, cross-fading from one to the next.
const PATTERN_DURATION_MS = 20_000;
const PATTERN_CROSSFADE_MS = 4_000;
// The pattern is sampled every N cells and interpolated between; blotches are far larger.
const FIELD_STEP = 2;
// Decoration must never compete with opening a thread: wait for the landing to settle,
// then for an idle slot, fill the glyph layer a slice per frame, and fade in.
const START_DELAY_MS = 400;
const IDLE_TIMEOUT_MS = 1500;
const GLYPH_FILL_PER_FRAME = 1500;
const REVEAL_MS = 1200;
// Clicks on controls and text keep their own meaning and do not ripple.
const INTERACTIVE_SELECTOR =
  "a,button,input,textarea,select,label,[contenteditable='true'],[role='button'],[role='combobox'],[role='menuitem'],[role='option'],[role='textbox'],[role='dialog'],[role='menu'],[role='listbox']";
// A press that travels farther than this is a drag (e.g. selecting text), not a click.
const CLICK_SLOP_PX = 4;

interface FieldPattern {
  // Blotch size (px) per axis; unequal values stretch blotches into streaks.
  scaleX: number;
  scaleY: number;
  // Blotch drift in noise cells per second.
  driftX: number;
  driftY: number;
  // Band direction and spacing; `radial` bands ring out from the center instead.
  waveX: number;
  waveY: number;
  waveLength: number;
  waveSpeed: number;
  radial: boolean;
}

const FIELD_PATTERNS: readonly FieldPattern[] = [
  // Blotches: round patches drifting diagonally, crossed by diagonal bands.
  {
    scaleX: 190,
    scaleY: 150,
    driftX: 0.1,
    driftY: -0.06,
    waveX: 0.8,
    waveY: 0.6,
    waveLength: 70,
    waveSpeed: 1.3,
    radial: false,
  },
  // Currents: long horizontal streaks flowing sideways.
  {
    scaleX: 360,
    scaleY: 80,
    driftX: 0.16,
    driftY: 0.01,
    waveX: 0.25,
    waveY: 1,
    waveLength: 38,
    waveSpeed: 1.8,
    radial: false,
  },
  // Rings: patches with waves pulsing out from the center.
  {
    scaleX: 150,
    scaleY: 150,
    driftX: -0.06,
    driftY: 0.09,
    waveX: 0,
    waveY: 0,
    waveLength: 55,
    waveSpeed: 1.5,
    radial: true,
  },
];

interface Ripple {
  x: number;
  y: number;
  startMs: number;
  // Random phases so every ripple wobbles differently.
  phaseA: number;
  phaseB: number;
}

// Glyphs live in a pre-rendered layer; each frame only rewrites one alpha byte per cell
// in two tiny masks, and the GPU scales those masks over the layer.
interface Field {
  cols: number;
  rows: number;
  // Cell size in device pixels, rounded so cells tile the layers exactly.
  cellW: number;
  cellH: number;
  glyphs: Uint8Array;
  layer: HTMLCanvasElement;
  layerCtx: CanvasRenderingContext2D;
  scratch: HTMLCanvasElement;
  scratchCtx: CanvasRenderingContext2D;
  inkMask: Mask;
  accentMask: Mask;
  // Pattern samples on a coarse lattice, refilled each frame.
  latticeCols: number;
  patchLattice: Float32Array;
  waveLattice: Float32Array;
  // Glyphs below this index are drawn into the layer; the rest fill in over later frames.
  filled: number;
}

interface Mask {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx } : null;
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

function createMask(cols: number, rows: number): Mask | null {
  const surface = createCanvas(cols, rows);
  return surface ? { ...surface, image: surface.ctx.createImageData(cols, rows) } : null;
}

function randomGlyph(): number {
  return Math.floor(Math.random() * GLYPHS.length);
}

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function noisePlane(x0: number, y0: number, z: number, fx: number, fy: number): number {
  return lerp(
    lerp(hash3(x0, y0, z), hash3(x0 + 1, y0, z), fx),
    lerp(hash3(x0, y0 + 1, z), hash3(x0 + 1, y0 + 1, z), fx),
    fy,
  );
}

// Smooth 3D value noise in [0, 1); z is time, so blotches drift and reshape.
function valueNoise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smoothstep(0, 1, x - x0);
  const fy = smoothstep(0, 1, y - y0);
  return lerp(
    noisePlane(x0, y0, z0, fx, fy),
    noisePlane(x0, y0, z0 + 1, fx, fy),
    smoothstep(0, 1, z - z0),
  );
}

// Blotch coverage (`patch`) and band brightness (`wave`) for one pattern, both 0..1.
function sampleField(
  pattern: FieldPattern,
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  t: number,
): { patch: number; wave: number } {
  const noise =
    0.68 *
      valueNoise3(
        x / pattern.scaleX + t * pattern.driftX,
        y / pattern.scaleY + t * pattern.driftY,
        t * 0.18,
      ) +
    0.32 * valueNoise3(x / 70 - t * 0.08, y / 52, t * 0.35 + 17);
  const bandPosition = pattern.radial
    ? Math.hypot(x - centerX, y - centerY)
    : x * pattern.waveX + y * pattern.waveY;
  const wave =
    0.5 + 0.5 * Math.sin(bandPosition / pattern.waveLength - t * pattern.waveSpeed + noise * 5);
  const patch = smoothstep(PATCH_THRESHOLD_LOW, PATCH_THRESHOLD_HIGH, noise + 0.1 * (wave - 0.5));
  return { patch, wave };
}

// Every glyph once, in ink, at device resolution; cells are blitted from here.
function buildAtlas(fontFamily: string, cellW: number, cellH: number, dpr: number, ink: string) {
  const surface = createCanvas(GLYPHS.length * cellW, cellH);
  if (!surface) return null;
  const { canvas, ctx } = surface;
  ctx.font = `${FONT_SIZE_PX * dpr}px ${fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = ink;
  for (let index = 0; index < GLYPHS.length; index += 1) {
    ctx.fillText(GLYPHS[index]!, index * cellW + cellW / 2, cellH / 2);
  }
  return canvas;
}

export function AsciiWaveBackground({
  exclusionRef,
}: {
  exclusionRef?: RefObject<HTMLElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ripplesRef = useRef<Ripple[]>([]);
  const { activeTheme } = useTheme();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { ink, accent } = activeTheme.theme;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!container || !canvas || !ctx) return;

    const fontFamily = getComputedStyle(canvas).fontFamily || "monospace";
    let dpr = 1;
    let width = 0;
    let height = 0;
    let atlas: HTMLCanvasElement | null = null;
    let field: Field | null = null;
    let frameId = 0;
    let lastFrameMs = 0;
    const startMs = performance.now();
    let revealStartMs: number | null = null;
    const seed = Math.random() * 1000;
    const firstPattern = Math.floor(Math.random() * FIELD_PATTERNS.length);

    const drawGlyph = (target: Field, index: number) => {
      if (!atlas) return;
      const { cols, cellW, cellH, layerCtx } = target;
      const x = (index % cols) * cellW;
      const y = Math.floor(index / cols) * cellH;
      layerCtx.clearRect(x, y, cellW, cellH);
      layerCtx.drawImage(atlas, target.glyphs[index]! * cellW, 0, cellW, cellH, x, y, cellW, cellH);
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, width * height)),
      );
      revealStartMs = null;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.font = `${FONT_SIZE_PX}px ${fontFamily}`;
      const cellW = Math.max(1, Math.round((ctx.measureText("M").width + 1) * dpr));
      const cellH = Math.max(1, Math.round(LINE_HEIGHT_PX * dpr));
      const cols = Math.ceil(canvas.width / cellW);
      const rows = Math.ceil(canvas.height / cellH);
      // Hidden or not laid out yet: the ResizeObserver rebuilds once there is room.
      if (cols < 1 || rows < 1) {
        field = null;
        return;
      }
      atlas = buildAtlas(fontFamily, cellW, cellH, dpr, ink);
      const layer = createCanvas(cols * cellW, rows * cellH);
      const scratch = createCanvas(cols * cellW, rows * cellH);
      const inkMask = createMask(cols, rows);
      const accentMask = createMask(cols, rows);
      if (!atlas || !layer || !scratch || !inkMask || !accentMask) {
        field = null;
        return;
      }
      const glyphs = new Uint8Array(cols * rows);
      for (let index = 0; index < glyphs.length; index += 1) glyphs[index] = randomGlyph();
      const latticeCols = Math.ceil(cols / FIELD_STEP) + 1;
      const latticeSize = latticeCols * (Math.ceil(rows / FIELD_STEP) + 1);
      field = {
        cols,
        rows,
        cellW,
        cellH,
        glyphs,
        layer: layer.canvas,
        layerCtx: layer.ctx,
        scratch: scratch.canvas,
        scratchCtx: scratch.ctx,
        inkMask,
        accentMask,
        latticeCols,
        patchLattice: new Float32Array(latticeSize),
        waveLattice: new Float32Array(latticeSize),
        filled: 0,
      };
    };

    const fillGlyphs = (target: Field) => {
      const end = Math.min(target.glyphs.length, target.filled + GLYPH_FILL_PER_FRAME);
      for (let index = target.filled; index < end; index += 1) drawGlyph(target, index);
      target.filled = end;
    };

    // Glyph layer -> optional recolor -> cut by the per-cell alpha mask -> onto the canvas.
    const composite = (target: Field, mask: Mask, color: string | null) => {
      const { scratchCtx, layer, cols, rows } = target;
      mask.ctx.putImageData(mask.image, 0, 0);
      scratchCtx.globalCompositeOperation = "copy";
      scratchCtx.drawImage(layer, 0, 0);
      if (color) {
        scratchCtx.globalCompositeOperation = "source-in";
        scratchCtx.fillStyle = color;
        scratchCtx.fillRect(0, 0, layer.width, layer.height);
      }
      scratchCtx.globalCompositeOperation = "destination-in";
      scratchCtx.drawImage(mask.canvas, 0, 0, cols, rows, 0, 0, layer.width, layer.height);
      ctx.drawImage(target.scratch, 0, 0);
    };

    const draw = (nowMs: number) => {
      if (!field) return;
      if (field.filled < field.glyphs.length) {
        fillGlyphs(field);
        // Publish only a complete layer, including after resize. Filling stays sliced
        // across frames without exposing a top-to-bottom wipe at full opacity.
        if (field.filled < field.glyphs.length) return;
      }
      if (revealStartMs === null) revealStartMs = nowMs;
      const reveal = reduceMotion ? 1 : smoothstep(0, REVEAL_MS, nowMs - revealStartMs);
      const { cols, rows, cellW, cellH, glyphs } = field;
      const inkBytes = field.inkMask.image.data;
      const accentBytes = field.accentMask.image.data;
      // The seed shifts time so each mount starts somewhere new in the noise.
      const fieldMs = reduceMotion ? startMs : nowMs;
      const t = fieldMs / 1000 + seed;
      const elapsed = fieldMs - startMs;
      const cycle = Math.floor(elapsed / PATTERN_DURATION_MS);
      const pattern = FIELD_PATTERNS[(firstPattern + cycle) % FIELD_PATTERNS.length]!;
      const patternMix = smoothstep(
        PATTERN_DURATION_MS - PATTERN_CROSSFADE_MS,
        PATTERN_DURATION_MS,
        elapsed % PATTERN_DURATION_MS,
      );
      const nextPattern =
        patternMix > 0 ? FIELD_PATTERNS[(firstPattern + cycle + 1) % FIELD_PATTERNS.length]! : null;
      const centerX = width / 2;
      const centerY = height / 2;
      const ripples = ripplesRef.current.filter(
        (ripple) => nowMs - ripple.startMs < RIPPLE_LIFETIME_MS,
      );
      ripplesRef.current = ripples;
      let hasAccent = false;

      const { latticeCols, patchLattice, waveLattice } = field;
      const latticeRows = patchLattice.length / latticeCols;
      for (let ly = 0; ly < latticeRows; ly += 1) {
        const y = ((ly * FIELD_STEP + 0.5) * cellH) / dpr;
        for (let lx = 0; lx < latticeCols; lx += 1) {
          const x = ((lx * FIELD_STEP + 0.5) * cellW) / dpr;
          const sample = sampleField(pattern, x, y, centerX, centerY, t);
          let { patch, wave } = sample;
          if (nextPattern) {
            const next = sampleField(nextPattern, x, y, centerX, centerY, t);
            patch += (next.patch - patch) * patternMix;
            wave += (next.wave - wave) * patternMix;
          }
          patchLattice[ly * latticeCols + lx] = patch;
          waveLattice[ly * latticeCols + lx] = wave;
        }
      }

      for (let row = 0; row < rows; row += 1) {
        const y = ((row + 0.5) * cellH) / dpr;
        for (let col = 0; col < cols; col += 1) {
          const x = ((col + 0.5) * cellW) / dpr;
          const index = row * cols + col;
          // Bilinear lookup into the lattice.
          const lx = Math.floor(col / FIELD_STEP);
          const ly = Math.floor(row / FIELD_STEP);
          const fx = (col % FIELD_STEP) / FIELD_STEP;
          const fy = (row % FIELD_STEP) / FIELD_STEP;
          const top = ly * latticeCols + lx;
          const bottom = top + latticeCols;
          const patch = lerp(
            lerp(patchLattice[top]!, patchLattice[top + 1]!, fx),
            lerp(patchLattice[bottom]!, patchLattice[bottom + 1]!, fx),
            fy,
          );
          const wave = lerp(
            lerp(waveLattice[top]!, waveLattice[top + 1]!, fx),
            lerp(waveLattice[bottom]!, waveLattice[bottom + 1]!, fx),
            fy,
          );
          // Dim the middle so the hero stays readable.
          const dx = (x - centerX) / (width * 0.3);
          const dy = (y - centerY) / (height * 0.3);
          const centerFade = Math.min(1, 0.45 + 0.55 * Math.sqrt(dx * dx + dy * dy));
          const inkAlpha = INK_ALPHA_MAX * patch * patch * (0.4 + 0.6 * wave) * centerFade * reveal;

          let rippleStrength = 0;
          // Shared per cell: bends every ripple's ring the same organic way.
          const warp =
            ripples.length > 0
              ? (valueNoise3(x / 60, y / 60, t * 0.6) - 0.5) * RIPPLE_WOBBLE_PX
              : 0;
          for (const ripple of ripples) {
            const age = nowMs - ripple.startMs;
            const ripX = x - ripple.x;
            const ripY = y - ripple.y;
            const distance = Math.hypot(ripX, ripY);
            const radius = age * RIPPLE_SPEED_PX_PER_MS;
            // Skip cells beyond the widest possible ring (band + warp + lobes).
            if (
              Math.abs(distance - radius) >
              2 * RIPPLE_BAND_PX + RIPPLE_WOBBLE_PX + 0.1 * radius
            ) {
              continue;
            }
            // Lobes around the ring grow with the radius so the shape loosens as it spreads.
            const angle = Math.atan2(ripY, ripX);
            const lobes =
              radius *
              (0.06 * Math.sin(3 * angle + ripple.phaseA + t) +
                0.04 * Math.sin(5 * angle + ripple.phaseB - t * 1.3));
            const offset = (distance - radius - lobes - warp) / RIPPLE_BAND_PX;
            if (offset > -2 && offset < 2) {
              const fade = 1 - age / RIPPLE_LIFETIME_MS;
              rippleStrength += Math.exp(-offset * offset) * fade * fade;
            }
          }
          rippleStrength = Math.min(1, rippleStrength);

          const useAccent = rippleStrength > 0.08;
          // The wave is brightest where it crosses a blotch, so it stays patchy too.
          const accentAlpha = useAccent
            ? Math.min(1, inkAlpha + rippleStrength * (0.4 + 0.55 * patch))
            : 0;
          inkBytes[index * 4 + 3] = useAccent ? 0 : Math.round(inkAlpha * 255);
          accentBytes[index * 4 + 3] = Math.round(accentAlpha * 255);
          if (useAccent) hasAccent = true;

          // Only visible cells need fresh glyphs.
          if (reduceMotion || (inkAlpha < 0.01 && !useAccent)) continue;
          const scrambleRate = IDLE_SCRAMBLE_RATE + RIPPLE_SCRAMBLE_RATE * rippleStrength;
          if (Math.random() < scrambleRate) {
            glyphs[index] = randomGlyph();
            if (index < field.filled) drawGlyph(field, index);
          }
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      composite(field, field.inkMask, null);
      if (hasAccent) composite(field, field.accentMask, accent);

      // Remove the decoration itself, so translucent/glass composers stay clear in
      // every theme. Apply after both passes so click ripples respect the same gap.
      const exclusion = exclusionRef?.current;
      if (exclusion) {
        const rect = exclusion.getBoundingClientRect();
        const bounds = container.getBoundingClientRect();
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "#000";
        ctx.shadowColor = "#000";
        ctx.shadowBlur = COMPOSER_FADE_PX * dpr;
        ctx.fillRect(
          (rect.left - bounds.left - COMPOSER_CLEARANCE_PX) * dpr,
          (rect.top - bounds.top - COMPOSER_CLEARANCE_PX) * dpr,
          (rect.width + 2 * COMPOSER_CLEARANCE_PX) * dpr,
          (rect.height + 2 * COMPOSER_CLEARANCE_PX) * dpr,
        );
        ctx.restore();
      }
    };

    let timerId = 0;
    const scheduleNext = (delayMs: number) => {
      if (ripplesRef.current.length > 0) {
        frameId = requestAnimationFrame(tick);
      } else {
        timerId = window.setTimeout(() => {
          timerId = 0;
          tick(performance.now());
        }, delayMs);
      }
    };

    const tick = (nowMs: number) => {
      frameId = 0;
      // Not set up yet: the idle setup calls wake() itself once the field exists.
      if (document.hidden || !field) return;
      // Retained chat owners can be parked under an invisible ancestor. Do no canvas
      // work there; the slow visibility-only retry also resumes after DOM reparenting.
      if (!container.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
        timerId = window.setTimeout(() => {
          timerId = 0;
          tick(performance.now());
        }, 1000);
        return;
      }
      const interval =
        ripplesRef.current.length > 0 ? RIPPLE_FRAME_INTERVAL_MS : IDLE_FRAME_INTERVAL_MS;
      if (nowMs - lastFrameMs >= interval) {
        lastFrameMs = nowMs;
        draw(nowMs);
      }
      // Reduced motion keeps a still field and only animates while a ripple is alive
      // (or while the glyph layer is still filling in).
      const filling = field.filled < field.glyphs.length;
      if (!reduceMotion || filling || ripplesRef.current.length > 0) {
        scheduleNext(Math.max(0, lastFrameMs + IDLE_FRAME_INTERVAL_MS - nowMs));
      }
    };

    // Draw soon. A pending idle timer is kept unless a new ripple needs frame-rate updates.
    const wake = () => {
      if (frameId !== 0) return;
      if (timerId !== 0) {
        if (ripplesRef.current.length === 0) return;
        window.clearTimeout(timerId);
        timerId = 0;
      }
      scheduleNext(0);
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
      if (!start || start.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const rect = container.getBoundingClientRect();
      const ripples = ripplesRef.current;
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
    host.addEventListener("pointerdown", onPointerDown, { passive: true });
    host.addEventListener("pointerup", onPointerUp, { passive: true });

    // Setup (canvas allocation, glyph layer) only ever runs in an idle slot, never in the
    // mount or resize path, so opening or creating a thread is not delayed by it.
    let started = false;
    let cancelIdle: (() => void) | null = null;
    const rebuildWhenIdle = () => {
      cancelIdle?.();
      cancelIdle = scheduleIdle(() => {
        cancelIdle = null;
        resize();
        lastFrameMs = 0;
        wake();
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
    // Reduced motion has no idle redraw loop, so composer growth must also wake it.
    if (exclusionRef?.current) resizeObserver.observe(exclusionRef.current);
    document.addEventListener("visibilitychange", wake);

    return () => {
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointerup", onPointerUp);
      clearTimeout(startTimer);
      cancelIdle?.();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", wake);
      if (frameId !== 0) cancelAnimationFrame(frameId);
      window.clearTimeout(timerId);
    };
  }, [ink, accent, reduceMotion, exclusionRef]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <canvas ref={canvasRef} className="size-full font-mono" />
    </div>
  );
}
