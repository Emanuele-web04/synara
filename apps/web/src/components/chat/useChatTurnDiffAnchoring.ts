import { useMemo } from "react";
import { type MessageId, type TurnId } from "@t3tools/contracts";
import { type useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries";
import { type TimelineEntry } from "../../session-logic.timeline";
import { type ChatMessage, type TurnDiffSummary } from "../../types";
import { buildTurnDiffSummaryByAssistantMessageId } from "./MessagesTimeline.logic";

type TurnDiffSummariesState = ReturnType<typeof useTurnDiffSummaries>;

interface UseChatTurnDiffAnchoringParams {
  timelineMessages: ChatMessage[];
  timelineEntries: TimelineEntry[];
  turnDiffSummaries: TurnDiffSummariesState["turnDiffSummaries"];
  inferredCheckpointTurnCountByTurnId: TurnDiffSummariesState["inferredCheckpointTurnCountByTurnId"];
}

const EMPTY_TURN_DIFF_SUMMARY_BY_ASSISTANT_MESSAGE_ID = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID = new Map<MessageId, number>();

export function useChatTurnDiffAnchoring({
  timelineMessages,
  timelineEntries,
  turnDiffSummaries,
  inferredCheckpointTurnCountByTurnId,
}: UseChatTurnDiffAnchoringParams) {
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    if (turnDiffSummaries.length === 0) {
      return EMPTY_TURN_DIFF_SUMMARY_BY_ASSISTANT_MESSAGE_ID;
    }
    const messagesForDiffAnchoring: {
      id: MessageId;
      role: "user" | "assistant" | "system";
      turnId: TurnId | null;
    }[] = [];
    for (const message of timelineMessages) {
      messagesForDiffAnchoring.push({
        id: message.id,
        role: message.role,
        turnId: message.turnId ?? null,
      });
    }
    return buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries,
      messages: messagesForDiffAnchoring,
    });
  }, [turnDiffSummaries, timelineMessages]);

  const revertTurnCountByUserMessageId = useMemo(() => {
    if (turnDiffSummaryByAssistantMessageId.size === 0) {
      return EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID;
    }
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          continue;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  return { turnDiffSummaryByAssistantMessageId, revertTurnCountByUserMessageId };
}
