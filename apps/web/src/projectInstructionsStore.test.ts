// FILE: projectInstructionsStore.test.ts
// Purpose: Verifies project instructions merge into thread notes without clobbering user text.
// Layer: UI state store test

import { describe, expect, it } from "vitest";

import { mergeProjectInstructionsIntoThreadNotes } from "./projectInstructionsStore";

describe("mergeProjectInstructionsIntoThreadNotes", () => {
  it("leaves notes unchanged when project instructions are empty", () => {
    expect(
      mergeProjectInstructionsIntoThreadNotes({
        threadNotes: "Keep this thread focused on tests.",
        projectInstructions: "   ",
      }),
    ).toBe("Keep this thread focused on tests.");
  });

  it("uses project instructions as notes when the thread notepad is empty", () => {
    expect(
      mergeProjectInstructionsIntoThreadNotes({
        threadNotes: "",
        projectInstructions: "Prefer small focused changes.",
      }),
    ).toBe("Prefer small focused changes.");
  });

  it("appends instructions as a separate block", () => {
    expect(
      mergeProjectInstructionsIntoThreadNotes({
        threadNotes: "Thread-specific note.",
        projectInstructions: "Prefer small focused changes.",
      }),
    ).toBe("Thread-specific note.\n\nPrefer small focused changes.");
  });

  it("does not append an exact instruction block twice", () => {
    const notes = "Thread-specific note.\n\nPrefer small focused changes.";

    expect(
      mergeProjectInstructionsIntoThreadNotes({
        threadNotes: notes,
        projectInstructions: "Prefer small focused changes.",
      }),
    ).toBe(notes);
  });

  it("matches exact instruction blocks across CRLF notes", () => {
    const notes = "Thread-specific note.\r\n\r\nPrefer small focused changes.";

    expect(
      mergeProjectInstructionsIntoThreadNotes({
        threadNotes: notes,
        projectInstructions: "Prefer small focused changes.",
      }),
    ).toBe(notes);
  });

  it("treats punctuation in instructions as literal text", () => {
    const notes = "Thread-specific note.\n\nUse foo.*[bar]? literally.";

    expect(
      mergeProjectInstructionsIntoThreadNotes({
        threadNotes: notes,
        projectInstructions: "Use foo.*[bar]? literally.",
      }),
    ).toBe(notes);
  });

  it("does append when the instructions only appear as a substring", () => {
    expect(
      mergeProjectInstructionsIntoThreadNotes({
        threadNotes: "Thread-specific note: prefer small focused changes when possible.",
        projectInstructions: "prefer small focused changes",
      }),
    ).toBe(
      "Thread-specific note: prefer small focused changes when possible.\n\nprefer small focused changes",
    );
  });
});
