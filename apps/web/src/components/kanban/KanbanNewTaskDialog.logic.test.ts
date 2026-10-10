import { describe, expect, it } from "vitest";

import { appendKanbanTaskTranscript, truncateKanbanTaskPreview } from "./KanbanNewTaskDialog.logic";

describe("KanbanNewTaskDialog logic", () => {
  it("appends voice transcripts without preserving trailing whitespace", () => {
    expect(appendKanbanTaskTranscript("", "  ship it  ")).toBe("ship it");
    expect(appendKanbanTaskTranscript("Draft task  ", "  and test it  ")).toBe(
      "Draft task and test it",
    );
    expect(appendKanbanTaskTranscript("Draft task", "   ")).toBe("Draft task");
  });

  it("truncates long previews for toasts", () => {
    expect(truncateKanbanTaskPreview("short", 10)).toBe("short");
    expect(truncateKanbanTaskPreview("abcdefghijkl", 10)).toBe("abcdefghij…");
  });
});
