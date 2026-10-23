import { CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  appendAssistantSelectionsToPrompt,
  createAssistantSelectionAttachment,
  extractTrailingAssistantSelections,
  mergeAssistantSelectionComments,
  stripEmbeddedAssistantSelections,
} from "./assistantSelections";
import { appendPastedTextsToPrompt, createPastedTextDraft } from "./composerPastedText";

describe("assistantSelections", () => {
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
      extractTrailingAssistantSelections(
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
      ).promptText,
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

  it("strips assistant selections while preserving trailing pasted text blocks", () => {
    const prompt = appendPastedTextsToPrompt(
      appendAssistantSelectionsToPrompt("Investigate this", [
        {
          assistantMessageId: "msg-1",
          text: "selected line",
        },
      ]),
      [
        createPastedTextDraft({
          id: "paste-1",
          createdAt: "2026-06-15T00:00:00.000Z",
          text: "large pasted text",
        }),
      ],
    );

    expect(stripEmbeddedAssistantSelections(prompt)).toBe(
      appendPastedTextsToPrompt("Investigate this", [
        createPastedTextDraft({
          id: "paste-1",
          createdAt: "2026-06-15T00:00:00.000Z",
          text: "large pasted text",
        }),
      ]),
    );
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

  it("round-trips a comment next to its quote", () => {
    const prompt = appendAssistantSelectionsToPrompt("Review", [
      {
        assistantMessageId: "msg-1",
        text: "first quote\n- comment:",
        comment: " Too vague\r\nRewrite ",
      },
      { assistantMessageId: "msg-2", text: "second quote" },
    ]);
    expect(prompt).toBe(
      [
        "Review",
        "",
        "<assistant_selection>",
        "- assistant message msg-1:",
        "  first quote",
        "  - comment:",
        "- comment:",
        "  Too vague",
        "  Rewrite",
        "- assistant message msg-2:",
        "  second quote",
        "</assistant_selection>",
      ].join("\n"),
    );
    expect(extractTrailingAssistantSelections(prompt)).toEqual({
      promptText: "Review",
      selections: [
        {
          assistantMessageId: "msg-1",
          text: "first quote\n- comment:",
          comment: "Too vague\nRewrite",
        },
        { assistantMessageId: "msg-2", text: "second quote" },
      ],
    });
  });

  it("drops blank comments", () => {
    expect(
      createAssistantSelectionAttachment({
        assistantMessageId: "msg-1",
        text: "quote",
        comment: "  ",
      }),
    ).not.toHaveProperty("comment");
  });

  it("pairs parsed comments back onto server attachments", () => {
    const attachments = [
      { type: "assistant-selection" as const, id: "a", assistantMessageId: "msg-1", text: "same" },
      { type: "assistant-selection" as const, id: "b", assistantMessageId: "msg-1", text: "same" },
      { type: "assistant-selection" as const, id: "c", assistantMessageId: "msg-2", text: "other" },
    ];
    expect(
      mergeAssistantSelectionComments(attachments, [
        { assistantMessageId: "msg-1", text: "same", comment: "one" },
        { assistantMessageId: "msg-1", text: "same", comment: "two" },
        { assistantMessageId: "msg-2", text: "other" },
      ]).map((attachment) => attachment.comment),
    ).toEqual(["one", "two", undefined]);
  });
});
