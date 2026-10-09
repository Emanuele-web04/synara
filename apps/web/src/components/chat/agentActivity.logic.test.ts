import { TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import type { WorkLogEntry } from "../../session-logic";
import {
  deriveAgentActivityTimelineState,
  formatAgentActivityEntryPreview,
  formatAgentActivityEntryTitle,
  isAgentActivityWorkEntry,
  isCodexActivityStatusWorkEntry,
  isPlainRuntimeNoticeWorkEntry,
  isReasoningUpdateWorkEntry,
  isUnmappedProviderEventWorkEntry,
} from "./agentActivity.logic";
import { deriveTimelineEntries } from "../../workLog";

function workEntry(overrides: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id">): WorkLogEntry {
  return {
    createdAt: "2026-06-05T00:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  };
}

describe("deriveAgentActivityTimelineState", () => {
  it("compacts consecutive reasoning updates while preserving detail entries", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "reasoning-1",
        label: "Reasoning update",
        tone: "info",
        detail: "Running Check sidebar z-index",
      }),
      workEntry({
        id: "reasoning-2",
        label: "Reasoning update",
        tone: "info",
        detail: "Running Verify diffToggleControl uses valid props",
      }),
      workEntry({
        id: "tool-1",
        label: "Read",
        tone: "tool",
      }),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual([
      "agent-reasoning:reasoning-1",
      "tool-1",
    ]);
    expect(state.timelineWorkEntries[0]).toMatchObject({
      label: "Reasoning trace",
      toolTitle: "Reasoning trace",
      preview: "2 updates - Verify diffToggleControl uses valid props",
    });
    expect(state.detailById.get("agent-reasoning:reasoning-1")?.entries).toHaveLength(2);
  });

  it("keeps canonical reasoning tool calls as separate timeline rows", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "reasoning-item-1",
        label: "Reasoning",
        toolTitle: "Reasoning",
        toolCallId: "provider-reasoning-1",
        detail: "Inspect the protocol",
      }),
      workEntry({
        id: "reasoning-item-2",
        label: "Reasoning",
        toolTitle: "Reasoning",
        toolCallId: "provider-reasoning-2",
        detail: "Update the adapter",
      }),
      workEntry({
        id: "reasoning-item-3",
        label: "Reasoning",
        toolTitle: "Reasoning",
        toolCallId: "provider-reasoning-3",
        detail: "Verify the result",
      }),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual([
      "reasoning-item-1",
      "reasoning-item-2",
      "reasoning-item-3",
    ]);
    expect(state.timelineWorkEntries.every((entry) => entry.tone === "tool")).toBe(true);
  });

  it("shows the latest readable Codex summary and omits empty placeholders", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "reasoning-visible",
        label: "Reasoning trace",
        toolTitle: "Reasoning trace",
        toolCallId: "provider-reasoning-visible",
        detail:
          "**Planning Codex threads inspection**\n\n<!-- -->\n\n**Refining the display logic**\n\n<!-- -->",
      }),
      workEntry({
        id: "reasoning-empty",
        label: "Reasoning trace",
        toolTitle: "Reasoning trace",
        toolCallId: "provider-reasoning-empty",
      }),
    ]);

    expect(state.timelineWorkEntries).toHaveLength(1);
    expect(state.timelineWorkEntries[0]).toMatchObject({
      id: "reasoning-visible",
      preview: "Refining the display logic",
    });
  });

  it("recognizes reasoning trace and summary labels as reasoning activity", () => {
    const trace = workEntry({
      id: "reasoning-trace-1",
      label: "Reasoning trace",
      detail: "Reasoning trace Running Inspect the protocol",
    });
    const summary = workEntry({
      id: "reasoning-summary-1",
      label: "Reasoning summary",
      detail: "Reasoning summary Update the adapter",
    });

    expect(isReasoningUpdateWorkEntry(trace)).toBe(true);
    expect(isReasoningUpdateWorkEntry(summary)).toBe(true);
    expect(
      isCodexActivityStatusWorkEntry(
        workEntry({
          id: "command-execution-1",
          label: "Ran command",
          toolTitle: "Ran command",
          itemType: "command_execution",
        }),
      ),
    ).toBe(true);
    expect(formatAgentActivityEntryPreview(trace)).toBe("Inspect the protocol");
    expect(formatAgentActivityEntryPreview(summary)).toBe("Update the adapter");
  });

  it("keeps generic agent task rows openable without compacting them away", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "agent-task-1",
        label: "Find changelog implementation",
        itemType: "collab_agent_tool_call",
        toolTitle: "Find changelog implementation",
        subagentAction: {
          tool: "task",
          status: "completed",
          summaryText: "Agent activity",
          prompt: "Explore this codebase to find the changelog feature.",
        },
      }),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual(["agent-task-1"]);
    expect(isAgentActivityWorkEntry(state.timelineWorkEntries[0]!)).toBe(true);
    expect(state.detailById.get("agent-task-1")).toMatchObject({
      title: "Find changelog implementation",
      summary: "Explore this codebase to find the changelog feature.",
    });
  });

  it("uses the prompt as the detail summary when the agent result is long", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "agent-task-1",
        label: "Find changelog implementation",
        itemType: "collab_agent_tool_call",
        toolTitle: "Find changelog implementation",
        detail: "Full changelog report\nwith many file references and implementation notes.",
        subagentAction: {
          tool: "task",
          status: "completed",
          summaryText: "Agent activity",
          prompt: "Explore this codebase to find the changelog feature.",
        },
      }),
    ]);

    expect(state.detailById.get("agent-task-1")).toMatchObject({
      summary: "Explore this codebase to find the changelog feature.",
    });
    expect(state.timelineWorkEntries[0]).toMatchObject({
      detail: "Full changelog report\nwith many file references and implementation notes.",
    });
  });

  it("anchors a reasoning group spanning an interleaved tool row to its first update", () => {
    const firstReasoningAt = "2026-06-05T00:00:01.000Z";
    const interleavedToolAt = "2026-06-05T00:00:02.000Z";
    const secondReasoningAt = "2026-06-05T00:00:03.000Z";
    const trailingToolAt = "2026-06-05T00:00:04.000Z";
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "reasoning-1",
        label: "Reasoning update",
        tone: "info",
        createdAt: firstReasoningAt,
      }),
      workEntry({
        id: "reasoning-2",
        label: "Reasoning update",
        tone: "info",
        createdAt: secondReasoningAt,
      }),
      workEntry({ id: "tool-1", label: "bash", createdAt: interleavedToolAt }),
      workEntry({ id: "tool-2", label: "bash", createdAt: trailingToolAt }),
    ]);

    expect(state.timelineWorkEntries[0]!.createdAt).toBe(firstReasoningAt);
    const timeline = deriveTimelineEntries([], [], state.timelineWorkEntries);
    expect(timeline.map((entry) => entry.id)).toEqual([
      "agent-reasoning:reasoning-1",
      "tool-1",
      "tool-2",
    ]);
  });
});

describe("subagent progress", () => {
  const progress = (
    id: string,
    toolUseId: string,
    title: string,
    detail: string,
    turnId: string,
  ): WorkLogEntry =>
    workEntry({
      id,
      label: "Subagent progress",
      tone: "info",
      activityKind: "task.progress",
      detail,
      turnId: TurnId.makeUnsafe(turnId),
      subagentProgress: { toolUseId, title },
    });

  it("is attributed to its subagent instead of reading as reasoning", () => {
    const entry = progress("p-1", "toolu_outer", "Outer worker", "Running Sleep 8", "turn-1");
    expect(isReasoningUpdateWorkEntry(entry)).toBe(false);
    expect(formatAgentActivityEntryTitle(entry)).toBe("Outer worker");
    // Settled steps must not keep the present-tense "Running" prefix.
    expect(formatAgentActivityEntryPreview(entry)).toBe("Sleep 8");
  });

  it("groups per subagent and per turn, never across either", () => {
    const state = deriveAgentActivityTimelineState([
      progress("a-1", "toolu_a", "Agent A", "Running sleep 8", "turn-1"),
      progress("b-1", "toolu_b", "Agent B", "Running sleep 12", "turn-1"),
      progress("a-2", "toolu_a", "Agent A", "Running echo A", "turn-1"),
      workEntry({
        id: "reasoning-1",
        label: "Reasoning update",
        tone: "info",
        turnId: TurnId.makeUnsafe("turn-1"),
      }),
      progress("a-3", "toolu_a", "Agent A", "Running wc -l", "turn-2"),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual([
      "subagent-progress:a-1",
      "subagent-progress:b-1",
      "agent-reasoning:reasoning-1",
      "subagent-progress:a-3",
    ]);
    expect(state.timelineWorkEntries[0]).toMatchObject({
      label: "Agent A",
      toolTitle: "Agent A",
      preview: "2 updates - echo A",
    });
    expect(state.timelineWorkEntries[1]).toMatchObject({ label: "Agent B", preview: "sleep 12" });
    expect(state.timelineWorkEntries[3]).toMatchObject({ label: "Agent A", preview: "wc -l" });
    expect(state.detailById.get("subagent-progress:a-1")?.entries).toHaveLength(2);
    expect(state.detailById.get("subagent-progress:a-1")?.title).toBe("Agent A");
  });

  it("shows a stopped or failed subagent's outcome instead of a done row", () => {
    const withOutcome = (
      id: string,
      outcome: "completed" | "failed" | "stopped",
    ): WorkLogEntry => ({
      ...progress(id, `toolu_${id}`, `Agent ${id}`, "Running sleep 45", "turn-1"),
      subagentProgress: { toolUseId: `toolu_${id}`, title: `Agent ${id}`, outcome },
    });
    const state = deriveAgentActivityTimelineState([
      withOutcome("a", "stopped"),
      withOutcome("b", "failed"),
      withOutcome("c", "completed"),
    ]);
    const [stopped, failed, completed] = state.timelineWorkEntries;
    expect(stopped).toMatchObject({ preview: "Stopped - sleep 45", tone: "info" });
    expect(failed).toMatchObject({ preview: "Failed - sleep 45", tone: "error" });
    expect(completed).toMatchObject({ preview: "sleep 45", tone: "info" });
  });

  it("does not merge reasoning updates from different turns", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "r-1",
        label: "Reasoning update",
        tone: "info",
        turnId: TurnId.makeUnsafe("turn-1"),
      }),
      workEntry({
        id: "r-2",
        label: "Reasoning update",
        tone: "info",
        turnId: TurnId.makeUnsafe("turn-2"),
      }),
    ]);
    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual([
      "agent-reasoning:r-1",
      "agent-reasoning:r-2",
    ]);
  });
});

describe("unmapped provider events", () => {
  it("labels an unmapped event with its native type and safe detail", () => {
    const entry = workEntry({
      id: "unmapped-1",
      label: "item/agentMessage/completed",
      toolTitle: "item/agentMessage/completed",
      activityKind: "provider.event.unmapped",
      nativeEventType: "item/agentMessage/completed",
      detail: "Finished the refactor",
      tone: "info",
    });

    expect(isUnmappedProviderEventWorkEntry(entry)).toBe(true);
    // Raw native type/label is the title instead of the generic "Activity".
    expect(formatAgentActivityEntryTitle(entry)).toBe("Item/agentMessage/completed");
    expect(formatAgentActivityEntryPreview(entry)).toBe("Finished the refactor");
    // The unmapped fallback never hijacks explicit, working mappings.
    expect(isCodexActivityStatusWorkEntry(entry)).toBe(false);
    expect(isAgentActivityWorkEntry(entry)).toBe(false);
  });

  it("still derives a native-type title when the normalized heading is empty", () => {
    const entry = workEntry({
      id: "unmapped-2",
      label: "done",
      activityKind: "provider.event.unmapped",
      nativeEventType: "done",
      tone: "info",
    });
    // normalizeCompactToolLabel strips the trailing "done", which previously
    // fell through to the generic "Activity" label.
    expect(formatAgentActivityEntryTitle(entry)).toBe("Done");
  });
});

describe("isPlainRuntimeNoticeWorkEntry", () => {
  it("matches generic runtime warnings but not notices with their own icon", () => {
    const warning = workEntry({
      id: "warning-1",
      label: "Runtime warning",
      tone: "info",
      activityKind: "runtime.warning",
      detail: "Unhandled Claude system message subtype 'api_retry'.",
    });

    expect(isPlainRuntimeNoticeWorkEntry(warning)).toBe(true);
    expect(
      isPlainRuntimeNoticeWorkEntry({
        ...warning,
        nativeEventType: "background_tasks_changed",
      }),
    ).toBe(false);
    expect(isPlainRuntimeNoticeWorkEntry(workEntry({ id: "tool-1" }))).toBe(false);
  });
});
