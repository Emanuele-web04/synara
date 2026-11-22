// FILE: BotFace.tsx
// Purpose: A bot's outfit and state wherever its face appears in SynBot.
//          A bot that was removed shows as the gray pebble.
// Layer: SynBot UI primitive
// Exports: BotFace, botMood, taskMood, delegationMood

import type { Bot, BotDelegationState, HubWorkState } from "@synara/contracts";

import { BotMascot, PebbleMascot, type MascotMood, type MascotSize } from "./kit/Mascot";

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
  return (
    <BotMascot
      shape={bot.kind === "main" ? "synara" : bot.mascot.shape}
      color={bot.mascot.color}
      size={size}
      mood={mood}
      seed={bot.id}
      still={still}
    />
  );
}
