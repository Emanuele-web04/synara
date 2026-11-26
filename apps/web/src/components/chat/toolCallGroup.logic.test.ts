import { describe, expect, it } from "vitest";
import { deriveReadableCommandDisplay, deriveReadableToolTitle } from "../../lib/toolCallLabel";
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
  it("classifies shell read commands and structured source verbs", () => {
    const display = deriveReadableCommandDisplay("cat Settings", true);
    expect(
      classifyToolCallSummaryCategory(
        workEntry({
          id: "localized-read",
          itemType: "command_execution",
          command: display.fullCommand,
          toolTitle: display.verb,
        }),
      ),
    ).toBe("read");
    const sourceTitle = deriveReadableToolTitle({
      title: "Read",
      fallbackLabel: "Tool",
      itemType: "command_execution",
    });
    expect(sourceTitle).toBe("Read");
    expect(
      classifyToolCallSummaryCategory(
        workEntry({
          id: "structured-read",
          itemType: "command_execution",
          ...(sourceTitle ? { toolTitle: sourceTitle } : {}),
        }),
      ),
    ).toBe("read");
  });

  it("classifies file changes as edits", () => {
    expect(classifyToolCallSummaryCategory(edit("e1", ["a.ts"]))).toBe("edit");
    expect(
      classifyToolCallSummaryCategory(workEntry({ id: "e2", requestKind: "file-change" })),
    ).toBe("edit");
  });

  it("classifies search commands and structured search actions apart from web searches", () => {
    expect(classifyToolCallSummaryCategory(command("s1", 'rg -n "foo" src'))).toBe("search");
    expect(
      classifyToolCallSummaryCategory(
        workEntry({ id: "s2", itemType: "command_execution", toolTitle: "Searched" }),
      ),
    ).toBe("search");
    expect(classifyToolCallSummaryCategory(workEntry({ id: "s3", itemType: "web_search" }))).toBe(
      "web-search",
    );
    expect(
      classifyToolCallSummaryCategory(
        workEntry({ id: "s4", itemType: "dynamic_tool_call", toolName: "WebSearch" }),
      ),
    ).toBe("web-search");
  });

  it("classifies ACP native read and search tool names", () => {
    // Grok/Cursor report reads through rawInput._toolName (read_file, view) and
    // searches as `search`/`find`; all must count in the collapsed summary.
    expect(
      classifyToolCallSummaryCategory(
        workEntry({ id: "g1", itemType: "dynamic_tool_call", toolName: "read_file" }),
      ),
    ).toBe("read");
    expect(
      classifyToolCallSummaryCategory(
        workEntry({ id: "g2", itemType: "dynamic_tool_call", toolName: "view" }),
      ),
    ).toBe("read");
    expect(
      classifyToolCallSummaryCategory(
        workEntry({ id: "g3", itemType: "dynamic_tool_call", toolName: "search" }),
      ),
    ).toBe("search");
    expect(
      classifyToolCallSummaryCategory(
        workEntry({ id: "g4", itemType: "web_search", toolName: "grep" }),
      ),
    ).toBe("search");
  });

  it("classifies mutating commands, agent tasks, and MCP tools", () => {
    expect(classifyToolCallSummaryCategory(command("c1"))).toBe("command");
    expect(
      classifyToolCallSummaryCategory(
        workEntry({
          id: "compound",
          itemType: "command_execution",
          toolTitle: "Read src/app.ts",
          command: "cat src/app.ts | head -n 5",
        }),
      ),
    ).toBe("command");
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
    expect(
      isSummarizableToolCallEntry(workEntry({ id: "connector", connectorProposalId: "pending" })),
    ).toBe(false);
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

  it("includes provider error-toned tool failures in the count and summary", () => {
    const summary = summarizeToolCallGroup([
      command("ok", "ls"),
      workEntry({
        id: "failed",
        itemType: "command_execution",
        command: "missing-command",
        activityKind: "tool.completed",
        toolStatus: "failed",
        tone: "error",
      }),
    ]);
    expect(summary?.label).toBe("Ran 2 commands");
    expect(summary?.failedCount).toBe(1);
  });

  it("counts background launches and their failures without a live state", () => {
    const background = (id: string, status: "running" | "failed") =>
      workEntry({
        id,
        label: "Background task",
        backgroundTask: {
          taskId: id,
          taskType: "local_bash",
          description: null,
          command: "bun run dev",
          status,
          startedAt: "2026-06-05T00:00:00.000Z",
          completedAt: status === "running" ? null : "2026-06-05T00:00:01.000Z",
          exitCode: status === "failed" ? 1 : null,
        },
      });
    const summary = summarizeToolCallGroup([
      command("c1", "nc -z 127.0.0.1 3947"),
      background("b1", "failed"),
      background("b2", "running"),
    ]);
    expect(summary?.label).toBe("Ran 1 command, 2 in background");
    expect(summary?.failedLabel).toBe("1 failed");
    // A task still running is not a call in flight: its live state lives in
    // the Environment panel.
    expect(summary?.runningCount).toBe(0);
    expect(summary?.runningLabel).toBeNull();
    expect(
      summarizeToolCallGroup([background("b3", "running"), background("b4", "running")]),
    ).toMatchObject({ label: "2 in background", iconCategory: "background" });
  });

  it("counts calls still running next to the failed count", () => {
    const summary = summarizeToolCallGroup([
      claudeRead("r1", "/repo/a.ts"),
      { ...command("c1", "bun run lint"), toolStatus: "running" },
      { ...command("c2", "bun run test"), toolStatus: "failed" },
    ]);
    expect(summary).toMatchObject({
      label: "Read 1 file, ran 2 commands",
      failedLabel: "1 failed",
      runningCount: 1,
      runningLabel: "1 running",
    });
    expect(
      summarizeToolCallGroup([
        { ...command("c1", "bun run lint"), toolStatus: "running" },
        { ...command("c2", "bun run test"), toolStatus: "running" },
      ])?.runningLabel,
    ).toBe("2 running");
  });

  it("names every kind up to five", () => {
    const summary = summarizeToolCallGroup([
      claudeRead("r1", "/repo/a.ts"),
      command("c1", "bun run lint"),
      edit("e1", ["a.ts"]),
      command("s1", "rg foo src"),
      workEntry({ id: "m1", itemType: "mcp_tool_call", toolName: "linear_get_issue" }),
    ]);
    expect(summary?.label).toBe(
      "Read 1 file, ran 1 command, edited 1 file, searched once, used 1 tool",
    );
  });

  it("folds only the kinds past the fourth when a run has more than five", () => {
    const summary = summarizeToolCallGroup([
      claudeRead("r1", "/repo/a.ts"),
      command("c1", "bun run lint"),
      edit("e1", ["a.ts"]),
      command("s1", "rg foo src"),
      workEntry({ id: "w1", itemType: "web_search" }),
      workEntry({ id: "m1", itemType: "mcp_tool_call", toolName: "linear_get_issue" }),
      workEntry({ id: "o1", itemType: "image_view" }),
    ]);
    expect(summary?.label).toBe(
      "Read 1 file, ran 1 command, edited 1 file, searched once, 3 other actions",
    );
  });

  it("tells web searches apart from code searches", () => {
    const summary = summarizeToolCallGroup([
      command("s1", "rg foo src"),
      workEntry({ id: "w1", itemType: "web_search" }),
      command("s2", "grep bar lib"),
      workEntry({ id: "w2", itemType: "dynamic_tool_call", toolName: "WebSearch" }),
      command("s3", "rg baz docs"),
      workEntry({ id: "w3", itemType: "web_search" }),
    ]);
    expect(summary?.label).toBe("Searched 3 times, searched the web 3 times");
    expect(
      summarizeToolCallGroup([
        workEntry({ id: "w4", itemType: "web_search" }),
        workEntry({ id: "w5", itemType: "web_search" }),
      ]),
    ).toMatchObject({ label: "Searched the web twice", iconCategory: "web-search" });
  });

  it("keeps the uncategorized wording for a trailing other kind", () => {
    const summary = summarizeToolCallGroup([
      command("c1"),
      workEntry({ id: "o1", itemType: "image_view" }),
      workEntry({ id: "o2", itemType: "image_generation" }),
    ]);
    expect(summary?.label).toBe("Ran 1 command, 2 other actions");
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
