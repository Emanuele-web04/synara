// FILE: Mascot.tsx
// Purpose: Mascots (ported from HoloBot's packages/ui Mascot.tsx and mascots.ts): soft toys seen
//          face on, one color each, drawn as inline SVG. Every bot breathes, blinks and
//          glances; working, its eyes scan and it bobs; waiting on the user, it nods. Reduce
//          Motion holds them still. The main SynBot is HoloBot's chrome ghost, a still image
//          (assets/, cut from HoloBot's brand render) at the size each slot needs.
// Layer: SynBot kit
// Exports: MascotSize, MascotMood, GhostMark, BotMascot, PebbleMascot, mascotFit, botPhase

import type { CSSProperties } from "react";

import ghost48 from "./assets/synbot-ghost-48.webp";
import ghost96 from "./assets/synbot-ghost-96.webp";
import ghost192 from "./assets/synbot-ghost-192.webp";
import ghost384 from "./assets/synbot-ghost-384.webp";
import { BOT_SHAPE_LOOKS, FACE_EYES, PEBBLE, type ShapeLook } from "./botShapes";
import "./holobot.css";

/** tile: pinned bots; row: conversation rows; pill: the name pill; card: message headers and
 * task cards; or a size in px. */
export type MascotSize = "tile" | "row" | "pill" | "card" | number;

/** What a bot is doing, as its face shows it. */
export type MascotMood = "idle" | "working" | "waiting";

/** The most of its box a mascot spans, wide or tall: a bigger outline is drawn smaller about
 * the box's middle, so none looks bigger than the rest. */
const MASCOT_MAX_EXTENT = 78;
const fits = new Map<string, number>();

/** An outline's scale in its box: 1, or less when it spans more than MASCOT_MAX_EXTENT. */
export function mascotFit(path: string): number {
  let fit = fits.get(path);
  if (fit === undefined) {
    const numbers = (path.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const xs = numbers.filter((_, index) => index % 2 === 0);
    const ys = numbers.filter((_, index) => index % 2 === 1);
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    fit = Math.min(1, MASCOT_MAX_EXTENT / extent);
    fits.set(path, fit);
  }
  return fit;
}

function fitTransform(path: string): string | undefined {
  const fit = mascotFit(path);
  return fit < 1 ? `translate(50 50) scale(${fit.toFixed(4)}) translate(-50 -50)` : undefined;
}

/** A stable number from a bot's id: it staggers the bots' blinks and glances. */
export function botPhase(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  return ((hash >>> 0) % 8000) / 1000;
}

function frame(size: MascotSize): { className: string; style: CSSProperties | undefined } {
  const sized = typeof size === "number";
  return {
    className: `hb-mascot${sized ? "" : ` hb-mascot--${size}`}`,
    style: sized ? { width: size, height: size } : undefined,
  };
}

const GHOST_SRCSET = `${ghost48} 48w, ${ghost96} 96w, ${ghost192} 192w, ${ghost384} 384w`;
const SLOT_PX: Record<Exclude<MascotSize, number>, number> = {
  tile: 52,
  row: 32,
  pill: 22,
  card: 18,
};

/** The main SynBot: HoloBot's chrome ghost, still; the browser picks the sharpest rendition
 * for the slot's size and the screen's density. */
export function GhostMark({
  size,
  className,
}: {
  readonly size: MascotSize;
  readonly className?: string | undefined;
}) {
  const box = frame(size);
  const px = typeof size === "number" ? size : SLOT_PX[size];
  return (
    <img
      className={`${box.className} hb-ghost${className ? ` ${className}` : ""}`}
      style={box.style}
      src={px > 24 ? ghost96 : ghost48}
      srcSet={GHOST_SRCSET}
      sizes={`${px}px`}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
    />
  );
}

function ShapeMascot({
  look,
  color,
  size,
  mood,
  seed,
  still,
  className,
}: {
  readonly look: ShapeLook;
  readonly color: string;
  readonly size: MascotSize;
  readonly mood: MascotMood;
  readonly seed: string | undefined;
  readonly still: boolean;
  readonly className: string | undefined;
}) {
  const [faceX, faceY] = look.face;
  const box = frame(size);
  return (
    <svg
      className={`${box.className} hb-bot${still ? "" : " hb-bot--alive"}${className ? ` ${className}` : ""}`}
      data-mood={mood}
      style={{ ...box.style, ["--hb-bot-phase" as string]: `${-(seed ? botPhase(seed) : 0)}s` }}
      viewBox="0 0 100 100"
      aria-hidden
    >
      <g transform={fitTransform(look.path)}>
        <g className="hb-bot__body">
          <path d={look.path} style={{ fill: color }} />
          <g transform={`translate(${faceX} ${faceY})`}>
            <g className="hb-bot__eyes">
              <path d={FACE_EYES} style={{ fill: "var(--hb-eyes-on-color, #161616)" }} />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

/** A bot's mascot: its shape flat in its own color with the dark eyes. */
export function BotMascot({
  shape,
  color,
  size,
  mood = "idle",
  seed,
  still = false,
  className,
}: {
  readonly shape: string;
  readonly color: string;
  readonly size: MascotSize;
  /** idle breathes and blinks; working scans; waiting nods. */
  readonly mood?: MascotMood | undefined;
  /** The bot's id: its own rhythm, so a row of bots does not blink together. */
  readonly seed?: string | undefined;
  /** No motion at all (a picker's swatch). */
  readonly still?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const look = BOT_SHAPE_LOOKS[shape as keyof typeof BOT_SHAPE_LOOKS] ?? BOT_SHAPE_LOOKS.circle;
  return (
    <ShapeMascot
      look={look}
      color={color}
      size={size}
      mood={mood}
      seed={seed}
      still={still}
      className={className}
    />
  );
}

/** A removed bot: the gray pebble, still. */
export function PebbleMascot({ size }: { readonly size: MascotSize }) {
  return (
    <ShapeMascot
      look={PEBBLE}
      color="var(--hb-mascot-repo, #8e8e93)"
      size={size}
      mood="idle"
      seed={undefined}
      still
      className={undefined}
    />
  );
}
