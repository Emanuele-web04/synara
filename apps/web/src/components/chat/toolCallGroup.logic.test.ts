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
// Claude reports Read as a generic dynamic tool call with JSON arguments.
const claudeRead = (id: string, filePath: string) =>
  workEntry({
    id,
    itemType: "dynamic_tool_call",
    toolName: "Read",
    detail: `Read: ${JSON.stringify({ file_path: filePath })}`,
  });

describe("classifyToolCallSummaryCategory", () => {
  it("classifies file changes as edits", () => {
    expect(classifyToolCallSummaryCategory(edit("e1", ["a.ts"]))).toBe("edit");
    expect(
      classifyToolCallSummaryCategory(workEntry({ id: "e2", requestKind: "file-change" })),
    ).toBe("edit");
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

  it("joins mixed categories with verbs in the order the work happened", () => {
    const summary = summarizeToolCallGroup([
      command("s1", 'rg -n "alpha" src'),
      edit("e1", ["a.ts"]),
      command("c1"),
      command("s2", "grep beta lib"),
      edit("e2", ["b.ts"]),
      command("c2", "bun run lint"),
      command("s3", "rg gamma docs"),
    ]);
    expect(summary?.label).toBe("Searched 3 times, edited 2 files, ran 2 commands");
    expect(summary?.iconCategory).toBe("mixed");
  });

  it("summarizes Claude reads and a failing command like the transcript mockup", () => {
    const summary = summarizeToolCallGroup([
      claudeRead("r1", "/repo/calc.py"),
      claudeRead("r2", "/repo/README.md"),
      command("c1", "ls"),
      command("c2", "wc -l calc.py README.md"),
      workEntry({
        id: "c3",
        itemType: "command_execution",
        command: 'rg "^def " calc.py',
        toolStatus: "failed",
      }),
    ]);
    expect(summary?.label).toBe("Read 2 files, ran 2 commands, searched once");
    expect(summary?.failedCount).toBe(1);
    expect(summary?.failedLabel).toBe("1 failed");
  });

  it("names at most three kinds and folds the rest into other actions", () => {
    const summary = summarizeToolCallGroup([
      claudeRead("r1", "/repo/a.ts"),
      command("c1", "bun run lint"),
      edit("e1", ["a.ts"]),
      command("s1", "rg foo src"),
      workEntry({ id: "m1", itemType: "mcp_tool_call", toolName: "linear_get_issue" }),
    ]);
    expect(summary?.label).toBe("Read 1 file, ran 1 command, 3 other actions");
  });

  it("wears the kind's glyph when every call is the same kind", () => {
    expect(
      summarizeToolCallGroup([claudeRead("r1", "/repo/a.ts"), claudeRead("r2", "/repo/b.ts")])
        ?.iconCategory,
    ).toBe("read");
    expect(summarizeToolCallGroup([command("c1"), command("c2", "ls")])?.iconCategory).toBe(
      "command",
    );
  });

  it("never reports a listing or find as a read of the current directory", () => {
    const summary = summarizeToolCallGroup([
      command("c1", "ls"),
      command("c2", 'find . -name "*.md" -not -path "./.git/*"'),
    ]);
    expect(summary?.label).toBe("Ran 1 command, searched once");
    expect(summary?.failedLabel).toBeNull();
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
});
