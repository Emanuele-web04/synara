import { describe, expect, it } from "vitest";
import { deriveReadableToolTitle, normalizeCompactToolLabel } from "./toolCallLabel";

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording", () => {
    expect(normalizeCompactToolLabel("Tool call completed")).toBe("Tool call");
    expect(normalizeCompactToolLabel("Ran command done")).toBe("Ran command");
  });
});

describe("deriveReadableToolTitle", () => {
  it("humanizes search commands even when wrapped in shell -lc", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        requestKind: "command",
        command: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
      }),
    ).toBe("Search files");
  });

  it("humanizes file read commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "sed -n '520,550p' apps/web/src/session-logic.ts",
      }),
    ).toBe("Read file");
  });

  it("humanizes git status commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "git status --short",
      }),
    ).toBe("Check git status");
  });

  it("keeps explicit non-generic titles", () => {
    expect(
      deriveReadableToolTitle({
        title: "Bash",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "echo hello",
      }),
    ).toBe("Bash");
  });

  it("extracts a descriptor from payload when the title is generic", () => {
    expect(
      deriveReadableToolTitle({
        title: "Tool call",
        fallbackLabel: "Tool call",
        itemType: "dynamic_tool_call",
        payload: {
          data: {
            item: {
              toolName: "mcp__xcodebuildmcp__list_sims",
            },
          },
        },
      }),
    ).toBe("mcp xcodebuildmcp list sims");
  });
});
