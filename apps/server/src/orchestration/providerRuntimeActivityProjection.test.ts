import type { OrchestrationThreadActivity, ProviderRuntimeEvent } from "@synara/contracts";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  OrchestrationCommand,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Schema } from "effect";
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

/**
 * The single invariant that matters: every activity this projection emits has to
 * survive the schema of the command that carries it. Server-built commands never
 * cross the WebSocket decode boundary, so nothing else enforces the schema-only
 * refinements (`TrimmedNonEmptyString`, `Schema.Json`) that TypeScript cannot express.
 */
function decodeActivityAppendCommand(activity: OrchestrationThreadActivity): unknown {
  return Schema.decodeUnknownSync(OrchestrationCommand)({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe("cmd-activity-append"),
    threadId: THREAD_ID,
    activity,
    createdAt: CREATED_AT,
  });
}

function expectSchemaValidActivities(event: ProviderRuntimeEvent, sessionSequence?: number): void {
  const activities = projectProviderRuntimeActivities(event, sessionSequence);
  expect(activities.length).toBeGreaterThan(0);
  for (const activity of activities) {
    expect(() => decodeActivityAppendCommand(activity)).not.toThrow();
  }
}

it("persists terminal error identity and announced retry state in chat activities", () => {
  const error = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "runtime.error",
      eventId: "error",
      turnId: TURN_ID,
      payload: {
        message: "Temporarily unavailable",
        class: "provider_error",
        errorCode: "server_overloaded",
      },
    }),
  )[0]!;
  expect(error.payload).toMatchObject({
    errorCode: "server_overloaded",
    message: "Temporarily unavailable",
  });
  const completion = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "turn.completed",
      eventId: "completion",
      turnId: TURN_ID,
      payload: {
        state: "failed",
        errorMessage: "Temporarily unavailable",
        errorCode: "server_overloaded",
      },
    }),
  )[0]!;
  expect(completion.payload).toMatchObject({ errorCode: "server_overloaded", state: "failed" });
  const warning = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "runtime.warning",
      eventId: "retry",
      turnId: TURN_ID,
      payload: { message: "Temporarily unavailable", willRetry: true },
    }),
  )[0]!;
  expect(warning).toMatchObject({
    summary: "Provider retrying",
    turnId: TURN_ID,
    payload: { willRetry: true },
  });
  for (const activity of [error, completion, warning]) {
    expect(() => decodeActivityAppendCommand(activity)).not.toThrow();
  }
});

it("projects tool summaries with stable group identity and no empty rows", () => {
  const event = runtimeEvent({
    provider: "claudeAgent",
    type: "tool.summary",
    eventId: "summary-1",
    turnId: TURN_ID,
    payload: {
      summary: "Reviewed the provider.\n\nCancellation is covered.",
      precedingToolUseIds: ["read-1", "test-1"],
    },
  });
  const [activity] = projectProviderRuntimeActivities(event);
  expect(activity).toMatchObject({
    kind: "tool.summary",
    tone: "info",
    summary: "Tool summary",
    payload: { detail: "Reviewed the provider.\n\nCancellation is covered." },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
  expect(
    projectProviderRuntimeActivities({
      ...event,
      eventId: EventId.makeUnsafe("summary-repeated"),
    })[0]?.id,
  ).toBe(activity?.id);
  expect(
    projectProviderRuntimeActivities(
      runtimeEvent({
        provider: "claudeAgent",
        type: "tool.summary",
        eventId: "empty",
        payload: { summary: "  " },
      }),
    ),
  ).toEqual([]);
});

it.each([
  [{ isAuthenticating: true }, "Claude authentication started", "info"],
  [{ isAuthenticating: false }, "Claude authentication finished", "info"],
  [
    { isAuthenticating: false, error: "secret-login-token" },
    "Claude authentication needs attention.",
    "error",
  ],
] as const)("projects safe authentication status %j", (status, summary, tone) => {
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      provider: "claudeAgent",
      type: "auth.status",
      eventId: "auth-status",
      payload: { ...status, output: ["https://login.example/?token=secret-login-token"] },
    }),
  );
  expect(activity).toMatchObject({ kind: "auth.status", summary, tone, turnId: null });
  expect(JSON.stringify(activity)).not.toContain("secret-login-token");
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
});

it.each(["info", "warning"])("projects Pi %s notifications as notices", (type) => {
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      provider: "pi",
      type: "runtime.warning",
      eventId: "pi-notification",
      turnId: TURN_ID,
      payload: { message: "Extension notification", detail: { type } },
      raw: { source: "pi.sdk.event", method: "extension/ui/notify", payload: { type } },
    }),
  );

  expect(activity).toMatchObject({
    tone: "info",
    kind: "runtime.warning",
    summary: type === "info" ? "Pi extension" : "Runtime warning",
    payload: { message: "Extension notification", detail: "Extension notification" },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();
});

it("keeps the full runtime warning message so the row's hover card can reveal it", () => {
  // The work-log row clips the notice to one line with CSS `truncate`; the hover
  // card can only show what the server stored, so the payload must carry the full
  // text (e.g. Claude's ~190-char token-usage warning) rather than a row-sized cut.
  const claudeWarning =
    "Claude is processing ~201k logical prompt tokens per request (~200k cached reads, ~1k new/cache-write). Large active contexts can consume usage faster; cached reads cost less than fresh input.";
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      provider: "claudeAgent",
      type: "runtime.warning",
      eventId: "runtime-warning-full-message",
      turnId: TURN_ID,
      payload: { message: claudeWarning },
    }),
  );

  expect(activity).toMatchObject({
    kind: "runtime.warning",
    summary: "Runtime warning",
    payload: { message: claudeWarning, detail: claudeWarning },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized warnings.
  const oversized = `prefix-${"x".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "runtime.warning",
      eventId: "runtime-warning-oversized",
      turnId: TURN_ID,
      payload: { message: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { message: string; detail: string };
  expect(cappedPayload.message).toHaveLength(2_000);
  expect(cappedPayload.message.endsWith("...")).toBe(true);
});

it("keeps the full approval detail so the pending-approval panel shows the whole command", () => {
  // The Claude adapter deliberately allows ~400 chars of command text in the
  // approval detail; the panel can only render what the server stored, so the
  // payload must carry the full string rather than a 180-char row-sized cut.
  const approvalDetail =
    `Bash: ${"git -C /workspace status && ".repeat(14)}git push origin main`.slice(0, 400);
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "request.opened",
      eventId: "approval-full-detail",
      turnId: TURN_ID,
      requestId: ApprovalRequestId.makeUnsafe("request-full-detail"),
      payload: { requestType: "command_execution_approval", detail: approvalDetail },
    }),
  );

  expect(activity).toMatchObject({
    kind: "approval.requested",
    payload: { detail: approvalDetail },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized details.
  const oversized = `prefix-${"x".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "request.opened",
      eventId: "approval-oversized-detail",
      turnId: TURN_ID,
      payload: { requestType: "command_execution_approval", detail: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { detail: string };
  expect(cappedPayload.detail).toHaveLength(2_000);
  expect(cappedPayload.detail.endsWith("...")).toBe(true);
});

it("keeps the full tool progress summary so the hover card can reveal it", () => {
  // The work-log row clips the progress detail to one line with CSS `truncate`;
  // the hover card can only show what the server stored, so the payload must
  // carry the full summary rather than a 180-char row-sized cut.
  const progressSummary = `mcp__long-runner__sync: fetched 1,204 records across 17 pages; last checkpoint at offset 9,216 (page 14 of 17) — resuming pagination for shard eu-west after the rate-limit window resets`;
  expect(progressSummary.length).toBeGreaterThan(180);
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "tool.progress",
      eventId: "tool-progress-full-summary",
      turnId: TURN_ID,
      payload: {
        toolUseId: "tool-progress-full",
        toolName: "mcp__long-runner__sync",
        summary: progressSummary,
        elapsedSeconds: 4.8,
      },
    }),
  );

  expect(activity).toMatchObject({
    kind: "tool.updated",
    payload: { detail: progressSummary },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized summaries.
  const oversized = `prefix-${"y".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "tool.progress",
      eventId: "tool-progress-oversized",
      turnId: TURN_ID,
      payload: { toolUseId: "tool-oversized", toolName: "mcp__x", summary: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { detail: string };
  expect(cappedPayload.detail).toHaveLength(2_000);
  expect(cappedPayload.detail.endsWith("...")).toBe(true);
});

it("keeps the full task failure summary so the work-log reveal can show it", () => {
  // A failed background/subagent task's summary is exactly what the operator
  // needs to read in full; provider-authored failure text (rate-limit bodies,
  // unsupported-version messages) routinely runs past 180 chars.
  const failureSummary = `Subagent run failed after 3 retries: provider returned 429 rate_limit_error — "request exceeds the per-minute token budget for claude-opus-4-1; reduce context or wait for the current window to reset" (request id req_01JX4K9VF0Q8M2W7ABCDE)`;
  expect(failureSummary.length).toBeGreaterThan(180);
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "task.completed",
      eventId: "task-completed-full-summary",
      turnId: TURN_ID,
      payload: { taskId: "task-failed-1", status: "failed", summary: failureSummary },
    }),
  );

  expect(activity).toMatchObject({
    kind: "task.completed",
    tone: "error",
    payload: { detail: failureSummary },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized summaries.
  const oversized = `prefix-${"z".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "task.completed",
      eventId: "task-completed-oversized",
      turnId: TURN_ID,
      payload: { taskId: "task-failed-2", status: "failed", summary: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { detail: string };
  expect(cappedPayload.detail).toHaveLength(2_000);
  expect(cappedPayload.detail.endsWith("...")).toBe(true);
});

it("keeps the full task update error so the work-log reveal can show it", () => {
  // The task.updated error is the provider's own failure text; the row's CSS
  // `truncate` does the one-line clip, so the payload must carry the full
  // string rather than a 180-char row-sized cut.
  const taskError = `Task crashed while streaming the provider response: socket hang up after 42s without a delta — the CLI reported "unsupported client version 0.31.x; server requires >= 0.40.0" and refused the reconnect attempt (attempt 3 of 3)`;
  expect(taskError.length).toBeGreaterThan(180);
  const [activity] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "task.updated",
      eventId: "task-updated-full-error",
      turnId: TURN_ID,
      payload: { taskId: "task-failed-3", status: "failed", error: taskError },
    }),
  );

  expect(activity).toMatchObject({
    kind: "task.updated",
    tone: "error",
    payload: { detail: taskError },
  });
  expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

  // The shared activity-data cap still bounds oversized errors.
  const oversized = `prefix-${"e".repeat(2_100)}`;
  const [capped] = projectProviderRuntimeActivities(
    runtimeEvent({
      type: "task.updated",
      eventId: "task-updated-oversized",
      turnId: TURN_ID,
      payload: { taskId: "task-failed-4", status: "failed", error: oversized },
    }),
  );
  const cappedPayload = capped?.payload as { detail: string };
  expect(cappedPayload.detail).toHaveLength(2_000);
  expect(cappedPayload.detail.endsWith("...")).toBe(true);
});

describe("projected activities satisfy the orchestration command schema", () => {
  it("omits an absent approval request id instead of emitting an explicit undefined", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval", detail: "rm -rf build" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "request.resolved",
        eventId: "approval-resolved-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval", decision: "approved" },
      }),
    );
    const [opened] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-without-request-id",
        turnId: TURN_ID,
        payload: { requestType: "command_execution_approval" },
      }),
    );
    expect(Object.keys(opened?.payload as Record<string, unknown>)).not.toContain("requestId");

    // `ApprovalRequestId.makeUnsafe` rejects untrimmed input instead of trimming it.
    const [padded] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-padded-request-id",
        turnId: TURN_ID,
        requestId: "  approval-7  ",
        payload: { requestType: "command_execution_approval" },
      }),
    );
    expect(padded?.payload).toMatchObject({ requestId: "approval-7" });
  });

  it("never derives a blank summary from a blank tool name or title", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "tool.progress",
        eventId: "tool-progress-blank-name",
        turnId: TURN_ID,
        payload: { toolUseId: "tool-blank", toolName: "   ", summary: "" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "item.completed",
        eventId: "item-completed-blank-title",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("tool-item"),
        payload: { itemType: "command_execution", status: "completed", title: "" },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "item.updated",
        eventId: "item-updated-blank-title",
        turnId: TURN_ID,
        itemId: RuntimeItemId.makeUnsafe("tool-item"),
        payload: { itemType: "command_execution", status: "inProgress", title: "  " },
      }),
    );
  });

  // `TurnId.makeUnsafe` validates: it rejects "" *and* untrimmed input rather than
  // normalizing it, so an unnormalized runtime turn id throws inside the projection
  // itself before it can even reach the command schema.
  it("normalizes a blank or untrimmed runtime turn id instead of throwing", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-blank-turn-id",
        turnId: "",
        payload: { state: "completed" },
      }),
    );
    const [padded] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-padded-turn-id",
        turnId: "  turn-padded  ",
        payload: { state: "completed" },
      }),
    );
    expect(padded?.turnId).toBe("turn-padded");
  });

  it("drops a fractional runtime sequence rather than emitting a non-integer", () => {
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.steered",
        eventId: "turn-steered-fractional-sequence",
        turnId: TURN_ID,
        payload: { message: "keep going" },
      }),
      12.5,
    );
  });

  it("projects a subagent steer but not a steer of the thread's own turn", () => {
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "turn.steered",
          eventId: "turn-steered-own-turn",
          turnId: TURN_ID,
          payload: { message: "dimmi ciao subito", target: "turn" },
        }),
      ),
    ).toEqual([]);
    expectSchemaValidActivities(
      runtimeEvent({
        type: "turn.steered",
        eventId: "turn-steered-subagent",
        turnId: TURN_ID,
        payload: { message: "dimmi ciao subito", target: "subagent" },
      }),
    );
  });

  it("keeps raw provider payloads inside what Schema.Json admits", () => {
    const cyclic: Record<string, unknown> = { window: "5h" };
    cyclic.self = cyclic;
    const rateLimitsEvent = runtimeEvent({
      type: "account.rate-limits.updated",
      eventId: "rate-limits-hostile",
      payload: {
        rateLimits: {
          status: "rejected",
          utilization: 0.9,
          resetsAt: undefined,
          planTier: undefined,
          requestCount: 42n,
          onReset: () => undefined,
          observedAt: new Date("2026-07-27T00:00:00.000Z"),
          cyclic,
        },
      },
    });
    expectSchemaValidActivities(rateLimitsEvent);
    const rateLimitsActivity = projectProviderRuntimeActivities(rateLimitsEvent).find(
      (activity) => activity.kind === "account.rate-limits.updated",
    );
    expect(rateLimitsActivity?.payload).toMatchObject({
      observedAt: "2026-07-27T00:00:00.000Z",
    });
    expectSchemaValidActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "token-usage-explicit-undefined",
        turnId: TURN_ID,
        payload: { usage: { usedTokens: 1_000, maxTokens: 200_000, usedPercent: undefined } },
      }),
    );
    expectSchemaValidActivities(
      runtimeEvent({
        type: "task.progress",
        eventId: "task-progress-raw-usage",
        turnId: TURN_ID,
        payload: {
          taskId: "task-1",
          description: "Working",
          usage: { inputTokens: 10, outputTokens: undefined, costUsd: Number.NaN },
        },
      }),
    );
  });
});

describe("provider runtime activity projection", () => {
  it("attributes Claude task progress to its subagent instead of reasoning", () => {
    const subagentProgress = runtimeEvent({
      type: "task.progress",
      provider: "claudeAgent",
      eventId: "claude-subagent-progress",
      turnId: TURN_ID,
      payload: {
        taskId: "task-outer",
        description: "Running Sleep briefly then echo bg",
        toolUseId: "toolu_outer",
        subagentTitle: "Outer worker",
      },
    });
    const taskProgress = runtimeEvent({
      type: "task.progress",
      provider: "claudeAgent",
      eventId: "claude-task-progress",
      turnId: TURN_ID,
      payload: { taskId: "task-bash", description: "Monitoring the build" },
    });
    const codexReasoning = runtimeEvent({
      type: "task.progress",
      eventId: "codex-agent-reasoning",
      turnId: TURN_ID,
      payload: { taskId: "codex-task", description: "Planning the change" },
    });
    expectSchemaValidActivities(subagentProgress);
    const [subagentActivity] = projectProviderRuntimeActivities(subagentProgress);
    expect(subagentActivity?.summary).toBe("Subagent progress");
    expect(subagentActivity?.payload).toMatchObject({
      toolUseId: "toolu_outer",
      subagentTitle: "Outer worker",
    });
    expect(projectProviderRuntimeActivities(taskProgress)[0]?.summary).toBe("Reasoning update");
    expect(projectProviderRuntimeActivities(codexReasoning)[0]?.summary).toBe("Reasoning update");
  });

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

  it("projects only readable completed Codex, Antigravity, and OpenCode reasoning", () => {
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

    for (const provider of ["codex", "antigravity", "opencode"] as const) {
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

  it.each(["antigravity"] as const)(
    "projects %s tool lifecycle events through the same canonical activities",
    (provider) => {
      const itemId = RuntimeItemId.makeUnsafe(`${provider}-tool-1`);
      const data = { toolCallId: itemId, toolName: "run_command" };
      const [started] = projectProviderRuntimeActivities(
        runtimeEvent({
          provider,
          type: "item.started",
          eventId: `${provider}-tool-started`,
          turnId: TURN_ID,
          itemId,
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            title: "run_command",
            data,
          },
        }),
      );
      const [completed] = projectProviderRuntimeActivities(
        runtimeEvent({
          provider,
          type: "item.completed",
          eventId: `${provider}-tool-completed`,
          turnId: TURN_ID,
          itemId,
          payload: {
            itemType: "command_execution",
            status: "completed",
            title: "run_command",
            data,
          },
        }),
      );

      expect(started).toMatchObject({
        kind: "tool.started",
        summary: "run_command started",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "run_command",
          data,
        },
      });
      expect(completed).toMatchObject({
        kind: "tool.completed",
        summary: "run_command",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "run_command",
          data,
        },
      });
      expect(() => decodeActivityAppendCommand(started!)).not.toThrow();
      expect(() => decodeActivityAppendCommand(completed!)).not.toThrow();
    },
  );

  it("maps canonical approvals and structured user input", () => {
    const approval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "approval-request",
        lifecycleGeneration: "generation-1",
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        payload: {
          requestType: "command_execution_approval",
          detail: "pwd",
          args: { sessionApprovalAvailable: false },
        },
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
        sessionApprovalAvailable: false,
      },
    });
    const [resolvedApproval] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.resolved",
        eventId: "approval-resolved",
        lifecycleGeneration: "generation-1",
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        payload: { requestType: "command_execution_approval", decision: "accept" },
      }),
    );
    expect(resolvedApproval).toMatchObject({
      kind: "approval.resolved",
      payload: {
        requestKind: "command",
        requestType: "command_execution_approval",
        lifecycleGeneration: "generation-1",
      },
    });

    const permissionApproval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "permission-approval-request",
        requestId: ApprovalRequestId.makeUnsafe("permission-request-1"),
        payload: {
          requestType: "permissions_approval",
          detail: "Needs package metadata",
          args: {
            permissions: {
              network: { enabled: true },
              fileSystem: { read: ["/tmp/example"] },
            },
          },
        },
      }),
    )[0];
    expect(permissionApproval).toMatchObject({
      kind: "approval.requested",
      summary: "Permission approval requested",
      payload: {
        requestKind: "permissions",
        detail: "Needs package metadata",
        permissionProfile: {
          network: { enabled: true },
          fileSystem: { read: ["/tmp/example"] },
        },
      },
    });

    const toolApproval = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "tool-approval-request",
        requestId: ApprovalRequestId.makeUnsafe("tool-request-1"),
        payload: {
          requestType: "tool_approval",
          detail: "Allow Synara to launch the calculator?",
          args: {
            _meta: {
              tool_name: "computer_launch_app",
              tool_title: "Open Calculator",
              tool_params_display: [{ name: "app", value: "kcalc", display_name: "app" }],
            },
          },
        },
      }),
    )[0];
    expect(toolApproval).toMatchObject({
      kind: "approval.requested",
      summary: "Tool approval requested",
      payload: {
        requestKind: "tool",
        requestType: "tool_approval",
        detail: "Allow Synara to launch the calculator?",
        title: "Open Calculator",
        toolName: "computer_launch_app",
        toolParamsDisplay: [{ name: "app", value: "kcalc", display_name: "app" }],
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

  it.each(["tool_approval", "dynamic_tool_call"] as const)(
    "renders Claude-shaped %s approvals as tool approvals with parameter rows",
    (requestType) => {
      const [approval] = projectProviderRuntimeActivities(
        runtimeEvent({
          type: "request.opened",
          provider: "claudeAgent",
          eventId: `claude-${requestType}-request`,
          requestId: ApprovalRequestId.makeUnsafe(`claude-${requestType}-1`),
          payload: {
            requestType,
            detail: "mcp__synara__computer_launch_app: {}",
            args: {
              toolName: "mcp__synara__computer_launch_app",
              input: { app: "kcalc", args: ["--hidpi"], headless: false },
              sessionApprovalAvailable: true,
              toolUseId: "toolu_01",
            },
          },
        }),
      );

      expect(approval).toMatchObject({
        kind: "approval.requested",
        summary: "Tool approval requested",
        payload: {
          requestKind: "tool",
          requestType,
          toolName: "mcp__synara__computer_launch_app",
          toolParamsDisplay: [
            { name: "app", value: "kcalc" },
            { name: "args", value: '["--hidpi"]' },
            { name: "headless", value: "false" },
          ],
          sessionApprovalAvailable: true,
        },
      });
      expect(() => decodeActivityAppendCommand(approval!)).not.toThrow();
    },
  );

  it("redacts credential-named tool parameters before they reach the approval card", () => {
    const [claudeApproval] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        provider: "claudeAgent",
        eventId: "claude-tool-approval-secret",
        requestId: ApprovalRequestId.makeUnsafe("claude-tool-approval-secret"),
        payload: {
          requestType: "tool_approval",
          detail: "mcp__github__create_issue",
          args: {
            toolName: "mcp__github__create_issue",
            input: {
              repo: "synara",
              token: "ghp_live_secret",
              headers: { Authorization: "Bearer live-secret", Accept: "application/json" },
              max_tokens: 5,
            },
          },
        },
      }),
    );
    const [codexApproval] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        eventId: "codex-tool-approval-secret",
        requestId: ApprovalRequestId.makeUnsafe("codex-tool-approval-secret"),
        payload: {
          requestType: "tool_approval",
          detail: "Allow the deploy tool?",
          args: {
            _meta: {
              tool_name: "deploy",
              tool_params_display: [
                { name: "api_key", value: "sk-live-secret" },
                { name: "target", value: "staging", display_name: "Target" },
                { name: "options", value: { clientSecret: "live-secret", dryRun: true } },
                {
                  name: "headers",
                  value: '{"Authorization":"Bearer live-secret","Accept":"application/json"}',
                },
                { name: "config", value: '{ "dryRun": true }' },
              ],
            },
          },
        },
      }),
    );

    expect(claudeApproval?.payload).toMatchObject({
      toolParamsDisplay: [
        { name: "repo", value: "synara" },
        { name: "token", value: "[redacted]" },
        {
          name: "headers",
          value: '{"Authorization":"[redacted]","Accept":"application/json"}',
        },
        { name: "max_tokens", value: "5" },
      ],
    });
    expect(codexApproval?.payload).toMatchObject({
      toolParamsDisplay: [
        { name: "api_key", value: "[redacted]" },
        { name: "target", value: "staging", display_name: "Target" },
        { name: "options", value: '{"clientSecret":"[redacted]","dryRun":true}' },
        {
          name: "headers",
          value: '{"Authorization":"[redacted]","Accept":"application/json"}',
        },
        { name: "config", value: '{ "dryRun": true }' },
      ],
    });
    expect(JSON.stringify([claudeApproval, codexApproval])).not.toMatch(/live-secret|ghp_live/);
  });

  it("omits tool presentation when a Claude tool approval carries no input", () => {
    const [approval] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "request.opened",
        provider: "claudeAgent",
        eventId: "claude-tool-approval-empty-input",
        requestId: ApprovalRequestId.makeUnsafe("claude-tool-approval-empty"),
        payload: {
          requestType: "tool_approval",
          detail: "Agent: {}",
          args: { toolName: "Agent", input: {}, sessionApprovalAvailable: false },
        },
      }),
    );

    expect(approval?.payload).toMatchObject({ requestKind: "tool", toolName: "Agent" });
    expect(approval?.payload).not.toHaveProperty("toolParamsDisplay");
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

    const [accountingOnlyUsage] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "thread.token-usage.updated",
        eventId: "context-usage-accounting-only",
        provider: "claudeAgent",
        payload: { usage: { usedTokens: 0, totalProcessedTokens: 340_000 } },
      }),
    );
    expect(accountingOnlyUsage).toMatchObject({
      kind: "context-window.updated",
      payload: {
        usedTokens: 0,
        totalProcessedTokens: 340_000,
        provider: "claudeAgent",
      },
    });

    for (const [provider, usageSessionId] of [
      ["cursor", "native-session"],
      ["codex", "native-session"],
      ["antigravity", "native-session:generation-after-restart"],
    ] as const) {
      const [resumedUsage] = projectProviderRuntimeActivities(
        runtimeEvent({
          type: "thread.token-usage.updated",
          eventId: `${provider}-resumed-usage`,
          provider,
          lifecycleGeneration: "generation-after-restart",
          providerRefs: { providerThreadId: "native-session" },
          payload: { usage: { usedTokens: 0, totalProcessedTokens: 4_200 } },
        }),
      );
      expect(resumedUsage).toMatchObject({
        kind: "context-window.updated",
        payload: {
          provider,
          totalProcessedTokens: 4_200,
          usageSessionId,
        },
      });
    }

    const [configured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "context-configured",
        provider: "claudeAgent",
        payload: { config: { autoCompactWindow: "1m" } },
      }),
    );
    expect(configured).toMatchObject({
      kind: "context-window.configured",
      payload: { maxTokens: 1_000_000, contextWindow: "1m" },
    });

    const [legacyConfigured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "legacy-context-configured",
        provider: "claudeAgent",
        payload: { config: { contextWindow: "200k" } },
      }),
    );
    expect(legacyConfigured).toMatchObject({
      kind: "context-window.configured",
      payload: { maxTokens: 200_000, contextWindow: "200k" },
    });

    const [clearedConfigured] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "cleared-context-configured",
        provider: "claudeAgent",
        payload: { config: { autoCompactWindow: null } },
      }),
    );
    expect(clearedConfigured).toMatchObject({
      kind: "context-window.configured",
      payload: { cleared: true },
    });

    const [blockedFastMode] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "fast-mode-blocked",
        provider: "claudeAgent",
        payload: {
          config: { fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" },
        },
      }),
    );
    expect(blockedFastMode).toMatchObject({
      id: "fast-mode-blocked",
      kind: "fast-mode.state",
      payload: { state: "off", disabledReason: "extra_usage_disabled" },
    });

    const [activeFastMode] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "session.configured",
        eventId: "fast-mode-on",
        provider: "claudeAgent",
        payload: { config: { fast_mode_state: "on" } },
      }),
    );
    expect(activeFastMode).toMatchObject({ kind: "fast-mode.state", payload: { state: "on" } });

    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "session.configured",
          eventId: "fast-mode-with-context",
          provider: "claudeAgent",
          payload: { config: { autoCompactWindow: "1m", fast_mode_state: "cooldown" } },
        }),
      ).map((activity) => [activity.id, activity.kind]),
    ).toEqual([
      ["fast-mode-with-context", "context-window.configured"],
      ["fast-mode-with-context:fast-mode", "fast-mode.state"],
    ]);

    const [turn] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "turn.completed",
        eventId: "turn-usage",
        provider: "claudeAgent",
        turnId: TURN_ID,
        payload: {
          state: "completed",
          tokenAccountingVersion: 1,
          mainLoopTokens: 1_000,
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
        provider: "claudeAgent",
        tokenAccountingVersion: 1,
        mainLoopTokens: 1_000,
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 960,
            outputTokens: 40,
            totalTokens: 1_000,
            cacheReadInputTokens: 800,
            cacheCreationInputTokens: 60,
          },
        },
      },
    });
    expect(
      Object.keys((turn?.payload as { modelUsage?: Record<string, unknown> }).modelUsage ?? {}),
    ).toEqual(["claude-fable-5"]);
  });

  it("projects unmapped passthrough events instead of dropping them", () => {
    const oversizedDiagnostic = "x".repeat(64_000);
    const [activity] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "event.unmapped",
        eventId: "unmapped-native-event",
        turnId: TURN_ID,
        payload: {
          nativeType: "item/agentMessage/completed",
          detail: "Finished the refactor",
          data: {
            secretKey: "must-not-reach-the-activity-snapshot",
            note: "api_key=another-secret",
            output: oversizedDiagnostic,
          },
        },
      }),
    );
    expect(activity).toMatchObject({
      tone: "info",
      kind: "provider.event.unmapped",
      // Raw native type/label is the row title.
      summary: "item/agentMessage/completed",
      turnId: TURN_ID,
      payload: {
        nativeEventType: "item/agentMessage/completed",
        detail: "Finished the refactor",
        data: expect.objectContaining({ __synaraTruncated: true }),
      },
    });
    const serializedPayload = JSON.stringify(activity?.payload);
    expect(serializedPayload.length).toBeLessThan(17_000);
    expect(serializedPayload).not.toContain("must-not-reach-the-activity-snapshot");
    expect(serializedPayload).not.toContain("another-secret");
    // The activity must survive the schema of the command that carries it.
    expect(() => decodeActivityAppendCommand(activity!)).not.toThrow();

    // A passthrough event without a native type is the one case still dropped.
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "event.unmapped",
          eventId: "unmapped-without-type",
          payload: { detail: "no type" },
        }),
      ),
    ).toEqual([]);
  });

  it("keeps routine hook lifecycle internal and surfaces only consequential completions", () => {
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "hook.started",
          eventId: "hook-started",
          turnId: TURN_ID,
          payload: {
            hookId: "hook-run-1",
            hookName: "/Users/example/.codex/hooks.json",
            hookEvent: "preToolUse",
          },
        }),
      ),
    ).toEqual([]);
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "hook.progress",
          eventId: "hook-progress",
          turnId: TURN_ID,
          payload: {
            hookId: "hook-run-1",
            stdout: "Still running.",
          },
        }),
      ),
    ).toEqual([]);
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "hook.completed",
          eventId: "hook-success",
          turnId: TURN_ID,
          payload: {
            hookId: "hook-run-1",
            hookName: "/Users/example/.codex/hooks.json",
            hookEvent: "preToolUse",
            outcome: "success",
            status: "completed",
            durationMs: 8,
          },
        }),
      ),
    ).toEqual([]);
    expect(
      projectProviderRuntimeActivities(
        runtimeEvent({
          type: "hook.completed",
          eventId: "hook-cancelled",
          turnId: TURN_ID,
          payload: {
            hookId: "hook-run-2",
            outcome: "cancelled",
          },
        }),
      ),
    ).toEqual([]);

    const [failed] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "hook.completed",
        eventId: "hook-failed",
        turnId: TURN_ID,
        payload: {
          hookId: "hook-run-3",
          hookName: "/Users/example/.codex/hooks.json",
          hookEvent: "postToolUse",
          outcome: "error",
          status: "failed",
          statusMessage: "Hook process exited with code 1.",
          durationMs: 20,
        },
      }),
    );
    expect(failed).toMatchObject({
      tone: "error",
      kind: "runtime.warning",
      summary: "postToolUse hook failed",
      payload: {
        message: "Hook process exited with code 1.",
        hookId: "hook-run-3",
        hookEvent: "postToolUse",
        outcome: "error",
        status: "failed",
        durationMs: 20,
      },
    });
    expect(() => decodeActivityAppendCommand(failed!)).not.toThrow();

    const [blocked] = projectProviderRuntimeActivities(
      runtimeEvent({
        type: "hook.completed",
        eventId: "hook-blocked",
        turnId: TURN_ID,
        payload: {
          hookId: "hook-run-4",
          hookEvent: "preToolUse",
          outcome: "cancelled",
          status: "blocked",
          statusMessage: "Policy blocked the command.",
        },
      }),
    );
    expect(blocked).toMatchObject({
      tone: "info",
      kind: "runtime.warning",
      summary: "preToolUse hook blocked an action",
      payload: {
        message: "Policy blocked the command.",
        outcome: "cancelled",
        status: "blocked",
      },
    });
    expect(() => decodeActivityAppendCommand(blocked!)).not.toThrow();
  });
});
