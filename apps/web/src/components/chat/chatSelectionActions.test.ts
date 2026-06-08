import { describe, expect, it } from "vitest";

import { resolveTranscriptMarkerRange } from "./chatSelectionActions";

describe("chatSelectionActions", () => {
  it("resolves an exact unique transcript selection to raw message offsets", () => {
    expect(
      resolveTranscriptMarkerRange({
        messageText: "hello important text today",
        selectedText: "important text",
      }),
    ).toEqual({ startOffset: 6, endOffset: 20 });
  });

  it("rejects missing or ambiguous marker selections", () => {
    expect(
      resolveTranscriptMarkerRange({
        messageText: "hello important text and important text again",
        selectedText: "important text",
      }),
    ).toBeNull();
    expect(
      resolveTranscriptMarkerRange({
        messageText: "hello important text today",
        selectedText: "missing text",
      }),
    ).toBeNull();
  });

  it("resolves rendered selections whose whitespace differs from raw markdown", () => {
    const messageText = "Ho letto tutto il progetto.\n\nL'app è bella e curata: UI dark coerente.";

    expect(
      resolveTranscriptMarkerRange({
        messageText,
        selectedText: "Ho letto tutto il progetto.\nL'app è bella e curata:",
      }),
    ).toEqual({
      startOffset: 0,
      endOffset: "Ho letto tutto il progetto.\n\nL'app è bella e curata:".length,
    });
  });

  it("resolves rendered selections with non-breaking spaces", () => {
    expect(
      resolveTranscriptMarkerRange({
        messageText: "L'app è bella e curata: UI dark coerente.",
        selectedText: "L'app\u00a0è bella e curata:",
      }),
    ).toEqual({
      startOffset: 0,
      endOffset: "L'app è bella e curata:".length,
    });
  });

  it("resolves rendered selections across inline markdown delimiters", () => {
    const messageText =
      "**Ho letto tutto il progetto.**\n\n**L'app è bella e curata:** UI dark coerente.";

    expect(
      resolveTranscriptMarkerRange({
        messageText,
        selectedText: "Ho letto tutto il progetto.\nL'app è bella e curata:",
      }),
    ).toEqual({
      startOffset: messageText.indexOf("Ho letto"),
      endOffset: messageText.indexOf(":** UI") + 1,
    });
  });

  it("keeps normalized selections ambiguous when they match multiple raw ranges", () => {
    expect(
      resolveTranscriptMarkerRange({
        messageText: "alpha\nbeta and alpha beta again",
        selectedText: "alpha\u00a0beta",
      }),
    ).toBeNull();
  });
});
