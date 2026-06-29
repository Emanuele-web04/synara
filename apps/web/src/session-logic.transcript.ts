// FILE: session-logic.transcript.ts
// Purpose: Canonical typed transcript row model bridging provider runtime items to chat rendering.
// Layer: web pure logic (no React, no I/O).
// Exports: TranscriptRow, deriveTranscriptRows, deriveTranscriptComposerState, state tables.

import {
  ApprovalRequestId,
  type OrchestrationProviderItem,
  type RuntimeItemStatus,
  type TurnId,
} from "@t3tools/contracts";

import type { PendingApproval, PendingUserInput } from "./session-logic.pending";
import type { WorkLogEntry } from "./session-logic.workLog";
import type { ChatMessage, ProposedPlan, ThreadSession } from "./types";

export type TranscriptRowKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "plan"
  | "work"
  | "diff"
  | "approval"
  | "input"
  | "status"
  | "error"
  | "fallback";

export type TranscriptRowSource =
  | "provider-item"
  | "legacy-message"
  | "legacy-activity"
  | "derived-state";

interface TranscriptRowBase {
  key: string;
  kind: TranscriptRowKind;
  createdAt: string;
  label: string;
  ariaLabel: string;
  source: TranscriptRowSource;
  turnId?: TurnId | null;
}

export type TranscriptRow =
  | (TranscriptRowBase & {
      kind: "user" | "assistant";
      text: string;
      message?: ChatMessage;
      providerItem?: OrchestrationProviderItem;
      streaming: boolean;
    })
  | (TranscriptRowBase & {
      kind: "reasoning" | "plan" | "work" | "diff" | "status" | "error" | "fallback";
      text: string;
      status?: RuntimeItemStatus;
      providerItem?: OrchestrationProviderItem;
      proposedPlan?: ProposedPlan;
      workEntry?: WorkLogEntry;
    })
  | (TranscriptRowBase & {
      kind: "approval";
      approval: PendingApproval;
    })
  | (TranscriptRowBase & {
      kind: "input";
      userInput: PendingUserInput;
    });

export interface DeriveTranscriptRowsInput {
  messages: readonly ChatMessage[];
  providerItems?: readonly OrchestrationProviderItem[];
  proposedPlans?: readonly ProposedPlan[];
  workEntries?: readonly WorkLogEntry[];
  pendingApprovals?: readonly PendingApproval[];
  pendingUserInputs?: readonly PendingUserInput[];
}

export type TranscriptComposerBlockerKind =
  | "pending-approval"
  | "pending-user-input"
  | "plan-follow-up"
  | "disconnected"
  | "normal";

export interface TranscriptComposerState {
  kind: TranscriptComposerBlockerKind;
  label: string;
  disabled: boolean;
  sourceId?: string;
}

export interface DeriveTranscriptComposerStateInput {
  pendingApprovals?: readonly PendingApproval[];
  pendingUserInputs?: readonly PendingUserInput[];
  planFollowUp?: { id: string; title: string | null } | null;
  isConnected: boolean;
  session?: Pick<ThreadSession, "orchestrationStatus" | "status"> | null;
}

export const TRANSCRIPT_COMPOSER_BLOCKER_PRIORITY: readonly TranscriptComposerBlockerKind[] = [
  "pending-approval",
  "pending-user-input",
  "plan-follow-up",
  "disconnected",
  "normal",
];

export const TRANSCRIPT_STATE_TABLE: ReadonlyArray<{
  state:
    | "empty-thread"
    | "optimistic-send"
    | "streaming-text"
    | "tool-only-activity"
    | "approval-wait"
    | "pending-user-input"
    | "plan-follow-up"
    | "disconnected-reconnect"
    | "stale-request"
    | "settled-collapse"
    | "error-flush";
  transcriptRows: readonly TranscriptRowKind[];
  composerBlocker: TranscriptComposerBlockerKind;
  scrollFollowMode: "none" | "message" | "transcript";
}> = [
  {
    state: "empty-thread",
    transcriptRows: [],
    composerBlocker: "normal",
    scrollFollowMode: "none",
  },
  {
    state: "optimistic-send",
    transcriptRows: ["user"],
    composerBlocker: "normal",
    scrollFollowMode: "message",
  },
  {
    state: "streaming-text",
    transcriptRows: ["user", "reasoning", "assistant"],
    composerBlocker: "normal",
    scrollFollowMode: "message",
  },
  {
    state: "tool-only-activity",
    transcriptRows: ["user", "work"],
    composerBlocker: "normal",
    scrollFollowMode: "transcript",
  },
  {
    state: "approval-wait",
    transcriptRows: ["work", "approval"],
    composerBlocker: "pending-approval",
    scrollFollowMode: "transcript",
  },
  {
    state: "pending-user-input",
    transcriptRows: ["input"],
    composerBlocker: "pending-user-input",
    scrollFollowMode: "transcript",
  },
  {
    state: "plan-follow-up",
    transcriptRows: ["plan"],
    composerBlocker: "plan-follow-up",
    scrollFollowMode: "message",
  },
  {
    state: "disconnected-reconnect",
    transcriptRows: ["status"],
    composerBlocker: "disconnected",
    scrollFollowMode: "none",
  },
  {
    state: "stale-request",
    transcriptRows: ["status"],
    composerBlocker: "normal",
    scrollFollowMode: "none",
  },
  {
    state: "settled-collapse",
    transcriptRows: ["user", "reasoning", "work", "assistant"],
    composerBlocker: "normal",
    scrollFollowMode: "none",
  },
  {
    state: "error-flush",
    transcriptRows: ["work", "error"],
    composerBlocker: "normal",
    scrollFollowMode: "transcript",
  },
];

export function deriveTranscriptRows(input: DeriveTranscriptRowsInput): TranscriptRow[] {
  const providerItems = input.providerItems ?? [];
  const proposedPlans = input.proposedPlans ?? [];
  const workEntries = input.workEntries ?? [];
  const pendingApprovals = input.pendingApprovals ?? [];
  const pendingUserInputs = input.pendingUserInputs ?? [];
  const providerUserTurnIds = turnIdsForProviderItems(providerItems, "user_message");
  const providerAssistantTurnIds = turnIdsForProviderItems(providerItems, "assistant_message");
  const providerPlanTurnIds = turnIdsForProviderItems(providerItems, "plan");
  const rows: TranscriptRow[] = [];

  for (const message of input.messages) {
    if (message.role === "system") {
      rows.push(statusRowFromMessage(message));
      continue;
    }
    if (message.role === "user" && message.turnId && providerUserTurnIds.has(message.turnId)) {
      continue;
    }
    if (
      message.role === "assistant" &&
      message.turnId &&
      providerAssistantTurnIds.has(message.turnId)
    ) {
      continue;
    }
    rows.push(rowFromMessage(message));
  }

  for (const item of providerItems) {
    rows.push(rowFromProviderItem(item));
  }

  for (const proposedPlan of proposedPlans) {
    if (proposedPlan.turnId && providerPlanTurnIds.has(proposedPlan.turnId)) {
      continue;
    }
    rows.push(rowFromProposedPlan(proposedPlan));
  }

  for (const workEntry of workEntries) {
    if (providerItems.length > 0 && workEntry.itemType) {
      continue;
    }
    rows.push(rowFromWorkEntry(workEntry));
  }

  for (const approval of pendingApprovals) {
    rows.push(rowFromApproval(approval));
  }

  for (const userInput of pendingUserInputs) {
    rows.push(rowFromUserInput(userInput));
  }

  return rows.toSorted(compareTranscriptRows);
}

export function deriveTranscriptComposerState(
  input: DeriveTranscriptComposerStateInput,
): TranscriptComposerState {
  const activeApproval = input.pendingApprovals?.[0];
  if (activeApproval) {
    return {
      kind: "pending-approval",
      label: "Approval required",
      disabled: true,
      sourceId: activeApproval.requestId,
    };
  }

  const activeUserInput = input.pendingUserInputs?.[0];
  if (activeUserInput) {
    return {
      kind: "pending-user-input",
      label: "Input required",
      disabled: true,
      sourceId: activeUserInput.requestId,
    };
  }

  if (input.planFollowUp) {
    return {
      kind: "plan-follow-up",
      label: input.planFollowUp.title ?? "Plan ready",
      disabled: false,
      sourceId: input.planFollowUp.id,
    };
  }

  if (!input.isConnected || input.session?.status === "closed") {
    return {
      kind: "disconnected",
      label: "Disconnected",
      disabled: true,
    };
  }

  return {
    kind: "normal",
    label: "Ready",
    disabled: false,
  };
}

function turnIdsForProviderItems(
  providerItems: readonly OrchestrationProviderItem[],
  itemType: OrchestrationProviderItem["itemType"],
): Set<TurnId> {
  const turnIds = new Set<TurnId>();
  for (const item of providerItems) {
    if (item.itemType === itemType && item.turnId) {
      turnIds.add(item.turnId);
    }
  }
  return turnIds;
}

function rowFromMessage(message: ChatMessage): TranscriptRow {
  const kind = message.role === "user" ? "user" : "assistant";
  const label = kind === "user" ? "User message" : "Assistant response";
  return {
    key: `message:${message.id}`,
    kind,
    createdAt: message.createdAt,
    label,
    ariaLabel: label,
    source: "legacy-message",
    turnId: message.turnId ?? null,
    text: message.text,
    message,
    streaming: message.streaming,
  };
}

function statusRowFromMessage(message: ChatMessage): TranscriptRow {
  return {
    key: `message:${message.id}`,
    kind: "status",
    createdAt: message.createdAt,
    label: "System message",
    ariaLabel: "System message",
    source: "legacy-message",
    turnId: message.turnId ?? null,
    text: message.text,
  };
}

function rowFromProviderItem(item: OrchestrationProviderItem): TranscriptRow {
  switch (item.itemType) {
    case "user_message":
      return providerTextRow(item, "user", "User message");
    case "assistant_message":
      return providerTextRow(item, "assistant", "Assistant response");
    case "reasoning":
      return providerItemRow(item, "reasoning", "Reasoning");
    case "plan":
      return providerItemRow(item, "plan", "Plan");
    case "file_change":
      return providerItemRow(item, "diff", item.title ?? "File changes");
    case "error":
      return providerItemRow(item, "error", item.title ?? "Error");
    case "review_entered":
    case "review_exited":
    case "context_compaction":
      return providerItemRow(item, "status", item.title ?? "Status");
    case "command_execution":
    case "mcp_tool_call":
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
    case "web_search":
    case "image_view":
    case "image_generation":
      return providerItemRow(item, "work", item.title ?? "Work");
    case "unknown":
      return providerItemRow(item, "fallback", item.title ?? "Provider item");
  }
}

function providerTextRow(
  item: OrchestrationProviderItem,
  kind: "user" | "assistant",
  label: string,
): TranscriptRow {
  return {
    key: `provider-item:${item.id}`,
    kind,
    createdAt: item.createdAt,
    label,
    ariaLabel: `${label}: ${item.status}`,
    source: "provider-item",
    turnId: item.turnId ?? null,
    text: providerItemText(item),
    providerItem: item,
    streaming: item.status === "inProgress",
  };
}

function providerItemRow(
  item: OrchestrationProviderItem,
  kind: "reasoning" | "plan" | "work" | "diff" | "status" | "error" | "fallback",
  label: string,
): TranscriptRow {
  return {
    key: `provider-item:${item.id}`,
    kind,
    createdAt: item.createdAt,
    label,
    ariaLabel: `${label}: ${item.status}`,
    source: "provider-item",
    turnId: item.turnId ?? null,
    text: providerItemText(item),
    status: item.status,
    providerItem: item,
  };
}

function providerItemText(item: OrchestrationProviderItem): string {
  const contentText = item.content
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("");
  return contentText || item.detail || item.title || "";
}

function rowFromProposedPlan(proposedPlan: ProposedPlan): TranscriptRow {
  return {
    key: `proposed-plan:${proposedPlan.id}`,
    kind: "plan",
    createdAt: proposedPlan.createdAt,
    label: "Plan",
    ariaLabel: "Plan",
    source: "legacy-message",
    turnId: proposedPlan.turnId ?? null,
    text: proposedPlan.planMarkdown,
    proposedPlan,
  };
}

function rowFromWorkEntry(workEntry: WorkLogEntry): TranscriptRow {
  if (workEntry.requestKind) {
    return {
      key: `work:${workEntry.id}`,
      kind: "approval",
      createdAt: workEntry.createdAt,
      label: workEntry.label,
      ariaLabel: workEntry.label,
      source: "legacy-activity",
      turnId: workEntry.turnId ?? null,
      approval: {
        requestId: ApprovalRequestId.makeUnsafe(workEntry.id),
        requestKind: workEntry.requestKind,
        createdAt: workEntry.createdAt,
        ...(workEntry.detail ? { detail: workEntry.detail } : {}),
      },
    };
  }
  const kind =
    workEntry.tone === "error" ? "error" : workEntry.itemType === "file_change" ? "diff" : "work";
  return {
    key: `work:${workEntry.id}`,
    kind,
    createdAt: workEntry.createdAt,
    label: workEntry.label,
    ariaLabel: workEntry.label,
    source: "legacy-activity",
    turnId: workEntry.turnId ?? null,
    text: workEntry.detail ?? workEntry.preview ?? workEntry.label,
    workEntry,
  };
}

function rowFromApproval(approval: PendingApproval): TranscriptRow {
  return {
    key: `approval:${approval.requestId}`,
    kind: "approval",
    createdAt: approval.createdAt,
    label: "Approval request",
    ariaLabel: "Approval request",
    source: "derived-state",
    approval,
  };
}

function rowFromUserInput(userInput: PendingUserInput): TranscriptRow {
  return {
    key: `user-input:${userInput.requestId}`,
    kind: "input",
    createdAt: userInput.createdAt,
    label: "User input request",
    ariaLabel: "User input request",
    source: "derived-state",
    userInput,
  };
}

function compareTranscriptRows(left: TranscriptRow, right: TranscriptRow): number {
  const byTime = left.createdAt.localeCompare(right.createdAt);
  if (byTime !== 0) {
    return byTime;
  }
  const byKind = transcriptRowKindRank(left.kind) - transcriptRowKindRank(right.kind);
  if (byKind !== 0) {
    return byKind;
  }
  return transcriptRowSourceRank(left.source) - transcriptRowSourceRank(right.source);
}

function transcriptRowKindRank(kind: TranscriptRowKind): number {
  switch (kind) {
    case "user":
      return 0;
    case "reasoning":
      return 1;
    case "work":
    case "diff":
    case "status":
      return 2;
    case "plan":
      return 3;
    case "approval":
    case "input":
      return 4;
    case "assistant":
      return 5;
    case "error":
      return 6;
    case "fallback":
      return 7;
  }
}

function transcriptRowSourceRank(source: TranscriptRowSource): number {
  switch (source) {
    case "provider-item":
      return 0;
    case "derived-state":
      return 1;
    case "legacy-message":
      return 2;
    case "legacy-activity":
      return 3;
  }
}
