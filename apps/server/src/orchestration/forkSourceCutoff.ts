// FILE: forkSourceCutoff.ts
// Purpose: Resolve where a lazy provider fork must stop the source's native history.
// Layer: Orchestration domain helper
// Exports: resolveForkSourceCutoff, ForkSourceCutoff

import type { MessageId, OrchestrationMessage, TurnId } from "@synara/contracts";

/**
 * - `latest`: the fork point is the source's latest conversation point, so the
 *   provider may fork its native history as it stands.
 * - `turn`: native history must stop at the end of this source turn.
 * - `unavailable`: no native boundary matches the chosen point; the fork must
 *   be rebuilt from its imported transcript instead of forking at the latest point.
 */
export type ForkSourceCutoff =
  | { readonly kind: "latest" }
  | { readonly kind: "turn"; readonly turnId: TurnId }
  | { readonly kind: "unavailable"; readonly reason: string };

const isConversationMessage = (message: Pick<OrchestrationMessage, "role">) =>
  message.role === "user" || message.role === "assistant";

export function resolveForkSourceCutoff(input: {
  readonly throughMessageId: MessageId | null | undefined;
  readonly sourceMessages:
    | ReadonlyArray<Pick<OrchestrationMessage, "id" | "role" | "turnId">>
    | undefined;
}): ForkSourceCutoff {
  if (!input.throughMessageId) {
    return { kind: "latest" };
  }
  const messages = input.sourceMessages;
  if (!messages) {
    return { kind: "unavailable", reason: "source thread is unavailable" };
  }
  const index = messages.findIndex((message) => message.id === input.throughMessageId);
  const message = index >= 0 ? messages[index] : undefined;
  if (!message) {
    return { kind: "unavailable", reason: "fork message is no longer in the source thread" };
  }
  const laterMessages = messages.slice(index + 1).filter(isConversationMessage);
  if (laterMessages.length === 0) {
    return { kind: "latest" };
  }
  const turnId = message.turnId;
  if (!turnId) {
    return { kind: "unavailable", reason: "fork message has no provider turn" };
  }
  // Native history can only be cut at a turn boundary. A later message of the
  // same turn means the chosen point is mid-turn.
  if (laterMessages.some((later) => later.turnId === turnId)) {
    return { kind: "unavailable", reason: "fork message is not the end of its turn" };
  }
  return { kind: "turn", turnId };
}
