import { describe, expect, it } from "vitest";

import {
  appendKanbanTaskTranscript,
  buildKanbanTaskPreview,
  truncateKanbanTaskPreview,
} from "./KanbanNewTaskDialog.logic";

describe("KanbanNewTaskDialog logic", () => {
  it("appends voice transcripts without preserving trailing whitespace", () => {
    expect(appendKanbanTaskTranscript("", "  ship it  ")).toBe("ship it");
    expect(appendKanbanTaskTranscript("Draft task  ", "  and test it  ")).toBe(
      "Draft task and test it",
    );
    expect(appendKanbanTaskTranscript("Draft task", "   ")).toBe("Draft task");
  });

  it("builds the same preview fallback order as the dialog", () => {
    expect(
      buildKanbanTaskPreview({
        trimmedPrompt: "Fix reconnect",
        firstImageName: "screen.png",
        assistantSelectionCount: 1,
      }),
    ).toBe("Fix reconnect");
    expect(
      buildKanbanTaskPreview({
        trimmedPrompt: "",
        firstImageName: "screen.png",
        assistantSelectionCount: 1,
      }),
    ).toBe("Image: screen.png");
    expect(
      buildKanbanTaskPreview({
        trimmedPrompt: "",
        firstImageName: null,
        assistantSelectionCount: 1,
      }),
    ).toBe("Referenced assistant selection");
    expect(
      buildKanbanTaskPreview({
        trimmedPrompt: "",
        firstImageName: null,
        assistantSelectionCount: 0,
      }),
    ).toBe("New task");
  });

  it("truncates long previews for toasts", () => {
    expect(truncateKanbanTaskPreview("short", 10)).toBe("short");
    expect(truncateKanbanTaskPreview("abcdefghijkl", 10)).toBe("abcdefghij…");
  });
});
