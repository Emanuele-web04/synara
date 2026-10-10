import type { PinnedMessage } from "@synara/contracts";
import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { addPin, derivePinLabel, displayLabelFor, restorePinAtIndex } from "./pinnedMessages";

const m = (id: string): MessageId => MessageId.makeUnsafe(id);

const pin = (id: string, overrides: Partial<PinnedMessage> = {}): PinnedMessage => ({
  messageId: m(id),
  label: null,
  done: false,
  pinnedAt: "2026-06-06T00:00:00.000Z",
  ...overrides,
});

describe("derivePinLabel", () => {
  it("uses the first non-empty line", () => {
    expect(derivePinLabel("\n\nFirst real line\nSecond line")).toBe("First real line");
  });

  it("strips leading block markers (headings, bullets, quotes, ordered lists)", () => {
    expect(derivePinLabel("## Heading text")).toBe("Heading text");
    expect(derivePinLabel("- bullet item")).toBe("bullet item");
    expect(derivePinLabel("> quoted line")).toBe("quoted line");
    expect(derivePinLabel("3) numbered item")).toBe("numbered item");
  });

  it("removes inline emphasis markers and collapses whitespace", () => {
    expect(derivePinLabel("**bold**  and  `code`")).toBe("bold and code");
  });

  it("normalizes CRLF line endings", () => {
    expect(derivePinLabel("\r\nWindows line\r\nnext")).toBe("Windows line");
  });

  it("truncates over-long labels with an ellipsis", () => {
    const long = "a".repeat(80);
    const result = derivePinLabel(long);
    expect(result).toHaveLength(60);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns an empty string when there is no usable text", () => {
    expect(derivePinLabel("")).toBe("");
    expect(derivePinLabel("   \n\n  ")).toBe("");
    expect(derivePinLabel("***")).toBe("");
  });
});

describe("displayLabelFor", () => {
  it("prefers an explicit (trimmed) override over the message text", () => {
    expect(displayLabelFor(pin("a", { label: "  Custom  " }), "Derived from text")).toBe("Custom");
  });

  it("falls back to the derived label when there is no override", () => {
    expect(displayLabelFor(pin("a"), "# Derived heading")).toBe("Derived heading");
  });

  it("returns an empty string when the message text is unavailable and there is no override", () => {
    expect(displayLabelFor(pin("a"), undefined)).toBe("");
  });
});

describe("addPin", () => {
  it("appends a new pin to the end", () => {
    const result = addPin([pin("a")], m("b"), "2026-06-06T01:00:00.000Z");
    expect(result.map((p) => p.messageId)).toEqual([m("a"), m("b")]);
    expect(result[1]).toMatchObject({ messageId: m("b"), label: null, done: false });
  });
});

describe("restorePinAtIndex", () => {
  it("restores a removed pin at its original position", () => {
    const removed = pin("b");
    expect(restorePinAtIndex([pin("a"), pin("c")], removed, 1).map((p) => p.messageId)).toEqual([
      m("a"),
      m("b"),
      m("c"),
    ]);
  });

  it("does not duplicate a pin that is already present", () => {
    const pins = [pin("a"), pin("b")];
    expect(restorePinAtIndex(pins, pins[1]!, 0)).toBe(pins);
  });
});
