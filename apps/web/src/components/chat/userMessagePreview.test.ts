import { describe, expect, it } from "vitest";

import {
  COLLAPSED_USER_MESSAGE_MAX_CHARS,
  deriveUserMessagePreviewState,
} from "./userMessagePreview";

describe("userMessagePreview", () => {
  it("keeps short user messages untouched", () => {
    expect(deriveUserMessagePreviewState("short message")).toEqual({
      text: "short message",
      collapsible: false,
      truncated: false,
    });
  });

  it("truncates collapsed user messages to the message-only 600-char budget", () => {
    const text = `${"a".repeat(COLLAPSED_USER_MESSAGE_MAX_CHARS)}tail`;

    expect(deriveUserMessagePreviewState(text)).toEqual({
      text: `${"a".repeat(COLLAPSED_USER_MESSAGE_MAX_CHARS)}…`,
      collapsible: true,
      truncated: true,
    });
  });

  it("returns the full text again once the message is expanded", () => {
    const text = `${"a".repeat(COLLAPSED_USER_MESSAGE_MAX_CHARS)}tail`;

    expect(deriveUserMessagePreviewState(text, { expanded: true })).toEqual({
      text,
      collapsible: true,
      truncated: false,
    });
  });
});
