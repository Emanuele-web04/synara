import { useMemo } from "react";
import { deriveTimelineEntries } from "../../session-logic.timeline";
import { type WorkLogEntry } from "../../session-logic.workLog";
import { type ChatMessage, type ProposedPlan } from "../../types";
import { filterSidechatTranscriptMessages } from "../ChatView.logic";

interface UseChatTimelineParams {
  serverMessages: ChatMessage[] | undefined;
  isSidechat: boolean;
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  optimisticUserMessages: ChatMessage[];
  proposedPlans: ProposedPlan[] | undefined;
  workLogEntries: WorkLogEntry[];
}

export function useChatTimeline({
  serverMessages,
  isSidechat,
  attachmentPreviewHandoffByMessageId,
  optimisticUserMessages,
  proposedPlans,
  workLogEntries,
}: UseChatTimelineParams) {
  const timelineMessages = useMemo(() => {
    const messages = filterSidechatTranscriptMessages(serverMessages ?? [], isSidechat);
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
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

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [isSidechat, serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);

  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, proposedPlans ?? [], workLogEntries),
    [proposedPlans, timelineMessages, workLogEntries],
  );

  return { timelineMessages, timelineEntries };
}
