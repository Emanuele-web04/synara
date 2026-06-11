import { describe, expect, it } from "vitest";

import {
  appendKanbanTaskTranscript,
  areKanbanTaskTerminalContextIdsEqual,
  buildKanbanTaskPreview,
  syncKanbanTaskTerminalContextsByIds,
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

  it("syncs terminal contexts to editor ids while dropping missing ones", () => {
    const first = { id: "first", text: "one" };
    const second = { id: "second", text: "two" };

    expect(syncKanbanTaskTerminalContextsByIds([first, second], ["second", "missing"])).toEqual([
      second,
    ]);
  });

  it("compares terminal context ids in order", () => {
    const contexts = [{ id: "first" }, { id: "second" }];

    expect(areKanbanTaskTerminalContextIdsEqual(contexts, ["first", "second"])).toBe(true);
    expect(areKanbanTaskTerminalContextIdsEqual(contexts, ["second", "first"])).toBe(false);
    expect(areKanbanTaskTerminalContextIdsEqual(contexts, ["first"])).toBe(false);
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
