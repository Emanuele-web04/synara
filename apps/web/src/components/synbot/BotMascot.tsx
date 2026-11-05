// FILE: BotMascot.tsx
// Purpose: A bot's face: its shape flat in its own color with the dark eye pair (ported from
//          HoloBot's Mascot.tsx), or the Synara mark for the main SynBot. Moods animate with CSS
//          (`.synbot-mascot` in index.css): idle breathes and blinks, working scans and bobs,
//          waiting nods. Reduced motion holds every mascot still.
// Layer: SynBot UI primitive
// Exports: BotMascot, BotMascotSize, botMascotMood

import type { Bot, BotMascot as BotMascotLook } from "@synara/contracts";
import { SYNARA_LOGO_PATHS } from "@synara/profile-ui/logo";

import { cn } from "~/lib/utils";

import { BOT_SHAPE_LOOKS, FACE_EYES } from "./botShapes";

/** tile: pinned tiles; row: sidebar rows; pill: the thread's name pill; card: message headers. */
export type BotMascotSize = "tile" | "row" | "pill" | "card" | "inline";

const SIZE_CLASS: Record<BotMascotSize, string> = {
  tile: "size-11",
  row: "size-7",
  pill: "size-5",
  card: "size-5",
  inline: "size-4",
};

/** The most of its box a mascot spans, so a taller outline never looks bigger than the rest. */
const MAX_EXTENT = 78;
const fits = new Map<string, number>();

function fitTransform(path: string): string | undefined {
  let fit = fits.get(path);
  if (fit === undefined) {
    const numbers = (path.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const xs = numbers.filter((_, index) => index % 2 === 0);
    const ys = numbers.filter((_, index) => index % 2 === 1);
    const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    fit = Math.min(1, MAX_EXTENT / extent);
    fits.set(path, fit);
  }
  return fit < 1 ? `translate(50 50) scale(${fit.toFixed(4)}) translate(-50 -50)` : undefined;
}

/** A stable offset from a bot's id so a row of bots does not blink together. */
function phase(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  return ((hash >>> 0) % 8000) / 1000;
}

export type BotMascotMood = "idle" | "working" | "waiting";

/** What a bot's face shows for its status. */
export function botMascotMood(status: Bot["status"]): BotMascotMood {
  return status === "working" ? "working" : status === "waiting" ? "waiting" : "idle";
}

// The Synara mark (470 x 504) centered in the 100 x 100 box at the mascots' extent.
const SYNARA_MARK_TRANSFORM = `translate(50 50) scale(${(MAX_EXTENT / 504).toFixed(4)}) translate(-235 -252)`;

export function BotMascot({
  mascot,
  size,
  mood = "idle",
  seed,
  still = false,
  className,
}: {
  readonly mascot: BotMascotLook;
  readonly size: BotMascotSize;
  readonly mood?: BotMascotMood;
  /** The bot's id: its own rhythm. */
  readonly seed?: string;
  /** No motion (pickers). */
  readonly still?: boolean;
  readonly className?: string;
}) {
  const style = { ["--synbot-phase" as string]: `${-(seed ? phase(seed) : 0)}s` };
  const classes = cn(
    "synbot-mascot shrink-0",
    !still && "synbot-mascot--alive",
    SIZE_CLASS[size],
    className,
  );
  if (mascot.shape === "synara") {
    return (
      <svg className={classes} data-mood={mood} style={style} viewBox="0 0 100 100" aria-hidden>
        <g className="synbot-mascot__body">
          <g transform={SYNARA_MARK_TRANSFORM}>
            {SYNARA_LOGO_PATHS.map((path) => (
              <path key={path} d={path} fill={mascot.color} />
            ))}
          </g>
        </g>
      </svg>
    );
  }
  const look = BOT_SHAPE_LOOKS[mascot.shape] ?? BOT_SHAPE_LOOKS.circle;
  const [faceX, faceY] = look.face;
  return (
    <svg className={classes} data-mood={mood} style={style} viewBox="0 0 100 100" aria-hidden>
      <g transform={fitTransform(look.path)}>
        <g className="synbot-mascot__body">
          <path d={look.path} fill={mascot.color} />
          <g transform={`translate(${faceX} ${faceY})`}>
            <g className="synbot-mascot__eyes">
              <path d={FACE_EYES} fill="#16181d" />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
