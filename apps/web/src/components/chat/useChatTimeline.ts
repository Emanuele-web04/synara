import { useMemo } from "react";
import { deriveTimelineEntries } from "../../session-logic.timeline";
import { type WorkLogEntry } from "../../session-logic.workLog";
import { type ChatMessage, type ProposedPlan } from "../../types";
import { deriveTimelineMessages } from "./useChatTimeline.logic";

const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];

interface UseChatTimelineParams {
  serverMessages: ChatMessage[] | undefined;
  isSidechat: boolean;
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  optimisticUserMessages: ChatMessage[];
  proposedPlans: readonly ProposedPlan[] | undefined;
  workLogEntries: readonly WorkLogEntry[];
}

export function useChatTimeline({
  serverMessages,
  isSidechat,
  attachmentPreviewHandoffByMessageId,
  optimisticUserMessages,
  proposedPlans,
  workLogEntries,
}: UseChatTimelineParams) {
  const timelineMessages = useMemo(
    () =>
      deriveTimelineMessages({
        serverMessages: serverMessages ?? EMPTY_CHAT_MESSAGES,
        isSidechat,
        attachmentPreviewHandoffByMessageId,
        optimisticUserMessages,
      }),
    [isSidechat, serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages],
  );

  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, proposedPlans ?? [], workLogEntries),
    [proposedPlans, timelineMessages, workLogEntries],
  );

  return { timelineMessages, timelineEntries };
}
