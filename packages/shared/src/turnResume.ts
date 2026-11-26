import type { MessageId, OrchestrationLatestTurn, TurnId } from "@synara/contracts";

// The hidden request ID links provider checkpoint and restart recovery to the same turn.
export const TURN_RESUME_MESSAGE_ID_PREFIX = "turn-resume:";

/**
 * What Resume continues after an interrupted turn:
 * - `resend`: the newest request never started a turn (its send failed, or the
 *   app stopped while the session was still starting). It is delivered again as
 *   written, and the chat gains no message.
 * - `continue`: the latest turn reached the provider and ended interrupted or
 *   failed. A fresh turn continues from the conversation, again without a chat
 *   message. Its old provider process is gone, so commands it ran must rerun.
 */
export type TurnResumeTarget =
  | { readonly kind: "resend"; readonly messageId: MessageId }
  | {
      readonly kind: "continue";
      readonly turnId: TurnId;
      readonly state: Extract<OrchestrationLatestTurn["state"], "interrupted" | "error">;
    };

export interface TurnResumeMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant" | "system";
  /** Set once the request started a turn (projected from the turn request rows). */
  readonly turnId?: TurnId | null | undefined;
  readonly startsNewTurn?: boolean | undefined;
}

/**
 * Callers still own the live guards: nothing in flight, no pending approval or
 * question, no queued follow-up, no delivery quarantine.
 */
export function resolveTurnResumeTarget(thread: {
  readonly messages: ReadonlyArray<TurnResumeMessage>;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null;
}): TurnResumeTarget | null {
  const latestTurn = thread.latestTurn;
  if (latestTurn?.state === "running") {
    return null;
  }
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    // Anything answered after the newest request means it was delivered, even
    // on rows that predate turn request links.
    if (!message || message.role === "assistant") break;
    // Steers ride an existing turn and never start one of their own.
    if (message.role !== "user" || message.startsNewTurn === false) continue;
    if ((message.turnId ?? null) === null) {
      return { kind: "resend", messageId: message.id };
    }
    break;
  }
  if (latestTurn?.state === "interrupted" || latestTurn?.state === "error") {
    return { kind: "continue", turnId: latestTurn.turnId, state: latestTurn.state };
  }
  return null;
}
