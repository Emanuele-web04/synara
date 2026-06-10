import { useMemo } from "react";
import { type MessageId, type TurnId } from "@t3tools/contracts";
import { type useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries";
import { type TimelineEntry } from "../../session-logic.timeline";
import { type ChatMessage } from "../../types";
import { buildTurnDiffSummaryByAssistantMessageId } from "./MessagesTimeline.logic";

type TurnDiffSummariesState = ReturnType<typeof useTurnDiffSummaries>;

interface UseChatTurnDiffAnchoringParams {
  timelineMessages: ChatMessage[];
  timelineEntries: TimelineEntry[];
  turnDiffSummaries: TurnDiffSummariesState["turnDiffSummaries"];
  inferredCheckpointTurnCountByTurnId: TurnDiffSummariesState["inferredCheckpointTurnCountByTurnId"];
}

export function useChatTurnDiffAnchoring({
  timelineMessages,
  timelineEntries,
  turnDiffSummaries,
  inferredCheckpointTurnCountByTurnId,
}: UseChatTurnDiffAnchoringParams) {
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
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
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  return { turnDiffSummaryByAssistantMessageId, revertTurnCountByUserMessageId };
}
