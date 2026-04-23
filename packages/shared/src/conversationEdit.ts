// FILE: conversationEdit.ts
// Purpose: Shared policy for deciding whether a user message can be edited and replayed.
// Layer: Shared orchestration utility
// Exports: collectTailTurnIds, resolveTailUserMessageEditTarget, resolveLatestTailUserMessageEditTarget

type TurnMessageLike<TTurnId extends string = string> = {
  readonly id: string;
  readonly turnId?: TTurnId | null | undefined;
};

type EditableMessageLike = TurnMessageLike & {
  readonly role: string;
  readonly source?: string | undefined;
};

export type TailUserMessageEditTarget =
  | {
      readonly editable: true;
      readonly messageId: string;
      readonly messageIndex: number;
      readonly mode: "rollback" | "active-tail";
      readonly rollbackTurnCount: number;
      readonly removedTurnIds: ReadonlyArray<string>;
    }
  | {
      readonly editable: false;
      readonly reason:
        | "missing-message"
        | "not-user-message"
        | "non-native-message"
        | "not-latest-native-user-message"
        | "missing-turn-metadata"
        | "spans-multiple-turns";
    };

function isNativeEditableSource(source: string | undefined): boolean {
  return source === undefined || source === "native";
}

function collectUniqueTurnIds<TTurnId extends string>(
  messages: ReadonlyArray<TurnMessageLike<TTurnId>>,
): TTurnId[] {
  return [...new Set(messages.flatMap((message) => (message.turnId ? [message.turnId] : [])))];
}

export function collectTailTurnIds<TTurnId extends string>(input: {
  readonly messages: ReadonlyArray<TurnMessageLike<TTurnId>>;
  readonly messageId: string;
}): TTurnId[] {
  const messageIndex = input.messages.findIndex((message) => message.id === input.messageId);
  if (messageIndex < 0) {
    return [];
  }
  return collectUniqueTurnIds(input.messages.slice(messageIndex));
}

function findLatestNativeUserMessageIndex(messages: ReadonlyArray<EditableMessageLike>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && isNativeEditableSource(message.source)) {
      return index;
    }
  }
  return -1;
}

// Edits are only safe at the tail: either replay the last concrete turn, or replace the active prompt.
export function resolveTailUserMessageEditTarget(input: {
  readonly messages: ReadonlyArray<EditableMessageLike>;
  readonly messageId: string;
  readonly activeTurnId?: string | null | undefined;
}): TailUserMessageEditTarget {
  const messageIndex = input.messages.findIndex((message) => message.id === input.messageId);
  if (messageIndex < 0) {
    return { editable: false, reason: "missing-message" };
  }

  const message = input.messages[messageIndex];
  if (!message || message.role !== "user") {
    return { editable: false, reason: "not-user-message" };
  }
  if (!isNativeEditableSource(message.source)) {
    return { editable: false, reason: "non-native-message" };
  }

  const latestNativeUserIndex = findLatestNativeUserMessageIndex(input.messages);
  if (messageIndex !== latestNativeUserIndex) {
    return { editable: false, reason: "not-latest-native-user-message" };
  }

  const removedTurnIds = collectTailTurnIds({
    messages: input.messages,
    messageId: input.messageId,
  });
  if (removedTurnIds.length > 1) {
    return { editable: false, reason: "spans-multiple-turns" };
  }

  if (removedTurnIds.length === 1) {
    return {
      editable: true,
      messageId: message.id,
      messageIndex,
      mode: "rollback",
      rollbackTurnCount: 1,
      removedTurnIds,
    };
  }

  if (input.activeTurnId) {
    return {
      editable: true,
      messageId: message.id,
      messageIndex,
      mode: "active-tail",
      rollbackTurnCount: 0,
      removedTurnIds: [],
    };
  }

  return { editable: false, reason: "missing-turn-metadata" };
}

export function resolveLatestTailUserMessageEditTarget(input: {
  readonly messages: ReadonlyArray<EditableMessageLike>;
  readonly activeTurnId?: string | null | undefined;
}): TailUserMessageEditTarget {
  const latestNativeUserIndex = findLatestNativeUserMessageIndex(input.messages);
  const latestNativeUserMessage = input.messages[latestNativeUserIndex];
  if (!latestNativeUserMessage) {
    return { editable: false, reason: "missing-message" };
  }
  return resolveTailUserMessageEditTarget({
    messages: input.messages,
    messageId: latestNativeUserMessage.id,
    activeTurnId: input.activeTurnId,
  });
}
