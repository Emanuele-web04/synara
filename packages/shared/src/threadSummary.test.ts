import {
  EventId,
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveThreadSummaryMetadata } from "./threadSummary";

describe("deriveThreadSummaryMetadata", () => {
  it("derives sidebar summary metadata from thread state", () => {
    const messages: OrchestrationMessage[] = [
      {
        id: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: "hello",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
      },
      {
        id: MessageId.makeUnsafe("message-2"),
        role: "user",
        text: "ship it",
        turnId: TurnId.makeUnsafe("turn-2"),
        streaming: false,
        source: "native",
        createdAt: "2026-02-27T00:03:00.000Z",
        updatedAt: "2026-02-27T00:03:00.000Z",
      },
    ];
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("activity-1"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Approval requested",
        payload: {
          requestId: "approval-1",
          requestKind: "command",
        },
        sequence: 1,
        turnId: TurnId.makeUnsafe("turn-2"),
        createdAt: "2026-02-27T00:04:00.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-2"),
        tone: "info",
        kind: "user-input.requested",
        summary: "Questions requested",
        payload: {
          requestId: "input-1",
          questions: [
            {
              id: "question-1",
              header: "Confirm",
              question: "Ship now?",
              options: [{ label: "Yes", description: "Ship it." }],
            },
          ],
        },
        sequence: 2,
        turnId: TurnId.makeUnsafe("turn-2"),
        createdAt: "2026-02-27T00:05:00.000Z",
      },
    ];
    const proposedPlans: OrchestrationProposedPlan[] = [
      {
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-2"),
        planMarkdown: "- Ship it",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-27T00:06:00.000Z",
        updatedAt: "2026-02-27T00:06:00.000Z",
      },
    ];
    const latestTurn: OrchestrationLatestTurn = {
      turnId: TurnId.makeUnsafe("turn-2"),
      state: "completed",
      requestedAt: "2026-02-27T00:02:00.000Z",
      startedAt: "2026-02-27T00:02:05.000Z",
      completedAt: "2026-02-27T00:06:30.000Z",
      assistantMessageId: null,
    };

    expect(
      deriveThreadSummaryMetadata({
        messages,
        activities,
        proposedPlans,
        latestTurn,
      }),
    ).toEqual({
      latestUserMessageAt: "2026-02-27T00:03:00.000Z",
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      hasActionableProposedPlan: true,
    });
  });

  it("drops stale pending requests once failure events mark them obsolete", () => {
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("activity-1"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Approval requested",
        payload: {
          requestId: "approval-1",
          requestType: "exec_command_approval",
        },
        sequence: 1,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:01:00.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-2"),
        tone: "error",
        kind: "provider.approval.respond.failed",
        summary: "Approval response failed",
        payload: {
          requestId: "approval-1",
          detail: "stale pending approval request",
        },
        sequence: 2,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:02:00.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-3"),
        tone: "info",
        kind: "user-input.requested",
        summary: "Questions requested",
        payload: {
          requestId: "input-1",
          questions: [
            {
              id: "question-1",
              header: "Confirm",
              question: "Continue?",
              options: [{ label: "Yes", description: "Continue." }],
            },
          ],
        },
        sequence: 3,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:03:00.000Z",
      },
      {
        id: EventId.makeUnsafe("activity-4"),
        tone: "error",
        kind: "provider.user-input.respond.failed",
        summary: "User input response failed",
        payload: {
          requestId: "input-1",
          detail: "unknown pending user-input request",
        },
        sequence: 4,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:04:00.000Z",
      },
    ];

    expect(
      deriveThreadSummaryMetadata({
        messages: [],
        activities,
        proposedPlans: [],
        latestTurn: null,
      }),
    ).toEqual({
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });
  });

  it("ignores malformed user-input questions that the UI could not render", () => {
    const activities: OrchestrationThreadActivity[] = [
      {
        id: EventId.makeUnsafe("activity-1"),
        tone: "info",
        kind: "user-input.requested",
        summary: "Questions requested",
        payload: {
          requestId: "input-1",
          questions: [
            {
              id: "question-1",
              header: "Confirm",
              question: "Continue?",
              options: [{ label: "Yes" }],
            },
          ],
        },
        sequence: 1,
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:01:00.000Z",
      },
    ];

    expect(
      deriveThreadSummaryMetadata({
        messages: [],
        activities,
        proposedPlans: [],
        latestTurn: null,
      }),
    ).toEqual({
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });
  });
});
