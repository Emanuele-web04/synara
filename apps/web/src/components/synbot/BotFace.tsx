// FILE: BotFace.tsx
// Purpose: A bot's face wherever it appears (HoloBot's bots/BotFace.tsx): the main SynBot is
//          HoloBot's chrome ghost (a still image), every other bot its shape in its color, alive
//          (`mood`: working scans, waiting nods). A bot that was removed shows as the gray pebble.
// Layer: SynBot UI primitive
// Exports: BotFace, botMood

import type { Bot, BotMascot as BotMascotLook } from "@synara/contracts";

import { BotMascot, GhostMark, PebbleMascot, type MascotMood, type MascotSize } from "./kit/Mascot";

/** What a bot's face shows for its status. */
export function botMood(status: Bot["status"] | undefined): MascotMood {
  return status === "working" ? "working" : status === "waiting" ? "waiting" : "idle";
}

/** The main SynBot wears the chrome ghost (its stored shape is the reserved "synara"). */
export function isMainLook(bot: Pick<Bot, "kind"> & { readonly mascot: BotMascotLook }): boolean {
  return bot.kind === "main" || bot.mascot.shape === "synara";
}

export function BotFace({
  bot,
  size,
  mood,
  still,
}: {
  readonly bot: Pick<Bot, "id" | "kind" | "mascot"> | null | undefined;
  readonly size: MascotSize;
  readonly mood?: MascotMood | undefined;
  /** No motion (pickers, previews). */
  readonly still?: boolean | undefined;
}) {
  if (!bot) return <PebbleMascot size={size} />;
  if (isMainLook(bot)) return <GhostMark size={size} />;
  return (
    <BotMascot
      shape={bot.mascot.shape}
      color={bot.mascot.color}
      size={size}
      mood={mood}
      seed={bot.id}
      still={still}
    />
  );
}
