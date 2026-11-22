// FILE: Mascot.tsx
// Purpose: Layered SVG avatars for the SynBot list, picker, chats and cards.
// Layer: SynBot kit

import type { BotMascotShape } from "@synara/contracts";
import type { CSSProperties } from "react";

import type { MascotMood } from "./mood";
import artworkUrl from "./synbot-mascots.svg?no-inline";
import "./holobot.css";

export type MascotSize = "tile" | "row" | "pill" | "card" | number;
export type { MascotMood } from "./mood";

// The contract IDs also identify existing saved looks. The SVG layers describe their outfits.
const outfits = {
  synara: "captain",
  circle: "hoodie",
  square: "terminal",
  pill: "mechanic",
  triangle: "mobile",
  hexagon: "inspector",
  gem: "navigator",
  clover: "designer",
  star: "archivist",
  drop: "night-shift",
} satisfies Record<BotMascotShape, string>;

function frame(size: MascotSize): { className: string; style?: CSSProperties } {
  return typeof size === "number"
    ? { className: "hb-mascot", style: { width: size, height: size } }
    : { className: `hb-mascot hb-mascot--${size}` };
}

/** Staggers the bots' blinks and glances by id. */
function botPhase(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  return ((hash >>> 0) % 8000) / 1000;
}

export function BotMascot({
  shape,
  color,
  size,
  mood = "idle",
  seed,
  still = false,
}: {
  readonly shape: BotMascotShape;
  readonly color: string;
  readonly size: MascotSize;
  readonly mood?: MascotMood | undefined;
  readonly seed?: string | undefined;
  readonly still?: boolean | undefined;
}) {
  const box = frame(size);
  const phase = botPhase(seed ?? `${shape}/${color}`);
  return (
    <svg
      className={`${box.className} hb-bot-tile${still ? "" : " hb-bot--alive"}`}
      data-mood={mood}
      style={{ ...box.style, ["--hb-bot-phase" as string]: `${-phase}s` }}
      viewBox="0 0 100 100"
      aria-hidden
    >
      <rect width="100" height="100" fill="#6d6375" />
      <rect width="100" height="100" fill={color} opacity=".55" />
      <g className="hb-bot__body">
        <use href={`${artworkUrl}#creature`} />
        <g className="hb-bot__eyes">
          <use href={`${artworkUrl}#eyes`} />
        </g>
        <use href={`${artworkUrl}#${outfits[shape] ?? outfits.circle}`} />
      </g>
    </svg>
  );
}

/** A removed bot uses a neutral placeholder, without any motion. */
export function PebbleMascot({ size }: { readonly size: MascotSize }) {
  return (
    <svg {...frame(size)} viewBox="0 0 100 100" aria-hidden>
      <use href={`${artworkUrl}#pebble`} />
    </svg>
  );
}
