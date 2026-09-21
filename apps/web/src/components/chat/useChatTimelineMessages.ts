import { MessageId, ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Thread } from "../../types";
import { type ChatMessage } from "../../types";
import {
  collectUserMessageBlobPreviewUrls,
  filterSidechatTranscriptMessages,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
} from "../ChatView.logic";
import type { PendingAutomationConversation } from "./useChatAutomationSetup";
const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
function revokeBlobPreviewUrlsAfterPaint(previewUrls: readonly string[]): void {
  if (previewUrls.length === 0 || typeof window === "undefined") {
    return;
  }
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }, 0);
  });
}
interface ChatTimelineMessagesInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  pendingAutomationConversation: PendingAutomationConversation | null;
}

export function useChatTimelineMessages({
  threadId,
  activeThread,
  pendingAutomationConversation,
}: ChatTimelineMessagesInput) {
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  // mirror during the commit, before events or async continuations observe the new UI with the previous render's preview URLs
  useLayoutEffect(() => {
    optimisticUserMessagesRef.current = optimisticUserMessages;
  }, [optimisticUserMessages]);

  // the pane stays mounted across thread switches — clear outgoing optimistic messages before paint so they never appear in the newly selected thread
  useLayoutEffect(() => {
    setOptimisticUserMessages((existing) => {
      if (existing.length === 0) return existing;
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
  }, [threadId]);

  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});

  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});

  useLayoutEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const replacedPreviewUrls = previousPreviewUrls.filter(
      (previewUrl) => !previewUrls.includes(previewUrl),
    );
    revokeBlobPreviewUrlsAfterPaint(replacedPreviewUrls);
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
      // let React swap the transcript back to persisted /attachments URLs before invalidating blob previews still mounted in the old row
      if (currentPreviewUrls) {
        revokeBlobPreviewUrlsAfterPaint(currentPreviewUrls);
      }
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = filterSidechatTranscriptMessages(
      serverMessages ?? [],
      Boolean(activeThread?.sidechatSourceThreadId),
    );
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // spread only fires for the few messages that changed; in-place mutation would break React's immutable state contract
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    // ephemeral setup bubbles render at the tail, gated on the originating thread — the reset effect runs after first render so the guard must be here too
    const setupBubbles =
      pendingAutomationConversation && pendingAutomationConversation.threadId === threadId
        ? pendingAutomationConversation.bubbles
        : [];
    // optimistic messages exist only briefly after a send; skip the full-transcript id Set on the common streaming-flush path
    let pendingMessages = optimisticUserMessages;
    if (optimisticUserMessages.length > 0) {
      const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
      pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    }
    const withPending =
      pendingMessages.length === 0
        ? serverMessagesWithPreviewHandoff
        : [...serverMessagesWithPreviewHandoff, ...pendingMessages];
    return setupBubbles.length === 0 ? withPending : [...withPending, ...setupBubbles];
  }, [
    activeThread?.sidechatSourceThreadId,
    serverMessages,
    attachmentPreviewHandoffByMessageId,
    optimisticUserMessages,
    pendingAutomationConversation,
    threadId,
  ]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    // no optimistic messages → skip rebuilding the id Set on every streaming flush
    if (optimisticUserMessages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);
  return {
    timelineMessages,
    optimisticUserMessages,
    setOptimisticUserMessages,
  };
}
