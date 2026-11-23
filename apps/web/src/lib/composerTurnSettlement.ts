import {
  OrchestrationSettleTurnDispatchInput,
  MessageId,
  type NativeApi,
  type ThreadId,
} from "@synara/contracts";
import { Schema } from "effect";

import type { ComposerThreadDraftState } from "../composerDraftDomain";
import { flushComposerDraftStorage, useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { executionKey } from "./hosts/executionContext";
import { executionSessionStorage, executionStorage } from "./hosts/executionStorage";
import { isRequestOutcomeUnknown } from "./requestOutcome";

type ClientThreadTurnStartCommand = typeof OrchestrationSettleTurnDispatchInput.Type.command;

type PendingComposerTurn = {
  readonly command: ClientThreadTurnStartCommand;
  readonly queuedTurnId?: string | undefined;
  readonly restoredDraft?: string | undefined;
  readonly dispatchInProgress?: boolean | undefined;
};

export const COMPOSER_TURN_UNCERTAIN =
  "Message delivery could not be checked. Reconnect and check the conversation before sending again.";

const decodePendingComposerTurn = Schema.decodeUnknownSync(
  Schema.Struct({
    command: OrchestrationSettleTurnDispatchInput.fields.command,
    queuedTurnId: Schema.optional(Schema.String),
    restoredDraft: Schema.optional(Schema.String),
    dispatchInProgress: Schema.optional(Schema.Boolean),
  }),
);
class ComposerTurnOwnershipError extends Error {
  constructor() {
    super(COMPOSER_TURN_UNCERTAIN);
  }
}

export function composerTurnMayHaveBeenSent(error: unknown): boolean {
  return (
    error instanceof ComposerTurnOwnershipError ||
    isRequestOutcomeUnknown(error, { requireSent: true })
  );
}

const activeClaims = new Set<string>();
const storageKey = (threadId: ThreadId) =>
  `synara:composer-turn-settlement:${encodeURIComponent(threadId)}`;
const acceptedQueuePrefix = (threadId: ThreadId) => `${storageKey(threadId)}:accepted:`;
const acceptedQueueKey = (threadId: ThreadId, queuedTurnId: string) =>
  `${acceptedQueuePrefix(threadId)}${encodeURIComponent(queuedTurnId)}`;

async function claimComposerTurn<A>(
  threadId: ThreadId,
  run: (hasSharedLock: boolean) => Promise<A>,
): Promise<A> {
  const key = executionKey(storageKey(threadId));
  if (activeClaims.has(key)) throw new ComposerTurnOwnershipError();
  activeClaims.add(key);
  try {
    // Web Locks require a secure context. Plain HTTP LAN clients still coordinate
    // locally and must leave an apparently live writer in another window alone.
    const locks = globalThis.navigator?.locks;
    if (!locks) return await run(false);
    return await locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new ComposerTurnOwnershipError();
      return run(true);
    });
  } finally {
    activeClaims.delete(key);
  }
}

function readPendingComposerTurn(
  threadId: ThreadId,
  messageId?: MessageId,
): PendingComposerTurn | null {
  try {
    for (const storage of [executionStorage, executionSessionStorage]) {
      const stored = storage.getItem(storageKey(threadId));
      if (stored === null) continue;
      const pending = decodePendingComposerTurn(JSON.parse(stored));
      if (pending.command.threadId !== threadId) throw new ComposerTurnOwnershipError();
      if (messageId === undefined || pending.command.message.messageId === messageId)
        return pending;
    }
    return null;
  } catch {
    throw new ComposerTurnOwnershipError();
  }
}

function writePendingComposerTurn(
  threadId: ThreadId,
  pending: PendingComposerTurn,
  remove = false,
) {
  const storage = pending.queuedTurnId !== undefined ? executionStorage : executionSessionStorage;
  const key = storageKey(threadId);
  if (remove) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(pending));
}

function hasAcceptedMessage(threadId: ThreadId, messageId: MessageId): boolean {
  const thread = getThreadFromState(useStore.getState(), threadId);
  return (
    thread?.claudeCacheReview?.messageId === messageId ||
    (thread?.messages.some((message) => message.role === "user" && message.id === messageId) ??
      false)
  );
}

function draftSignature(draft: ComposerThreadDraftState): string {
  return JSON.stringify([
    draft.prompt,
    [...new Set([...draft.images, ...draft.persistedAttachments].map(({ id }) => id))].toSorted(),
    draft.files.map(({ id }) => id),
    draft.assistantSelections,
    draft.browserAnnotations,
    draft.terminalContexts,
    draft.fileComments,
    draft.pastedTexts,
    draft.pullRequestContexts,
    draft.skills,
    draft.mentions,
  ]);
}

export function ownsUnsettledComposerTurn(threadId: ThreadId, messageId: MessageId): boolean {
  try {
    return readPendingComposerTurn(threadId, messageId) !== null;
  } catch {
    return false;
  }
}

export function rememberRestoredComposerTurn(threadId: ThreadId, messageId: MessageId) {
  try {
    const pending = readPendingComposerTurn(threadId, messageId);
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    if (
      pending?.queuedTurnId === undefined &&
      pending?.command.message.messageId === messageId &&
      draft
    ) {
      writePendingComposerTurn(threadId, { ...pending, restoredDraft: draftSignature(draft) });
    }
  } catch {
    // Preserve the live draft when its recovery metadata cannot be persisted.
  }
}

function commitAcceptedComposerTurn(threadId: ThreadId, pending: PendingComposerTurn) {
  const { command, queuedTurnId, restoredDraft } = pending;
  const draftStore = useComposerDraftStore.getState();
  const draft = draftStore.draftsByThreadId[threadId];
  try {
    if (queuedTurnId !== undefined) {
      // A second window may still hold an earlier snapshot of this queue item.
      executionStorage.setItem(acceptedQueueKey(threadId, queuedTurnId), command.message.messageId);
      draftStore.removeQueuedTurn(threadId, queuedTurnId);
    } else if (draft && restoredDraft === draftSignature(draft)) {
      draftStore.clearComposerContent(threadId);
    }
    // Persist consumption before retiring the original delivery identity.
    flushComposerDraftStorage();
    writePendingComposerTurn(threadId, pending, true);
  } catch {
    // Keep the receipt owner until a later settlement can persist consumption.
  }
}

export function dispatchOwnedComposerTurn(
  api: NativeApi,
  command: ClientThreadTurnStartCommand,
  queuedTurnId?: string,
) {
  const { threadId, message } = command;
  return claimComposerTurn(threadId, async () => {
    if (
      readPendingComposerTurn(threadId) ||
      (queuedTurnId !== undefined &&
        executionStorage.getItem(acceptedQueueKey(threadId, queuedTurnId)))
    ) {
      throw new ComposerTurnOwnershipError();
    }
    const pending = { command, queuedTurnId, dispatchInProgress: true };
    writePendingComposerTurn(threadId, pending);
    try {
      await api.orchestration.dispatchCommand(command);
    } catch (error) {
      if (!hasAcceptedMessage(threadId, message.messageId)) {
        if (!isRequestOutcomeUnknown(error, { requireSent: true })) {
          writePendingComposerTurn(threadId, pending, true);
        } else {
          try {
            writePendingComposerTurn(threadId, { ...pending, dispatchInProgress: false });
          } catch {
            // The earlier record remains owned and can still be checked after reconnect.
          }
        }
        throw error;
      }
    }
    commitAcceptedComposerTurn(threadId, pending);
  });
}

type ComposerTurnSettlement =
  | { status: "none" | "rejected" | "unknown" }
  | { status: "accepted"; queuedTurnId: string | undefined; messageId: MessageId };

export async function settlePendingComposerTurn(
  api: NativeApi,
  threadId: ThreadId,
  queuedTurnId?: string,
): Promise<ComposerTurnSettlement> {
  try {
    return await claimComposerTurn(threadId, async (hasSharedLock) => {
      if (queuedTurnId !== undefined) {
        const receipt = executionStorage.getItem(acceptedQueueKey(threadId, queuedTurnId));
        if (receipt !== null) {
          useComposerDraftStore.getState().removeQueuedTurn(threadId, queuedTurnId);
          flushComposerDraftStorage();
          return { status: "accepted", queuedTurnId, messageId: MessageId.makeUnsafe(receipt) };
        }
      }
      const pending = readPendingComposerTurn(threadId);
      if (!pending) return { status: "none" };
      const { command } = pending;
      if (!hasAcceptedMessage(threadId, command.message.messageId)) {
        if (!hasSharedLock && pending.queuedTurnId !== undefined && pending.dispatchInProgress) {
          return { status: "unknown" };
        }
        const result = await api.orchestration.settleTurnDispatch?.({ command });
        if (!result) return { status: "unknown" };
        if (result.status === "rejected") {
          writePendingComposerTurn(threadId, pending, true);
          return { status: "rejected" };
        }
      }
      commitAcceptedComposerTurn(threadId, pending);
      return {
        status: "accepted",
        queuedTurnId: pending.queuedTurnId,
        messageId: command.message.messageId,
      };
    });
  } catch {
    return { status: "unknown" };
  }
}

export async function clearDeletedThreadComposerTurnSettlement(threadId: ThreadId): Promise<void> {
  try {
    await claimComposerTurn(threadId, async () => {
      const key = storageKey(threadId);
      const prefix = acceptedQueuePrefix(threadId);
      executionStorage.removeItem(key);
      executionSessionStorage.removeItem(key);
      for (let index = executionStorage.length - 1; index >= 0; index--) {
        const storedKey = executionStorage.key(index);
        if (storedKey?.startsWith(prefix)) executionStorage.removeItem(storedKey);
      }
    });
  } catch {
    // Keeping the record is safe if a live writer owns it or storage is unavailable.
  }
}
