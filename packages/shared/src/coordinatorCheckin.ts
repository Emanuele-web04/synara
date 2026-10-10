// FILE: coordinatorCheckin.ts
// Purpose: Classify coordinator heartbeat ("check-in") turns so the transcript
// can hide them entirely while the group activity log can summarize what a
// check-in found.
// Layer: shared runtime logic (server ingest + web timeline derivation).

/** Exact reply the heartbeat prompt asks for when a check-in has nothing to report. */
export const COORDINATOR_CHECKIN_SILENT_SENTINEL = "SILENT";

/** A check-in is silent when the coordinator replies with just the sentinel
 * (case-insensitive, trailing punctuation tolerated). Any other text means it
 * has something for the user and the reply stays in the transcript. */
export const isSilentCoordinatorCheckinReply = (text: string): boolean => {
  const normalized = text
    .trim()
    .replace(/[\s.!…]+$/u, "")
    .toUpperCase();
  return normalized.length === 0 || normalized === COORDINATOR_CHECKIN_SILENT_SENTINEL;
};

export interface CoordinatorCheckinMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly turnId?: string | null | undefined;
  readonly dispatchOrigin?: string | undefined;
}

/** Check-in turns are the ones whose user message was dispatched by the
 * automation machinery (heartbeat runs), not by the user or the gateway. */
export const isCoordinatorCheckinUserMessage = (message: {
  readonly role: string;
  readonly dispatchOrigin?: string | undefined;
}): boolean => message.role === "user" && message.dispatchOrigin === "automation";

/**
 * Classify a completed turn against the thread's messages: it is a check-in
 * when the turn's user message was automation-dispatched. Returns the first
 * assistant reply bound to the turn (or the next assistant message as a
 * positional fallback) plus whether it counts as silent; null for ordinary
 * turns.
 */
export const coordinatorCheckinTurnReport = (input: {
  readonly messages: ReadonlyArray<CoordinatorCheckinMessage>;
  readonly turnId: string;
}): { readonly silent: boolean; readonly replyText: string | null } | null => {
  const userIndex = input.messages.findIndex(
    (message) =>
      message.role === "user" &&
      message.dispatchOrigin === "automation" &&
      message.turnId === input.turnId,
  );
  if (userIndex < 0) return null;
  const reply =
    input.messages.find(
      (message) => message.role === "assistant" && message.turnId === input.turnId,
    ) ??
    input.messages.find((message, index) => index > userIndex && message.role === "assistant") ??
    null;
  const replyText = reply === null ? null : reply.text;
  return {
    silent: replyText === null || isSilentCoordinatorCheckinReply(replyText),
    replyText,
  };
};

/**
 * Remove check-in turns from a conversation's message list. Automation user
 * messages never render; their assistant replies render only when non-silent.
 * Returns the filtered messages plus the turnIds that are check-ins, so callers
 * can also drop work/plan rows bound to those turns.
 */
export const suppressCoordinatorCheckinMessages = <T extends CoordinatorCheckinMessage>(
  messages: ReadonlyArray<T>,
): { readonly messages: T[]; readonly checkinTurnIds: ReadonlySet<string> } => {
  const checkinTurnIds = new Set<string>();
  const kept: T[] = [];
  let pendingCheckinTurnId: string | null | undefined;
  let checkinOpen = false;
  for (const message of messages) {
    if (isCoordinatorCheckinUserMessage(message)) {
      if (message.turnId !== null && message.turnId !== undefined) {
        checkinTurnIds.add(message.turnId);
      }
      pendingCheckinTurnId = message.turnId ?? null;
      checkinOpen = true;
      continue;
    }
    if (message.role === "user") {
      checkinOpen = false;
      pendingCheckinTurnId = undefined;
      kept.push(message);
      continue;
    }
    if (message.role === "assistant" && checkinOpen) {
      const matchesCheckinTurn =
        pendingCheckinTurnId === null ||
        message.turnId === null ||
        message.turnId === undefined ||
        message.turnId === pendingCheckinTurnId;
      if (matchesCheckinTurn) {
        checkinOpen = false;
        pendingCheckinTurnId = undefined;
        if (isSilentCoordinatorCheckinReply(message.text)) continue;
      }
      // An assistant message bound to another turn leaves the check-in pending;
      // its own reply is evaluated when it arrives.
    }
    kept.push(message);
  }
  return { messages: kept, checkinTurnIds };
};
