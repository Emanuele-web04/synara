import { describe, expect, it } from "vitest";
import type { WorkLogEntry } from "../../session-logic";
import {
  classifyToolCallSummaryCategory,
  isSummarizableToolCallEntry,
  summarizeToolCallGroup,
} from "./toolCallGroup.logic";

function workEntry(overrides: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id">): WorkLogEntry {
  return {
    createdAt: "2026-06-05T00:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  };
}

const command = (id: string, cmd = "bun run build") =>
  workEntry({ id, itemType: "command_execution", command: cmd });
const edit = (id: string, files: string[]) =>
  workEntry({ id, itemType: "file_change", changedFiles: files });

describe("classifyToolCallSummaryCategory", () => {
  it("classifies file changes as edits", () => {
    expect(classifyToolCallSummaryCategory(edit("e1", ["a.ts"]))).toBe("edit");
    expect(
      classifyToolCallSummaryCategory(workEntry({ id: "e2", requestKind: "file-change" })),
    ).toBe("edit");
  });

  it("classifies file reads via requestKind and read-only commands", () => {
    expect(classifyToolCallSummaryCategory(workEntry({ id: "r1", requestKind: "file-read" }))).toBe(
      "read",
    );
    expect(classifyToolCallSummaryCategory(command("r2", "cat src/app.ts"))).toBe("read");
  });

  it("classifies search commands, structured search actions, and web searches", () => {
    expect(classifyToolCallSummaryCategory(command("s1", 'rg -n "foo" src'))).toBe("search");
    expect(
      classifyToolCallSummaryCategory(
        workEntry({ id: "s2", itemType: "command_execution", toolTitle: "Searched" }),
      ),
    ).toBe("search");
    expect(classifyToolCallSummaryCategory(workEntry({ id: "s3", itemType: "web_search" }))).toBe(
      "search",
    );
  });

  it("classifies mutating commands, agent tasks, and MCP tools", () => {
    expect(classifyToolCallSummaryCategory(command("c1"))).toBe("command");
    expect(
      classifyToolCallSummaryCategory(workEntry({ id: "a1", itemType: "collab_agent_tool_call" })),
    ).toBe("agent");
    expect(
      classifyToolCallSummaryCategory(workEntry({ id: "m1", itemType: "mcp_tool_call" })),
    ).toBe("tool");
    expect(classifyToolCallSummaryCategory(workEntry({ id: "m2", toolName: "WebFetch" }))).toBe(
      "tool",
    );
  });
});

describe("isSummarizableToolCallEntry", () => {
  it("rejects non-tool tones and rich card entries", () => {
    expect(isSummarizableToolCallEntry(workEntry({ id: "err", tone: "error" }))).toBe(false);
    expect(isSummarizableToolCallEntry(workEntry({ id: "info", tone: "info" }))).toBe(false);
    expect(
      isSummarizableToolCallEntry(
        workEntry({
          id: "sub",
          subagents: [{ threadId: "thread-1" }],
        }),
      ),
    ).toBe(false);
    expect(
      isSummarizableToolCallEntry(
        workEntry({
          id: "sub-action",
          subagentAction: { tool: "task", status: "running", summaryText: "Working" },
        }),
      ),
    ).toBe(false);
    expect(
      isSummarizableToolCallEntry(
        workEntry({
          id: "auto",
          automation: { id: "a", name: "Nightly", cadenceLabel: "daily" },
        }),
      ),
    ).toBe(false);
    expect(
      isSummarizableToolCallEntry(
        workEntry({
          id: "threads",
          synaraThreadCreation: {
            operationId: "op",
            requestedCount: 1,
            createdCount: 1,
            threads: [],
          },
        }),
      ),
    ).toBe(false);
  });

  it("accepts plain tool entries", () => {
    expect(isSummarizableToolCallEntry(command("c1"))).toBe(true);
  });
});

describe("summarizeToolCallGroup", () => {
  it("returns null below the minimum group size", () => {
    expect(summarizeToolCallGroup([])).toBeNull();
    expect(summarizeToolCallGroup([command("c1")])).toBeNull();
    // A lone tool entry next to excluded entries still does not fold.
    expect(
      summarizeToolCallGroup([command("c1"), workEntry({ id: "e", tone: "error" })]),
    ).toBeNull();
  });

  it("labels a homogeneous command run", () => {
    const summary = summarizeToolCallGroup([
      command("c1"),
      command("c2"),
      command("c3"),
      command("c4"),
    ]);
    expect(summary?.label).toBe("Ran 4 commands");
    expect(summary?.entryCount).toBe(4);
  });

  it("joins mixed categories in a fixed order", () => {
    const summary = summarizeToolCallGroup([
      command("s1", 'rg -n "alpha" src'),
      edit("e1", ["a.ts"]),
      command("c1"),
      command("s2", "grep beta lib"),
      edit("e2", ["b.ts"]),
      command("c2", "bun run lint"),
      command("s3", "rg gamma docs"),
    ]);
    expect(summary?.label).toBe("Ran 2 commands, Edited 2 files, Searched 3 files");
  });

  it("counts distinct files for edits across entries", () => {
    const summary = summarizeToolCallGroup([
      edit("e1", ["Sidebar.tsx"]),
      edit("e2", ["Sidebar.tsx"]),
      edit("e3", ["Sidebar.tsx", "Sidebar.logic.ts"]),
    ]);
    expect(summary?.label).toBe("Edited 2 files");
  });

  it("counts edits without file info as one unit each", () => {
    const summary = summarizeToolCallGroup([
      workEntry({ id: "e1", itemType: "file_change" }),
      workEntry({ id: "e2", itemType: "file_change" }),
      edit("e3", ["a.ts"]),
    ]);
    expect(summary?.label).toBe("Edited 3 files");
  });

  it("dedupes reads of the same file across command and structured entries", () => {
    const summary = summarizeToolCallGroup([
      command("r1", "cat src/app.ts"),
      command("r2", "cat src/app.ts"),
      workEntry({ id: "r3", requestKind: "file-read", changedFiles: ["src/main.ts"] }),
    ]);
    expect(summary?.label).toBe("Read 2 files");
  });

  it("uses singular forms for single counts", () => {
    const summary = summarizeToolCallGroup([command("c1"), edit("e1", ["a.ts"])]);
    expect(summary?.label).toBe("Ran 1 command, Edited 1 file");
  });

  it("labels MCP tools and agent tasks", () => {
    const summary = summarizeToolCallGroup([
      workEntry({ id: "m1", itemType: "mcp_tool_call" }),
      workEntry({ id: "m2", itemType: "dynamic_tool_call" }),
      workEntry({ id: "a1", itemType: "collab_agent_tool_call" }),
    ]);
    expect(summary?.label).toBe("Ran 1 agent task, Used 2 tools");
  });

  it("labels an uncategorized-only run as plain tool calls", () => {
    const summary = summarizeToolCallGroup([
      workEntry({ id: "o1", itemType: "image_view" }),
      workEntry({ id: "o2", itemType: "image_generation" }),
    ]);
    expect(summary?.label).toBe("Ran 2 tool calls");
  });

  it("skips excluded entries while summarizing the rest", () => {
    const summary = summarizeToolCallGroup([
      command("c1"),
      command("c2"),
      workEntry({ id: "err", tone: "error" }),
      workEntry({ id: "sub", subagents: [{ threadId: "thread-1" }] }),
    ]);
    expect(summary?.label).toBe("Ran 2 commands");
    expect(summary?.entryCount).toBe(2);
  });

  it("flags groups that still contain running work", () => {
    const settled = summarizeToolCallGroup([command("c1"), command("c2")]);
    expect(settled?.hasRunningEntry).toBe(false);
    const running = summarizeToolCallGroup([
      command("c1"),
      workEntry({ id: "c2", itemType: "command_execution", toolStatus: "running" }),
    ]);
    expect(running?.hasRunningEntry).toBe(true);
  });
});
