// FILE: usePinnedMessageActions.ts
// Purpose: Centralize sidepanel pin and notes command dispatch with optimistic rollback guards.
// Layer: Environment panel hook
// Exports: usePinnedMessageActions

import {
  PINNED_MESSAGES_MAX_COUNT,
  type MessageId,
  type PinnedMessage,
  type ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import {
  addPin,
  dispatchPinnedMessageAdd,
  dispatchPinnedMessageDoneSet,
  dispatchPinnedMessageLabelSet,
  dispatchPinnedMessageRemove,
  dispatchThreadNotes,
  isMessagePinned,
  normalizePinLabel,
  removePin,
  restorePinAtIndex,
  setPinDone,
  setPinLabel,
  togglePinDone,
} from "~/pinnedMessages";

interface UsePinnedMessageActionsInput {
  readonly activeThreadId: ThreadId | null;
  readonly pinnedMessages: readonly PinnedMessage[];
}

interface UsePinnedMessageActionsResult {
  readonly handleTogglePinMessage: (messageId: MessageId) => void;
  readonly handleTogglePinnedMessageDone: (messageId: MessageId) => void;
  readonly handleUnpinMessage: (messageId: MessageId) => void;
  readonly handleRenamePinnedMessage: (messageId: MessageId, label: string | null) => void;
  readonly handleNotesChange: (threadId: ThreadId, notes: string) => Promise<void>;
}

function matchesPinState(pin: PinnedMessage | undefined, expected: PinnedMessage): boolean {
  return (
    pin !== undefined &&
    pin.messageId === expected.messageId &&
    (pin.label ?? null) === (expected.label ?? null) &&
    pin.done === expected.done &&
    pin.pinnedAt === expected.pinnedAt
  );
}

// Keeps rapid pin clicks based on the latest optimistic ref until server events reconcile the store.
export function usePinnedMessageActions({
  activeThreadId,
  pinnedMessages,
}: UsePinnedMessageActionsInput): UsePinnedMessageActionsResult {
  const pinnedMessagesRef = useRef<readonly PinnedMessage[]>(pinnedMessages);
  const activePinnedThreadIdRef = useRef<ThreadId | null>(activeThreadId);

  useEffect(() => {
    pinnedMessagesRef.current = pinnedMessages;
    activePinnedThreadIdRef.current = activeThreadId;
  }, [activeThreadId, pinnedMessages]);

  const handlePinnedMessageDispatchError = useCallback((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Failed to update pinned message",
      description:
        error instanceof Error ? error.message : "The pinned message change could not be saved.",
    });
  }, []);

  const handleThreadNotesDispatchError = useCallback((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Failed to save notes",
      description: error instanceof Error ? error.message : "The note change could not be saved.",
    });
  }, []);

  const handleTogglePinMessage = useCallback(
    (messageId: MessageId) => {
      const threadId = activePinnedThreadIdRef.current;
      if (!threadId) {
        return;
      }
      const pins = pinnedMessagesRef.current;
      if (isMessagePinned(pins, messageId)) {
        const removedPinIndex = pins.findIndex((pin) => pin.messageId === messageId);
        const removedPin = removedPinIndex >= 0 ? pins[removedPinIndex] : undefined;
        pinnedMessagesRef.current = removePin(pins, messageId);
        void dispatchPinnedMessageRemove(threadId, messageId).catch((error) => {
          if (removedPin) {
            pinnedMessagesRef.current = restorePinAtIndex(
              pinnedMessagesRef.current,
              removedPin,
              removedPinIndex,
            );
          }
          handlePinnedMessageDispatchError(error);
        });
        return;
      }
      if (pins.length >= PINNED_MESSAGES_MAX_COUNT) {
        toastManager.add({
          type: "warning",
          title: "Pinned message limit reached",
          description: `You can keep up to ${PINNED_MESSAGES_MAX_COUNT} pinned messages in a thread.`,
        });
        return;
      }
      const pinnedAt = new Date().toISOString();
      const optimisticPin = { messageId, label: null, done: false, pinnedAt };
      pinnedMessagesRef.current = addPin(pins, messageId, pinnedAt);
      void dispatchPinnedMessageAdd(threadId, messageId).catch((error) => {
        const currentPin = pinnedMessagesRef.current.find(
          (candidate) => candidate.messageId === messageId,
        );
        if (matchesPinState(currentPin, optimisticPin)) {
          pinnedMessagesRef.current = removePin(pinnedMessagesRef.current, messageId);
        }
        handlePinnedMessageDispatchError(error);
      });
    },
    [handlePinnedMessageDispatchError],
  );

  const handleTogglePinnedMessageDone = useCallback(
    (messageId: MessageId) => {
      const threadId = activePinnedThreadIdRef.current;
      if (!threadId) {
        return;
      }
      const pin = pinnedMessagesRef.current.find((candidate) => candidate.messageId === messageId);
      if (!pin) {
        return;
      }
      const previousDone = pin.done === true;
      const done = !previousDone;
      pinnedMessagesRef.current = togglePinDone(pinnedMessagesRef.current, messageId);
      void dispatchPinnedMessageDoneSet(threadId, messageId, done).catch((error) => {
        const currentPin = pinnedMessagesRef.current.find(
          (candidate) => candidate.messageId === messageId,
        );
        if (currentPin?.done === done) {
          pinnedMessagesRef.current = setPinDone(
            pinnedMessagesRef.current,
            messageId,
            previousDone,
          );
        }
        handlePinnedMessageDispatchError(error);
      });
    },
    [handlePinnedMessageDispatchError],
  );

  const handleUnpinMessage = useCallback(
    (messageId: MessageId) => {
      const threadId = activePinnedThreadIdRef.current;
      if (!threadId) {
        return;
      }
      const removedPinIndex = pinnedMessagesRef.current.findIndex(
        (candidate) => candidate.messageId === messageId,
      );
      const removedPin =
        removedPinIndex >= 0 ? pinnedMessagesRef.current[removedPinIndex] : undefined;
      if (!removedPin) {
        return;
      }
      pinnedMessagesRef.current = removePin(pinnedMessagesRef.current, messageId);
      void dispatchPinnedMessageRemove(threadId, messageId).catch((error) => {
        pinnedMessagesRef.current = restorePinAtIndex(
          pinnedMessagesRef.current,
          removedPin,
          removedPinIndex,
        );
        handlePinnedMessageDispatchError(error);
      });
    },
    [handlePinnedMessageDispatchError],
  );

  const handleRenamePinnedMessage = useCallback(
    (messageId: MessageId, label: string | null) => {
      const threadId = activePinnedThreadIdRef.current;
      if (!threadId) {
        return;
      }
      const previousPin = pinnedMessagesRef.current.find(
        (candidate) => candidate.messageId === messageId,
      );
      const previousLabel = previousPin?.label ?? null;
      const nextLabel = normalizePinLabel(label);
      pinnedMessagesRef.current = setPinLabel(pinnedMessagesRef.current, messageId, label);
      void dispatchPinnedMessageLabelSet(threadId, messageId, label).catch((error) => {
        const currentPin = pinnedMessagesRef.current.find(
          (candidate) => candidate.messageId === messageId,
        );
        if ((currentPin?.label ?? null) === nextLabel) {
          pinnedMessagesRef.current = setPinLabel(
            pinnedMessagesRef.current,
            messageId,
            previousLabel,
          );
        }
        handlePinnedMessageDispatchError(error);
      });
    },
    [handlePinnedMessageDispatchError],
  );

  const handleNotesChange = useCallback(
    async (threadId: ThreadId, notes: string) => {
      try {
        await dispatchThreadNotes(threadId, notes);
      } catch (error) {
        handleThreadNotesDispatchError(error);
        throw error;
      }
    },
    [handleThreadNotesDispatchError],
  );

  return {
    handleTogglePinMessage,
    handleTogglePinnedMessageDone,
    handleUnpinMessage,
    handleRenamePinnedMessage,
    handleNotesChange,
  };
}
