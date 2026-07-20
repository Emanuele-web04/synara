import {
  ApprovalRequestId,
  ThreadId,
  type OrchestrationPendingInteraction,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { derivePendingApprovals, derivePendingUserInputs } from "./pendingInteractionDerivation";
import { makeActivity } from "./storeTestFixtures";

function makePendingInteraction(
  interactionKind: OrchestrationPendingInteraction["interactionKind"],
  status: OrchestrationPendingInteraction["status"],
): OrchestrationPendingInteraction {
  return {
    interactionKind,
    requestId: ApprovalRequestId.makeUnsafe("req-settlement"),
    threadId: ThreadId.makeUnsafe("thread-settlement"),
    turnId: null,
    lifecycleGeneration: "generation-settlement",
    status,
    decision: null,
    responseCommandId: null,
    responseRequestedAt: null,
    createdAt: "2026-02-23T00:00:01.000Z",
    resolvedAt: null,
  };
}

describe("derivePendingApprovals", () => {
  it("shows only actionable durable approval settlements", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-settlement",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-settlement",
          lifecycleGeneration: "generation-settlement",
          requestKind: "command",
        },
      }),
    ];

    expect(
      derivePendingApprovals(activities, [makePendingInteraction("approval", "responding")]),
    ).toEqual([]);
    expect(
      derivePendingApprovals(activities, [makePendingInteraction("approval", "uncertain")]),
    ).toEqual([]);
    expect(
      derivePendingApprovals(activities, [makePendingInteraction("approval", "retryable")]),
    ).toHaveLength(1);
  });

  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("does not let an old generation resolve a replacement approval with the same request id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-generation-a",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-reused",
          lifecycleGeneration: "generation-a",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-generation-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-reused",
          lifecycleGeneration: "generation-b",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-generation-a-resolved",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: {
          requestId: "req-reused",
          lifecycleGeneration: "generation-a",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-reused",
        lifecycleGeneration: "generation-b",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:02.000Z",
      },
    ]);
  });
});

describe("derivePendingUserInputs", () => {
  it("shows only actionable durable user-input settlements", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-settlement",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-settlement",
          lifecycleGeneration: "generation-settlement",
          questions: [
            {
              id: "mode",
              header: "Mode",
              question: "Which mode?",
              options: [{ label: "safe", description: "Use safe mode" }],
            },
          ],
        },
      }),
    ];

    expect(
      derivePendingUserInputs(activities, [makePendingInteraction("userInput", "responding")]),
    ).toEqual([]);
    expect(
      derivePendingUserInputs(activities, [makePendingInteraction("userInput", "uncertain")]),
    ).toEqual([]);
    expect(
      derivePendingUserInputs(activities, [makePendingInteraction("userInput", "pending")]),
    ).toHaveLength(1);
  });

  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });

  it("does not let an old generation resolve a replacement user-input request", () => {
    const question = {
      id: "mode",
      header: "Mode",
      question: "Which mode?",
      options: [{ label: "safe", description: "Use safe mode" }],
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-generation-a",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-reused",
          lifecycleGeneration: "generation-a",
          questions: [question],
        },
      }),
      makeActivity({
        id: "user-input-generation-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-reused",
          lifecycleGeneration: "generation-b",
          questions: [question],
        },
      }),
      makeActivity({
        id: "user-input-generation-a-resolved",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-reused",
          lifecycleGeneration: "generation-a",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-reused",
        lifecycleGeneration: "generation-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        questions: [question],
      },
    ]);
  });

  it("preserves multi-select user-input question metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-multi",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-multi-1",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which areas should change?",
              multiSelect: true,
              options: [
                {
                  label: "Server",
                  description: "Update server behavior",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)[0]?.questions[0]?.multiSelect).toBe(true);
  });

  it("keeps text-only user-input questions so the composer can collect the answer", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-text",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-text-1",
          questions: [
            {
              id: "input",
              header: "Pi plugin",
              question: "Type a response.",
              options: [],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)[0]?.questions[0]?.options).toEqual([]);
  });
});
