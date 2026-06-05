import { describe, expect, it } from "vitest";
import type { WorkLogEntry } from "../../session-logic";
import {
  deriveAgentActivityTimelineState,
  formatAgentActivityEntryPreview,
  isAgentActivityWorkEntry,
} from "./agentActivity.logic";

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
      label: "Reasoning",
      toolTitle: "Reasoning",
      preview: "2 updates - Verify diffToggleControl uses valid props",
    });
    expect(state.detailById.get("agent-reasoning:reasoning-1")?.entries).toHaveLength(2);
  });

  it("cleans reasoning prefixes for single update previews", () => {
    const entry = workEntry({
      id: "reasoning-1",
      label: "Reasoning update",
      detail: "Reasoning update Running Complete analysis of the floating panel issue",
    });

    expect(formatAgentActivityEntryPreview(entry)).toBe(
      "Complete analysis of the floating panel issue",
    );
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
});
