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

  it("groups delayed subagent result rows with the launch activity", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "agent-task-start",
        label: "Subagent smoke test",
        itemType: "collab_agent_tool_call",
        toolTitle: "Subagent smoke test",
        subagentAction: {
          tool: "subagent",
          status: "inProgress",
          summaryText: "Agent activity",
          prompt: "Run a harmless subagent smoke test.",
        },
        subagents: [
          {
            threadId: "child-provider-1",
            providerThreadId: "child-provider-1",
            nickname: "smoke-test",
            prompt: "Run a harmless subagent smoke test.",
          },
        ],
      }),
      workEntry({
        id: "agent-task-result",
        label: "Subagent result",
        itemType: "collab_agent_tool_call",
        toolTitle: "Subagent result",
        detail: "Subagent launched successfully from /home/ethan/synara and changed no files.",
        subagents: [
          {
            threadId: "child-provider-1",
            providerThreadId: "child-provider-1",
            nickname: "smoke-test",
            prompt: "Run a harmless subagent smoke test.",
          },
        ],
      }),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual(["agent-task-start"]);
    expect(state.timelineWorkEntries[0]).toMatchObject({
      id: "agent-task-start",
      toolTitle: "Subagent smoke test",
      detail: "Subagent launched successfully from /home/ethan/synara and changed no files.",
      subagents: [{ threadId: "child-provider-1", nickname: "smoke-test" }],
    });
    expect(state.detailById.get("agent-task-start")?.entries.map((entry) => entry.id)).toEqual([
      "agent-task-start",
      "agent-task-result",
    ]);
  });

  it("groups single subagent launch and result rows by child identity", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "agent-task-start",
        label: "Agent activity",
        itemType: "collab_agent_tool_call",
        toolTitle: "Agent activity",
        subagentAction: {
          tool: "subagent",
          status: "inProgress",
          summaryText: "Agent activity",
          prompt: "Run a smoke test and report back briefly.",
        },
        subagents: [
          {
            threadId: "child-provider-1",
            providerThreadId: "child-provider-1",
            nickname: "subagent-smoke-test",
          },
        ],
      }),
      workEntry({
        id: "agent-task-result",
        label: "Spawning 1 agent",
        itemType: "collab_agent_tool_call",
        toolTitle: "Spawning 1 agent",
        detail: "Subagent smoke test succeeded. No files were modified.",
        subagentAction: {
          tool: "spawnAgent",
          status: "completed",
          summaryText: "Spawning 1 agent",
        },
        subagents: [
          {
            threadId: "child-provider-1",
            providerThreadId: "child-provider-1",
            nickname: "subagent-smoke-test",
          },
        ],
      }),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual(["agent-task-start"]);
    expect(state.timelineWorkEntries[0]).toMatchObject({
      detail: "Subagent smoke test succeeded. No files were modified.",
      subagents: [{ threadId: "child-provider-1", nickname: "subagent-smoke-test" }],
    });
    expect(state.detailById.get("agent-task-start")?.entries.map((entry) => entry.id)).toEqual([
      "agent-task-start",
      "agent-task-result",
    ]);
  });

  it("omits redundant single-agent launch rows when a parallel dispatch summary exists", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "parallel-summary",
        label: "Agent activity",
        itemType: "collab_agent_tool_call",
        toolTitle: "Agent activity",
        subagentAction: {
          tool: "spawnAgent",
          status: "completed",
          summaryText: "Agent activity",
        },
        subagents: [
          { threadId: "child-one", providerThreadId: "child-one", nickname: "one" },
          { threadId: "child-two", providerThreadId: "child-two", nickname: "two" },
          { threadId: "child-three", providerThreadId: "child-three", nickname: "three" },
        ],
      }),
      workEntry({
        id: "launch-one",
        label: "Spawning 1 agent",
        itemType: "collab_agent_tool_call",
        toolTitle: "Spawning 1 agent",
        detail: "parallel-test-one(explore)",
        preview: "parallel-test-one [explore]",
        subagentAction: {
          tool: "spawnAgent",
          status: "inProgress",
          summaryText: "Spawning 1 agent",
        },
        subagents: [{ threadId: "child-one", providerThreadId: "child-one", nickname: "one" }],
      }),
      workEntry({
        id: "launch-two",
        label: "Spawning 1 agent",
        itemType: "collab_agent_tool_call",
        toolTitle: "Spawning 1 agent",
        subagentAction: {
          tool: "spawnAgent",
          status: "inProgress",
          summaryText: "Spawning 1 agent",
        },
        subagents: [{ threadId: "child-two", providerThreadId: "child-two", nickname: "two" }],
      }),
      workEntry({
        id: "launch-three",
        label: "Spawning 1 agent",
        itemType: "collab_agent_tool_call",
        toolTitle: "Spawning 1 agent",
        subagentAction: {
          tool: "spawnAgent",
          status: "inProgress",
          summaryText: "Spawning 1 agent",
        },
        subagents: [
          { threadId: "child-three", providerThreadId: "child-three", nickname: "three" },
        ],
      }),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual(["parallel-summary"]);
    expect(state.timelineWorkEntries[0]?.subagents?.map((subagent) => subagent.threadId)).toEqual([
      "child-one",
      "child-two",
      "child-three",
    ]);
  });

  it("keeps matching single-agent result details in the grouped activity", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "parallel-summary",
        label: "Agent activity",
        itemType: "collab_agent_tool_call",
        toolTitle: "Agent activity",
        subagents: [
          { threadId: "child-one", providerThreadId: "child-one", nickname: "one" },
          { threadId: "child-two", providerThreadId: "child-two", nickname: "two" },
        ],
      }),
      workEntry({
        id: "result-one",
        label: "Agent activity",
        itemType: "collab_agent_tool_call",
        toolTitle: "Agent result",
        detail: "Child one found the relevant files.",
        subagentAction: {
          tool: "spawnAgent",
          status: "completed",
          summaryText: "Agent activity",
        },
        subagents: [{ threadId: "child-one", providerThreadId: "child-one", nickname: "one" }],
      }),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual(["parallel-summary"]);
    expect(state.timelineWorkEntries[0]).toMatchObject({
      detail: "Child one found the relevant files.",
    });
    expect(state.detailById.get("parallel-summary")?.entries.map((entry) => entry.id)).toEqual([
      "parallel-summary",
      "result-one",
    ]);
  });

  it("does not group independent launches by prompt or nickname alone", () => {
    const state = deriveAgentActivityTimelineState([
      workEntry({
        id: "agent-task-one",
        label: "Agent activity",
        itemType: "collab_agent_tool_call",
        toolTitle: "Agent activity",
        subagentAction: {
          tool: "subagent",
          status: "completed",
          summaryText: "Agent activity",
          prompt: "Run the shared smoke check.",
        },
        subagents: [{ threadId: "first-child", nickname: "smoke-test" }],
      }),
      workEntry({
        id: "agent-task-two",
        label: "Agent activity",
        itemType: "collab_agent_tool_call",
        toolTitle: "Agent activity",
        subagentAction: {
          tool: "subagent",
          status: "completed",
          summaryText: "Agent activity",
          prompt: "Run the shared smoke check.",
        },
        subagents: [{ threadId: "second-child", nickname: "smoke-test" }],
      }),
    ]);

    expect(state.timelineWorkEntries.map((entry) => entry.id)).toEqual([
      "agent-task-one",
      "agent-task-two",
    ]);
  });
});
