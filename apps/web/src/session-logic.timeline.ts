// Purpose: Merge messages, proposed plans, and work-log entries into ordered timeline rows
//   for the full and compact chat views.
// Layer: web pure logic (no React, no I/O).
// Exports: TimelineEntry, CompactChatTimelineEntry, deriveTimelineEntries, deriveCompactChatTimelineEntries.
import { stripProposedPlanBlocksFromText } from "./proposedPlan";
import type { WorkLogEntry } from "./session-logic.workLog";
import type { ChatMessage, ProposedPlan } from "./types";

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export type CompactChatTimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const proposedPlanTurnIds = new Set(
    proposedPlans.flatMap((proposedPlan) => (proposedPlan.turnId ? [proposedPlan.turnId] : [])),
  );
  const messageRows: TimelineEntry[] = [];
  let messageRowsSorted = true;
  let previousMessageCreatedAt: string | null = null;
  for (const message of messages) {
    const displayMessage =
      message.role === "assistant" && message.turnId && proposedPlanTurnIds.has(message.turnId)
        ? { ...message, text: stripProposedPlanBlocksFromText(message.text) }
        : message;
    if (
      displayMessage.role === "assistant" &&
      displayMessage.text.length === 0 &&
      displayMessage.turnId &&
      proposedPlanTurnIds.has(displayMessage.turnId)
    ) {
      continue;
    }
    if (previousMessageCreatedAt !== null && previousMessageCreatedAt > displayMessage.createdAt) {
      messageRowsSorted = false;
    }
    previousMessageCreatedAt = displayMessage.createdAt;
    messageRows.push({
      id: displayMessage.id,
      kind: "message",
      createdAt: displayMessage.createdAt,
      message: displayMessage,
    });
  }

  const proposedPlanRows: TimelineEntry[] = [];
  let proposedPlanRowsSorted = true;
  let previousProposedPlanCreatedAt: string | null = null;
  for (const proposedPlan of proposedPlans) {
    if (
      previousProposedPlanCreatedAt !== null &&
      previousProposedPlanCreatedAt > proposedPlan.createdAt
    ) {
      proposedPlanRowsSorted = false;
    }
    previousProposedPlanCreatedAt = proposedPlan.createdAt;
    proposedPlanRows.push({
      id: proposedPlan.id,
      kind: "proposed-plan",
      createdAt: proposedPlan.createdAt,
      proposedPlan,
    });
  }

  const workRows: TimelineEntry[] = [];
  let workRowsSorted = true;
  let previousWorkCreatedAt: string | null = null;
  for (const entry of workEntries) {
    if (previousWorkCreatedAt !== null && previousWorkCreatedAt > entry.createdAt) {
      workRowsSorted = false;
    }
    previousWorkCreatedAt = entry.createdAt;
    workRows.push({
      id: entry.id,
      kind: "work",
      createdAt: entry.createdAt,
      entry,
    });
  }

  if (!messageRowsSorted || !proposedPlanRowsSorted || !workRowsSorted) {
    return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  return mergeTimelineRows(messageRows, proposedPlanRows, workRows);
}

export function deriveCompactChatTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  workEntries: ReadonlyArray<WorkLogEntry>,
): CompactChatTimelineEntry[] {
  const messageRows: CompactChatTimelineEntry[] = [];
  let messageRowsSorted = true;
  let previousMessageCreatedAt: string | null = null;
  for (const message of messages) {
    if (previousMessageCreatedAt !== null && previousMessageCreatedAt > message.createdAt) {
      messageRowsSorted = false;
    }
    previousMessageCreatedAt = message.createdAt;
    messageRows.push({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message,
    });
  }

  const workRows: CompactChatTimelineEntry[] = [];
  let workRowsSorted = true;
  let previousWorkCreatedAt: string | null = null;
  for (const entry of workEntries) {
    if (previousWorkCreatedAt !== null && previousWorkCreatedAt > entry.createdAt) {
      workRowsSorted = false;
    }
    previousWorkCreatedAt = entry.createdAt;
    workRows.push({
      id: entry.id,
      kind: "work",
      createdAt: entry.createdAt,
      entry,
    });
  }

  if (!messageRowsSorted || !workRowsSorted) {
    return [...messageRows, ...workRows].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  return mergeCompactTimelineRows(messageRows, workRows);
}

function mergeCompactTimelineRows(
  messageRows: CompactChatTimelineEntry[],
  workRows: CompactChatTimelineEntry[],
): CompactChatTimelineEntry[] {
  const result: CompactChatTimelineEntry[] = [];
  let messageIndex = 0;
  let workIndex = 0;

  while (messageIndex < messageRows.length || workIndex < workRows.length) {
    const messageRow = messageRows[messageIndex];
    const workRow = workRows[workIndex];
    if (!messageRow || (workRow && workRow.createdAt < messageRow.createdAt)) {
      result.push(workRow);
      workIndex += 1;
    } else {
      result.push(messageRow);
      messageIndex += 1;
    }
  }

  return result;
}

function mergeTimelineRows(
  messageRows: TimelineEntry[],
  proposedPlanRows: TimelineEntry[],
  workRows: TimelineEntry[],
): TimelineEntry[] {
  const result: TimelineEntry[] = [];
  let messageIndex = 0;
  let proposedPlanIndex = 0;
  let workIndex = 0;

  while (
    messageIndex < messageRows.length ||
    proposedPlanIndex < proposedPlanRows.length ||
    workIndex < workRows.length
  ) {
    const messageRow = messageRows[messageIndex];
    const proposedPlanRow = proposedPlanRows[proposedPlanIndex];
    const workRow = workRows[workIndex];
    let nextRow = messageRow;
    let source: "message" | "proposed-plan" | "work" = "message";

    if (!nextRow || (proposedPlanRow && proposedPlanRow.createdAt < nextRow.createdAt)) {
      nextRow = proposedPlanRow;
      source = "proposed-plan";
    }
    if (!nextRow || (workRow && workRow.createdAt < nextRow.createdAt)) {
      nextRow = workRow;
      source = "work";
    }
    if (!nextRow) {
      break;
    }

    result.push(nextRow);
    if (source === "message") {
      messageIndex += 1;
    } else if (source === "proposed-plan") {
      proposedPlanIndex += 1;
    } else {
      workIndex += 1;
    }
  }

  return result;
}
