// FILE: EnvironmentSubagentsSection.logic.test.ts
// Purpose: Locks the Environment panel subagent roster to full-history listing (settled
// rows survive), live-first ordering, task usage joined by Task tool_use_id, and the
// row meta/elapsed presentation.
// Layer: Environment panel tests
// Depends on: deriveEnvironmentSubagentRoster

import { EventId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { WorkLogEntry, WorkLogSubagent } from "../../../session-logic";
import {
  deriveEnvironmentSubagentRoster,
  environmentSubagentElapsedMs,
  formatEnvironmentSubagentMeta,
} from "./EnvironmentSubagentsSection.logic";

function workEntry(id: string, createdAt: string, subagents: WorkLogSubagent[]): WorkLogEntry {
  return {
    id,
    createdAt,
    label: "Ran subagents",
    tone: "tool",
    turnId: TurnId.makeUnsafe("turn-1"),
    subagents,
  };
}

function taskActivity(
  id: string,
  createdAt: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    createdAt,
    kind,
    summary: "Task activity",
    tone: "info",
    payload,
    turnId: null,
  };
}

describe("deriveEnvironmentSubagentRoster", () => {
  it("lists settled subagents after live ones and joins task usage by tool_use_id", () => {
    const roster = deriveEnvironmentSubagentRoster({
      workEntries: [
        workEntry("entry-1", "2026-10-10T10:00:00.000Z", [
          {
            threadId: "tool-a",
            providerThreadId: "tool-a",
            nickname: "Ada",
            rawStatus: "completed",
          },
          { threadId: "tool-b", providerThreadId: "tool-b", nickname: "Blue", rawStatus: "failed" },
        ]),
        workEntry("entry-2", "2026-10-10T10:05:00.000Z", [
          {
            threadId: "tool-c",
            providerThreadId: "tool-c",
            nickname: "Cyan",
            rawStatus: "running",
            isActive: true,
          },
          {
            threadId: "tool-d",
            providerThreadId: "tool-d",
            nickname: "Dove",
            rawStatus: "running",
            isActive: true,
          },
        ]),
      ],
      activities: [
        taskActivity("a-start", "2026-10-10T10:00:01.000Z", "task.started", {
          taskId: "task-a",
          toolUseId: "tool-a",
        }),
        taskActivity("a-progress", "2026-10-10T10:00:30.000Z", "task.progress", {
          taskId: "task-a",
          lastToolName: "Read",
          usage: { total_tokens: 4_000, tool_uses: 2, duration_ms: 29_000 },
        }),
        taskActivity("a-done", "2026-10-10T10:01:05.000Z", "task.completed", {
          taskId: "task-a",
          status: "completed",
          detail: "Found 3 call sites",
          usage: { total_tokens: 15_000, tool_uses: 5, duration_ms: 64_000 },
        }),
        taskActivity("b-start", "2026-10-10T10:00:02.000Z", "task.started", {
          taskId: "task-b",
          toolUseId: "tool-b",
        }),
        taskActivity("b-failed", "2026-10-10T10:03:00.000Z", "task.updated", {
          taskId: "task-b",
          status: "failed",
          detail: "Rate limited",
        }),
        taskActivity("c-start", "2026-10-10T10:05:20.000Z", "task.started", {
          taskId: "task-c",
          toolUseId: "tool-c",
        }),
        taskActivity("d-start", "2026-10-10T10:05:10.000Z", "task.started", {
          taskId: "task-d",
          toolUseId: "tool-d",
        }),
        taskActivity("c-progress", "2026-10-10T10:05:40.000Z", "task.progress", {
          taskId: "task-c",
          lastToolName: "Grep",
          usage: { total_tokens: 2_000 },
        }),
      ],
    });

    // Live rows in spawn order; settled rows most recently settled first.
    expect(roster.active.map((item) => item.primaryLabel)).toEqual(["Dove", "Cyan"]);
    expect(roster.previous.map((item) => item.primaryLabel)).toEqual(["Blue", "Ada"]);
    expect(roster.active[1]).toMatchObject({
      startedAt: "2026-10-10T10:05:20.000Z",
      settledAt: null,
      lastToolName: "Grep",
      totalTokens: 2_000,
    });
    expect(roster.previous[0]).toMatchObject({ statusKind: "failed", summary: "Rate limited" });
    expect(roster.previous[1]).toMatchObject({
      statusKind: "completed",
      settledAt: "2026-10-10T10:01:05.000Z",
      totalTokens: 15_000,
      toolUses: 5,
      durationMs: 64_000,
      summary: "Found 3 call sites",
    });
  });

  it("is empty when the thread spawned no subagents", () => {
    const roster = deriveEnvironmentSubagentRoster({
      workEntries: [workEntry("entry-1", "2026-10-10T10:00:00.000Z", [])],
      activities: [],
    });

    expect(roster).toEqual({ active: [], previous: [] });
  });
});

describe("environment subagent row presentation", () => {
  const base = {
    isActive: false,
    isBackground: false,
    lastToolName: null,
    statusKind: "completed" as const,
    summary: null,
    toolUses: null,
    totalTokens: null,
  };

  it.each([
    [
      "a failure shows its reason",
      { ...base, statusKind: "failed" as const, summary: "Rate limited", totalTokens: 900 },
      "Rate limited",
    ],
    [
      "a live row shows background, current tool, and tokens so far",
      {
        ...base,
        isActive: true,
        isBackground: true,
        statusKind: "running" as const,
        lastToolName: "Grep",
        totalTokens: 2_000,
        toolUses: 3,
      },
      "background · Grep · 2k tokens",
    ],
    [
      "a settled row shows its totals",
      { ...base, lastToolName: "Read", totalTokens: 15_000, toolUses: 1 },
      "15k tokens · 1 tool call",
    ],
    ["a row without usage has no meta", base, null],
  ])("%s", (_name, item, expected) => {
    expect(formatEnvironmentSubagentMeta(item)).toBe(expected);
  });

  it("ticks live rows from spawn and falls back to the settle time without usage", () => {
    const nowMs = Date.parse("2026-10-10T10:02:00.000Z");
    const startedAt = "2026-10-10T10:00:00.000Z";

    expect(
      environmentSubagentElapsedMs(
        { statusKind: "running", startedAt, settledAt: null, durationMs: 5_000 },
        nowMs,
      ),
    ).toBe(120_000);
    expect(
      environmentSubagentElapsedMs(
        { statusKind: "completed", startedAt, settledAt: null, durationMs: 64_000 },
        nowMs,
      ),
    ).toBe(64_000);
    expect(
      environmentSubagentElapsedMs(
        {
          statusKind: "stopped",
          startedAt,
          settledAt: "2026-10-10T10:00:45.000Z",
          durationMs: null,
        },
        nowMs,
      ),
    ).toBe(45_000);
    expect(
      environmentSubagentElapsedMs(
        { statusKind: "queued", startedAt, settledAt: null, durationMs: null },
        nowMs,
      ),
    ).toBeNull();
  });
});
