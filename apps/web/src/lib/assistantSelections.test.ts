import { CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  appendAssistantSelectionsToPrompt,
  createAssistantSelectionAttachment,
  extractTrailingAssistantSelections,
  formatAssistantSelectionPreview,
  formatAssistantSelectionQueuePreview,
  formatAssistantSelectionTitleSeed,
  stripEmbeddedAssistantSelections,
  stripTrailingAssistantSelections,
} from "./assistantSelections";

describe("assistantSelections", () => {
  it("appends a trailing assistant selection block", () => {
    expect(
      appendAssistantSelectionsToPrompt("Investigate this", [
        {
          assistantMessageId: "msg-1",
          text: "selected line",
        },
      ]),
    ).toBe(
      "Investigate this\n\n<assistant_selection>\n- assistant message msg-1:\n  selected line\n</assistant_selection>",
    );
  });

  it("extracts trailing assistant selection blocks from prompts", () => {
    expect(
      extractTrailingAssistantSelections(
        "Investigate this\n\n<assistant_selection>\n- assistant message msg-1:\n  selected line\n</assistant_selection>",
      ),
    ).toEqual({
      promptText: "Investigate this",
      selections: [{ assistantMessageId: "msg-1", text: "selected line" }],
    });
  });

  it("strips only trailing assistant selection blocks", () => {
    expect(
      stripTrailingAssistantSelections(
        [
          "Investigate this",
          "",
          "<assistant_selection>",
          "- assistant message msg-1:",
          "  selected line",
          "</assistant_selection>",
          "",
          "<terminal_context>",
          "- Terminal 1 lines 12-13:",
          "  12 | git status",
          "</terminal_context>",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Investigate this",
        "",
        "<assistant_selection>",
        "- assistant message msg-1:",
        "  selected line",
        "</assistant_selection>",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("strips assistant selection blocks while preserving trailing terminal context blocks", () => {
    expect(
      stripEmbeddedAssistantSelections(
        [
          "Investigate this",
          "",
          "<assistant_selection>",
          "- assistant message msg-1:",
          "  selected line",
          "</assistant_selection>",
          "",
          "<terminal_context>",
          "- Terminal 1 lines 12-13:",
          "  12 | git status",
          "</terminal_context>",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Investigate this",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("formats compact chip previews", () => {
    expect(
      formatAssistantSelectionPreview(
        "This is a fairly long first line that should be trimmed for the chip label",
      ),
    ).toBe("This is a fairly long first line that shoul…");
  });

  it("creates normalized assistant selection attachments", () => {
    expect(
      createAssistantSelectionAttachment({
        assistantMessageId: " msg-1 ",
        text: "\nselected line\n",
      }),
    ).toMatchObject({
      type: "assistant-selection",
      assistantMessageId: "msg-1",
      text: "selected line",
    });
  });

  it("rejects assistant selections that exceed the max length", () => {
    expect(
      createAssistantSelectionAttachment({
        assistantMessageId: "msg-1",
        text: "x".repeat(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS + 1),
      }),
    ).toBeNull();
  });

  it("formats shared assistant selection labels", () => {
    expect(formatAssistantSelectionQueuePreview(1)).toBe("1 referenced selection");
    expect(formatAssistantSelectionQueuePreview(2)).toBe("Referenced selections");
    expect(formatAssistantSelectionTitleSeed(1)).toBe("Referenced assistant selection");
    expect(formatAssistantSelectionTitleSeed(2)).toBe("Referenced assistant selections");
  });
});
