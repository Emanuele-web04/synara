import { describe, expect, it } from "vitest";
import { EventId, TurnId } from "@synara/contracts";

import { canvasAgentMutationTurnId, isCanvasAgentEditing } from "./canvasAgentState";

const turnId = TurnId.makeUnsafe("turn-1");

describe("isCanvasAgentEditing", () => {
  it("locks only while the running turn has entered create_view", () => {
    const activity = {
      id: EventId.makeUnsafe("event-1"),
      tone: "tool" as const,
      kind: "tool.call.started",
      summary: "Running create_view",
      payload: { toolName: "create_view" },
      turnId,
      createdAt: "2026-07-14T00:00:00.000Z",
    };

    expect(
      isCanvasAgentEditing({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-07-14T00:00:00.000Z",
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        activities: [activity],
      }),
    ).toBe(true);
    expect(
      isCanvasAgentEditing({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-07-14T00:00:00.000Z",
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: "2026-07-14T00:00:01.000Z",
          assistantMessageId: null,
        },
        activities: [activity],
      }),
    ).toBe(false);
    expect(
      canvasAgentMutationTurnId({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-07-14T00:00:00.000Z",
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: "2026-07-14T00:00:01.000Z",
          assistantMessageId: null,
        },
        activities: [activity],
      }),
    ).toBe(turnId);
  });

  it("keeps the canvas editable while the agent is only researching", () => {
    expect(
      isCanvasAgentEditing({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-07-14T00:00:00.000Z",
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        activities: [],
      }),
    ).toBe(false);
    expect(
      canvasAgentMutationTurnId({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-07-14T00:00:00.000Z",
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: "2026-07-14T00:00:01.000Z",
          assistantMessageId: null,
        },
        activities: [],
      }),
    ).toBeNull();
  });

  it("ignores create_view text in another tool's output", () => {
    expect(
      canvasAgentMutationTurnId({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-07-14T00:00:00.000Z",
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: "2026-07-14T00:00:01.000Z",
          assistantMessageId: null,
        },
        activities: [
          {
            id: EventId.makeUnsafe("event-read-me"),
            tone: "tool",
            kind: "tool.completed",
            summary: "read_me",
            payload: {
              title: "read_me",
              data: { rawOutput: "Always call create_view after read_scene." },
            },
            turnId,
            createdAt: "2026-07-14T00:00:00.000Z",
          },
        ],
      }),
    ).toBeNull();
  });

  it("still detects a canvas mutation when only the activity summary names create_view", () => {
    expect(
      canvasAgentMutationTurnId({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-07-14T00:00:00.000Z",
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: "2026-07-14T00:00:01.000Z",
          assistantMessageId: null,
        },
        activities: [
          {
            id: EventId.makeUnsafe("event-summary-only"),
            tone: "tool",
            kind: "tool.started",
            summary: "create_view started",
            payload: {
              title: "MCP tool call",
              data: { detail: "drawing update in progress" },
            },
            turnId,
            createdAt: "2026-07-14T00:00:00.000Z",
          },
        ],
      }),
    ).toBe(turnId);
  });
});
