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
});
