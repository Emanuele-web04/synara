// FILE: Mascot.tsx
// Purpose: Mascots (ported from HoloBot's packages/ui Mascot.tsx and mascots.ts): soft toys seen
//          face on, one color each, drawn as inline SVG. Every bot moves calmly: it breathes,
//          blinks and glances; working, it leans and its eyes sweep; waiting on the user, it
//          tilts its head. Reduce Motion holds them still. The main SynBot is HoloBot's ghost in moving liquid metal
//          (metal/), alive like the rest.
// Layer: SynBot kit
// Exports: MascotSize, MascotMood, GhostMark, BotMascot, PebbleMascot, mascotFit, botPhase

import type { CSSProperties } from "react";

import { BOT_SHAPE_LOOKS, FACE_EYES, PEBBLE, type ShapeLook } from "./botShapes";
import { HOLOBOT } from "./holobotMark";
import { MetalMark } from "./metal/Metal";
import type { MascotMood } from "./mood";
import "./holobot.css";

/** tile: pinned bots; row: conversation rows; pill: the name pill; card: message headers and
 * task cards; or a size in px. */
export type MascotSize = "tile" | "row" | "pill" | "card" | number;

export type { MascotMood } from "./mood";

/** The most of its box a mascot spans, wide or tall: a bigger outline is drawn smaller about
 * the box's middle, so none looks bigger than the rest. */
const MASCOT_MAX_EXTENT = 78;
const fits = new Map<string, number>();
/** From this size (px) up SynBot's metal moves; below it, a still frame. */
const MOVING_METAL_MIN_PX = 24;

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

/** The main SynBot: HoloBot's ghost in liquid metal (metal/Metal.tsx), the sheen moving where
 * it is big enough to see (the tile, the name pill, conversation rows, cards' faces and art) and
 * a still frame of it in small headers; alive like every bot unless `still`. */
export function GhostMark({
  size,
  mood = "idle",
  still = false,
}: {
  readonly size: MascotSize;
  readonly mood?: MascotMood | undefined;
  readonly still?: boolean | undefined;
}) {
  const box = frame(size);
  const moving =
    !still && (typeof size === "number" ? size >= MOVING_METAL_MIN_PX : size !== "card");
  return (
    <MetalMark
      className={box.className}
      // No bigger than the other mascots: `scale` composes with the motion.
      style={{
        ...box.style,
        scale: String(mascotFit(HOLOBOT)),
        ["--hb-bot-phase" as string]: `${-botPhase("synbot")}s`,
      }}
      moving={moving}
      mood={still ? undefined : mood}
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
              <path d={FACE_EYES} style={{ fill: "var(--hb-mascot-eyes, var(--background))" }} />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

/** A bot's mascot: its shape flat in its own color, its eyes the page background. */
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
  /** idle breathes, blinks and glances; working leans and scans; waiting tilts its head with
   * its eyes up; done rocks slowly with content eyes; paused dozes. */
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
