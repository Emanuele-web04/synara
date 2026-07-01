import { describe, expect, it } from "vitest";

import {
  classifyRequestType,
  classifyToolItemType,
  isReadOnlyToolName,
} from "./claudeToolClassification.ts";

describe("classifyToolItemType", () => {
  it("classifies known first-party tools through the explicit table", () => {
    expect(classifyToolItemType("Task")).toBe("collab_agent_tool_call");
    expect(classifyToolItemType("Workflow")).toBe("collab_agent_tool_call");
    expect(classifyToolItemType("Bash")).toBe("command_execution");
    expect(classifyToolItemType("BashOutput")).toBe("command_execution");
    expect(classifyToolItemType("Edit")).toBe("file_change");
    expect(classifyToolItemType("Write")).toBe("file_change");
    expect(classifyToolItemType("NotebookEdit")).toBe("file_change");
    expect(classifyToolItemType("Read")).toBe("dynamic_tool_call");
    expect(classifyToolItemType("Glob")).toBe("dynamic_tool_call");
    expect(classifyToolItemType("Grep")).toBe("dynamic_tool_call");
    expect(classifyToolItemType("WebSearch")).toBe("web_search");
    expect(classifyToolItemType("WebFetch")).toBe("web_search");
    expect(classifyToolItemType("TodoWrite")).toBe("plan");
  });

  it("falls back to heuristics for tools outside the table", () => {
    expect(classifyToolItemType("mcp__db__query")).toBe("mcp_tool_call");
    expect(classifyToolItemType("run_terminal_command")).toBe("command_execution");
    expect(classifyToolItemType("spawn_subagent")).toBe("collab_agent_tool_call");
    expect(classifyToolItemType("generate_image")).toBe("image_view");
    expect(classifyToolItemType("something_novel")).toBe("dynamic_tool_call");
  });
});

describe("isReadOnlyToolName", () => {
  it("treats read-only first-party tools as read-only", () => {
    expect(isReadOnlyToolName("Read")).toBe(true);
    expect(isReadOnlyToolName("Glob")).toBe(true);
    expect(isReadOnlyToolName("Grep")).toBe(true);
    expect(isReadOnlyToolName("BashOutput")).toBe(true);
  });

  it("does not treat network or mutating first-party tools as read-only", () => {
    expect(isReadOnlyToolName("WebSearch")).toBe(false);
    expect(isReadOnlyToolName("WebFetch")).toBe(false);
    expect(isReadOnlyToolName("Bash")).toBe(false);
    expect(isReadOnlyToolName("Edit")).toBe(false);
    expect(isReadOnlyToolName("Task")).toBe(false);
  });
});

describe("classifyRequestType", () => {
  it("labels read-only tools as file-read approvals", () => {
    expect(classifyRequestType("Read")).toBe("file_read_approval");
    expect(classifyRequestType("Grep")).toBe("file_read_approval");
  });

  it("labels WebSearch as a dynamic tool approval, not a file read", () => {
    expect(classifyRequestType("WebSearch")).toBe("dynamic_tool_call");
    expect(classifyRequestType("WebFetch")).toBe("dynamic_tool_call");
  });

  it("labels command and file-change tools with their dedicated approvals", () => {
    expect(classifyRequestType("Bash")).toBe("command_execution_approval");
    expect(classifyRequestType("Edit")).toBe("file_change_approval");
  });
});
