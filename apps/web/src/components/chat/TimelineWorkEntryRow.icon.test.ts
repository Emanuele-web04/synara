import { describe, expect, it } from "vitest";
import { FileReadIcon, HammerIcon, SearchIcon, TerminalIcon, WebSearchIcon } from "~/lib/icons";
import type { WorkLogEntry } from "~/workLog";
import { workEntryLeftIcon } from "./TimelineWorkEntryRow";

function entry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
  return {
    id: "e1",
    createdAt: "2026-06-05T00:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    ...overrides,
  } as WorkLogEntry;
}

describe("workEntryLeftIcon read/search glyphs", () => {
  it("wears the book for ACP native read names surfaced through toolName", () => {
    for (const toolName of ["read_file", "view", "read_text_file", "hashline_read"]) {
      expect(workEntryLeftIcon(entry({ itemType: "dynamic_tool_call", toolName })), toolName).toBe(
        FileReadIcon,
      );
    }
  });

  it("falls back to the derived title when the ACP call has no native name", () => {
    expect(workEntryLeftIcon(entry({ itemType: "dynamic_tool_call", toolTitle: "Read" }))).toBe(
      FileReadIcon,
    );
    expect(
      workEntryLeftIcon(entry({ itemType: "dynamic_tool_call", toolTitle: "Searching" })),
    ).toBe(SearchIcon);
  });

  it("matches the title's first word for Grok-style read/search titles", () => {
    // Grok sends kind:"read" + title "Read /home/gabriel" without a native name;
    // the first word is the only identity left.
    expect(
      workEntryLeftIcon(entry({ itemType: "dynamic_tool_call", toolTitle: "Read /home/gabriel" })),
    ).toBe(FileReadIcon);
    expect(
      workEntryLeftIcon(entry({ itemType: "dynamic_tool_call", toolTitle: "Find in src" })),
    ).toBe(SearchIcon);
  });

  it("wears the magnifier for native search names across providers", () => {
    for (const toolName of ["grep", "glob", "search", "find", "hashline_grep"]) {
      expect(workEntryLeftIcon(entry({ itemType: "dynamic_tool_call", toolName })), toolName).toBe(
        SearchIcon,
      );
    }
  });

  it("prefers the tool name over the web_search itemType bucket (Pi grep/find)", () => {
    // Pi classifies its native `grep`/`find` as web_search; they are file
    // searches and must wear the magnifier, not the globe.
    expect(workEntryLeftIcon(entry({ itemType: "web_search", toolName: "grep" }))).toBe(SearchIcon);
    expect(
      workEntryLeftIcon(entry({ itemType: "web_search", toolTitle: "Searched the web" })),
    ).toBe(WebSearchIcon);
    expect(workEntryLeftIcon(entry({ itemType: "web_search", toolName: "web_search" }))).toBe(
      WebSearchIcon,
    );
  });

  it("wears the book for structured read actions that carry no command string", () => {
    // Codex commandActions and ACP `read` kinds arrive as command_execution
    // with a derived "Read" title and no shell command.
    expect(workEntryLeftIcon(entry({ itemType: "command_execution", toolTitle: "Read" }))).toBe(
      FileReadIcon,
    );
    expect(workEntryLeftIcon(entry({ itemType: "command_execution", toolTitle: "Searched" }))).toBe(
      SearchIcon,
    );
  });

  it("keeps mutating or unknown tools on the hammer and compound reads on the terminal", () => {
    expect(
      workEntryLeftIcon(entry({ itemType: "dynamic_tool_call", toolName: "write_file" })),
    ).toBe(HammerIcon);
    expect(
      workEntryLeftIcon(
        entry({ itemType: "command_execution", command: "cat a.txt && rm -rf dist" }),
      ),
    ).toBe(TerminalIcon);
  });
});
