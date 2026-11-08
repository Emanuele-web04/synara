// FILE: BotFace.tsx
// Purpose: A bot's face wherever it appears (HoloBot's bots/BotFace.tsx): the main SynBot is
//          HoloBot's ghost in moving liquid metal, every other bot its shape in its color, all
//          alive (`mood`: idle glances, working scans, waiting asks, done cheers, paused dozes).
//          A bot that was removed shows as the gray pebble.
// Layer: SynBot UI primitive
// Exports: BotFace, botMood, taskMood, delegationMood

import type {
  Bot,
  BotDelegationState,
  BotMascot as BotMascotLook,
  HubWorkState,
} from "@synara/contracts";

import { BotMascot, GhostMark, PebbleMascot, type MascotMood, type MascotSize } from "./kit/Mascot";

/** What a bot's face shows for its status. */
export function botMood(status: Bot["status"] | undefined): MascotMood {
  switch (status) {
    case "working":
    case "waiting":
    case "paused":
      return status;
    default:
      return "idle";
  }
}

/** What a task's bot shows: running, waiting for the user, or done when it finished. */
export function taskMood(state: HubWorkState): MascotMood {
  switch (state) {
    case "starting":
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    default:
      return "idle";
  }
}

/** What the receiving bot of a hand-off shows: waiting on Start, running, or done. */
export function delegationMood(state: BotDelegationState): MascotMood {
  switch (state) {
    case "awaiting-start":
    case "waiting":
      return "waiting";
    case "sent":
    case "working":
      return "working";
    case "completed":
      return "done";
    default:
      return "idle";
  }
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
  if (isMainLook(bot)) return <GhostMark size={size} mood={mood} still={still} />;
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
