import type { ProviderRuntimeEvent } from "@synara/contracts";
import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  projectProviderRuntimeActivities,
  providerActivityUpdateDedupeKey,
  providerActivityUpdateFingerprint,
} from "./providerRuntimeActivityProjection.ts";

const CREATED_AT = "2026-07-20T10:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-activity-projection");
const TURN_ID = TurnId.makeUnsafe("turn-activity-projection");

function runtimeEvent(input: Record<string, unknown> & { eventId: string }): ProviderRuntimeEvent {
  return {
    provider: "codex",
    createdAt: CREATED_AT,
    threadId: THREAD_ID,
    ...input,
    eventId: EventId.makeUnsafe(input.eventId),
  } as ProviderRuntimeEvent;
}

describe("provider runtime activity projection", () => {
  it("keeps assistant text and assistant lifecycle events out of work activity", () => {
    const events = [
      runtimeEvent({
        type: "content.delta",
        eventId: "assistant-delta",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { streamKind: "assistant_text", delta: "hello" },
      }),
      runtimeEvent({
        type: "item.started",
        eventId: "assistant-started",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { itemType: "assistant_message", status: "inProgress" },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "assistant-completed",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("assistant-item"),
        payload: { itemType: "assistant_message", status: "completed" },
      }),
    ];

    expect(events.map(projectProviderRuntimeActivities)).toEqual([[], [], []]);
  });

  it("projects only readable completed Codex-family reasoning summaries", () => {
    const absent = [
      runtimeEvent({
        type: "content.delta",
        eventId: "reasoning-delta",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-item"),
        payload: { streamKind: "reasoning_summary_text", delta: "Inspecting code" },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "reasoning-private",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-private"),
        payload: {
          itemType: "reasoning",
          status: "completed",
          detail: "  <!-- encrypted reasoning -->  ",
        },
      }),
      runtimeEvent({
        type: "item.completed",
        eventId: "reasoning-cursor",
        provider: "cursor",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("reasoning-cursor"),
        payload: { itemType: "reasoning", status: "completed", detail: "Readable" },
      }),
    ];
    expect(absent.map(projectProviderRuntimeActivities)).toEqual([[], [], []]);

    for (const provider of ["codex", "antigravity"] as const) {
      const [activity] = projectProviderRuntimeActivities(
        runtimeEvent({
          type: "item.completed",
          eventId: `reasoning-${provider}`,
          provider,
          turnId: TURN_ID,
          itemId: RuntimeItemId.makeUnsafe(`reasoning-${provider}`),
          payload: {
            itemType: "reasoning",
            status: "completed",
            detail: "Read the protocol mapping",
          },
        }),
      );
      expect(activity).toMatchObject({
        id: `provider-reasoning:${THREAD_ID}:reasoning-${provider}`,
        kind: "task.progress",
        summary: "Reasoning trace",
        payload: {
          status: "completed",
          detail: "Read the protocol mapping",
          data: { toolCallId: `reasoning-${provider}` },
        },
      });
    }
  });

  it("maps tool progress without losing call identity", () => {
    const event = runtimeEvent({
      type: "tool.progress",
      eventId: "tool-progress",
      turnId: TURN_ID,
      payload: {
        toolUseId: "tool-1",
        toolName: "mcp__github__fetch_pr",
        summary: "Fetching PR",
        elapsedSeconds: 1.2,
      },
    });
    const [activity] = projectProviderRuntimeActivities(event);

    expect(activity).toMatchObject({
      kind: "tool.updated",
      tone: "tool",
      summary: "mcp__github__fetch_pr",
      payload: {
        itemType: "mcp_tool_call",
        title: "MCP tool call",
        detail: "Fetching PR",
        data: {
          toolUseId: "tool-1",
          toolName: "mcp__github__fetch_pr",
          summary: "Fetching PR",
          elapsedSeconds: 1.2,
        },
      },
    });
    expect(providerActivityUpdateDedupeKey(event, THREAD_ID, activity!)).toBe(
      `${THREAD_ID}:codex:tool.updated:tool-1`,
    );
    expect(providerActivityUpdateFingerprint(activity!)).toContain('"kind":"tool.updated"');
  });

  it("maps canonical approvals and structured user input", () => {
    const approval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-request",
        lifecycleGeneration: "generation-1",
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        payload: { requestType: "command_execution_approval", detail: "pwd" },
      }),
    )[0];
    expect(approval).toMatchObject({
      kind: "approval.requested",
      summary: "Command approval requested",
      payload: {
        requestId: "request-1",
        lifecycleGeneration: "generation-1",
        requestKind: "command",
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const userInput = [
      runtimeEvent({
        type: "user-input.requested",
        eventId: "user-input-requested",
        turnId: TURN_ID,
        lifecycleGeneration: "generation-2",
        requestId: ApprovalRequestId.makeUnsafe("request-2"),
        payload: {
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode?",
              options: [{ label: "workspace-write", description: "Workspace writes" }],
            },
          ],
        },
      }),
      runtimeEvent({
        type: "user-input.resolved",
        eventId: "user-input-resolved",
        turnId: TURN_ID,
        lifecycleGeneration: "generation-2",
        requestId: ApprovalRequestId.makeUnsafe("request-2"),
        payload: { answers: { sandbox_mode: "workspace-write" } },
      }),
    ].flatMap(projectProviderRuntimeActivities);

    expect(userInput).toMatchObject([
      {
        kind: "user-input.requested",
        payload: {
          requestId: "request-2",
          lifecycleGeneration: "generation-2",
          questions: [{ id: "sandbox_mode" }],
        },
      },
      {
        kind: "user-input.resolved",
        payload: {
          requestId: "request-2",
          lifecycleGeneration: "generation-2",
          answers: { sandbox_mode: "workspace-write" },
        },
      },
    ]);
  });

  it("bounds pathological tool payloads before persistence", () => {
    const data = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `field-${index.toString().padStart(3, "0")}`,
        "x".repeat(3_000),
      ]),
    );
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "large-tool-payload",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("large-tool"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Large command",
          data,
        },
      }),
    );
    const payload = activity?.payload as { data?: Record<string, unknown> };

    expect(JSON.stringify(payload.data).length).toBeLessThanOrEqual(16_000);
    expect(payload.data?.__synaraTruncated).toBe(true);
    expect(payload.data?.originalJsonChars).toBeGreaterThan(300_000);
  });

  it("compacts context and per-model usage into stable activity payloads", () => {
    const [usage] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "context-usage",
        provider: "claudeAgent",
        payload: { usage: { usedTokens: 1_200, maxTokens: 200_000, usedPercent: 0.6 } },
      }),
    );
    expect(usage).toMatchObject({
      kind: "context-window.updated",
      payload: {
        usedTokens: 1_200,
        maxTokens: 200_000,
        usedPercent: 0.6,
        provider: "claudeAgent",
      },
    });

    const [configured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "context-configured",
        provider: "claudeAgent",
        payload: { config: { contextWindow: "1m" } },
      }),
    );
    expect(configured).toMatchObject({
      kind: "context-window.configured",
      payload: { maxTokens: 1_000_000, contextWindow: "1m" },
    });

    const [turn] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-usage",
        provider: "claudeAgent",
        turnId: TURN_ID,
        payload: {
          state: "completed",
          modelUsage: {
            "claude-fable-5": {
              inputTokens: 100,
              outputTokens: 40,
              cacheReadInputTokens: 800,
              cacheCreationInputTokens: 60,
            },
            unused: { inputTokens: 0, outputTokens: 0 },
          },
        },
      }),
    );
    expect(turn).toMatchObject({
      kind: "turn.completed",
      payload: {
        state: "completed",
        modelUsage: {
          "claude-fable-5": { inputTokens: 960, outputTokens: 40, totalTokens: 1_000 },
        },
      },
    });
    expect(
      Object.keys((turn?.payload as { modelUsage?: Record<string, unknown> }).modelUsage ?? {}),
    ).toEqual(["claude-fable-5"]);
  });
});
