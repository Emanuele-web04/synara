import { describe, expect, it } from "vitest";

import { mapWorkLogToActionState, actionColorFor } from "~/lib/actionStates";
import { classifyWorkEntry, isFileReadToolEntry } from "~/lib/workEntryClassification";
import type { WorkLogEntry } from "~/session-logic";

function makeEntry(
  overrides: Partial<WorkLogEntry> & Pick<WorkLogEntry, "label" | "tone">,
): WorkLogEntry {
  return {
    id: "test-id",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as WorkLogEntry;
}

describe("classifyWorkEntry", () => {
  it("classifies command requestKind as running-command", () => {
    const entry = makeEntry({ label: "rm -rf", tone: "tool", requestKind: "command" });
    expect(classifyWorkEntry(entry)).toBe("running-command");
  });

  it("classifies file-read requestKind as reading", () => {
    const entry = makeEntry({ label: "read foo", tone: "tool", requestKind: "file-read" });
    expect(classifyWorkEntry(entry)).toBe("reading");
  });

  it("classifies file-change requestKind as editing", () => {
    const entry = makeEntry({ label: "edit foo", tone: "tool", requestKind: "file-change" });
    expect(classifyWorkEntry(entry)).toBe("editing");
  });

  it("classifies file_change itemType as editing", () => {
    const entry = makeEntry({ label: "edit foo", tone: "tool", itemType: "file_change" });
    expect(classifyWorkEntry(entry)).toBe("editing");
  });

  it("classifies command_execution itemType as running-command", () => {
    const entry = makeEntry({ label: "run cmd", tone: "tool", itemType: "command_execution" });
    expect(classifyWorkEntry(entry)).toBe("running-command");
  });

  it("classifies read toolName as reading", () => {
    const entry = makeEntry({ label: "Read", tone: "tool", toolName: "read" });
    expect(classifyWorkEntry(entry)).toBe("reading");
  });

  it("classifies readFile toolName as reading", () => {
    const entry = makeEntry({ label: "ReadFile", tone: "tool", toolName: "read_file" });
    expect(classifyWorkEntry(entry)).toBe("reading");
  });

  it("classifies viewFile toolName as reading", () => {
    const entry = makeEntry({ label: "ViewFile", tone: "tool", toolName: "view_file" });
    expect(classifyWorkEntry(entry)).toBe("reading");
  });

  it("classifies error tone as error when no specific type matches", () => {
    const entry = makeEntry({ label: "failed", tone: "error" });
    expect(classifyWorkEntry(entry)).toBe("error");
  });

  it("classifies error tone command as running-command (activity takes precedence)", () => {
    const entry = makeEntry({ label: "failed cmd", tone: "error", requestKind: "command" });
    expect(classifyWorkEntry(entry)).toBe("running-command");
  });

  it("defaults to thinking for unmatched entries", () => {
    const entry = makeEntry({ label: "web search", tone: "tool", itemType: "web_search" });
    expect(classifyWorkEntry(entry)).toBe("thinking");
  });

  it("defaults to thinking for info tone", () => {
    const entry = makeEntry({ label: "completed", tone: "info" });
    expect(classifyWorkEntry(entry)).toBe("thinking");
  });
});

describe("isFileReadToolEntry", () => {
  it("matches read toolName", () => {
    expect(isFileReadToolEntry({ toolName: "read" })).toBe(true);
  });

  it("matches readFile with underscore", () => {
    expect(isFileReadToolEntry({ toolName: "read_file" })).toBe(true);
  });

  it("matches viewFile case-insensitively", () => {
    expect(isFileReadToolEntry({ toolName: "ViewFile" })).toBe(true);
  });

  it("does not match unrelated tools", () => {
    expect(isFileReadToolEntry({ toolName: "write" })).toBe(false);
  });

  it("handles undefined toolName", () => {
    expect(isFileReadToolEntry({} as Pick<WorkLogEntry, "toolName">)).toBe(false);
  });
});

describe("mapWorkLogToActionState", () => {
  it("maps thinking category to processing compact state", () => {
    const entry = makeEntry({ label: "thinking...", tone: "thinking" });
    const state = mapWorkLogToActionState(entry);
    expect(state.compactState).toBe("processing");
    expect(state.state).toBe("thinking");
  });

  it("maps reading category to processing compact state (merged with thinking)", () => {
    const entry = makeEntry({ label: "reading", tone: "tool", requestKind: "file-read" });
    const state = mapWorkLogToActionState(entry);
    expect(state.compactState).toBe("processing");
    expect(state.state).toBe("reading");
  });

  it("maps editing category to editing compact state", () => {
    const entry = makeEntry({ label: "editing", tone: "tool", requestKind: "file-change" });
    const state = mapWorkLogToActionState(entry);
    expect(state.compactState).toBe("editing");
    expect(state.state).toBe("editing");
  });

  it("maps running-command to running-command compact state", () => {
    const entry = makeEntry({ label: "cmd", tone: "tool", requestKind: "command" });
    const state = mapWorkLogToActionState(entry);
    expect(state.compactState).toBe("running-command");
    expect(state.state).toBe("running-command");
  });

  it("sanitizes labels by truncating to 80 chars", () => {
    const longLabel = "a".repeat(100);
    const entry = makeEntry({ label: longLabel, tone: "thinking" });
    const state = mapWorkLogToActionState(entry);
    expect(state.label.length).toBe(80);
    expect(state.label.endsWith("...")).toBe(true);
  });

  it("strips control characters from labels", () => {
    const entry = makeEntry({
      label: "hello\u200Bworld\u202E",
      tone: "thinking",
    });
    const state = mapWorkLogToActionState(entry);
    expect(state.label).toBe("helloworld");
  });

  it("uses synara preset colors by default", () => {
    const entry = makeEntry({ label: "test", tone: "thinking" });
    const state = mapWorkLogToActionState(entry);
    expect(state.color).toBe("var(--accent)");
  });

  it("uses spectrum preset colors when specified", () => {
    const entry = makeEntry({ label: "test", tone: "thinking" });
    const state = mapWorkLogToActionState(entry, "spectrum");
    expect(state.color).toBe("#a855f7");
  });

  it("uses mono preset colors when specified", () => {
    const entry = makeEntry({ label: "test", tone: "error" });
    const state = mapWorkLogToActionState(entry, "mono");
    expect(state.color).toBe("var(--destructive)");
  });
});

describe("actionColorFor", () => {
  it("returns the color for a state and preset", () => {
    expect(actionColorFor("error", "synara")).toBe("var(--destructive)");
    expect(actionColorFor("thinking", "spectrum")).toBe("#a855f7");
  });
});
