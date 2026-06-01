import { describe, expect, it } from "vitest";

import { capHistoryByLimits, capHistoryBytes, capHistoryLines } from "./terminalHistory";

const HUGE_LINES = 1_000_000;

describe("capHistoryBytes", () => {
  it("returns history unchanged when already under the byte limit", () => {
    const history = "hello world";
    expect(capHistoryBytes(history, 1_024)).toBe(history);
  });

  it("bounds a newline-sparse ANSI flood to ~maxBytes (the runaway-TUI case)", () => {
    // A redrawing TUI repaints via cursor moves with almost no newlines.
    const frame = `\u001b[H\u001b[2K${"x".repeat(200)}`; // no trailing newline
    const history = frame.repeat(5_000); // ~1 MB of bytes, ~0 newlines
    const maxBytes = 16_384;

    const capped = capHistoryBytes(history, maxBytes);

    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(maxBytes);
    // The retained tail is still real output, not empty.
    expect(capped.length).toBeGreaterThan(0);
  });

  it("never splits a multi-byte UTF-8 code point", () => {
    const emoji = "🙂"; // 4 UTF-8 bytes, 2 UTF-16 code units
    const history = `${emoji.repeat(2_000)}`;
    const capped = capHistoryBytes(history, 401); // odd byte budget to force a mid-char cut

    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(401);
    // A clean decode round-trips with no U+FFFD replacement characters.
    expect(capped).not.toContain("\uFFFD");
    expect(Buffer.from(capped, "utf8").toString("utf8")).toBe(capped);
  });

  it("resumes at the start of an ANSI escape sequence when one is in range", () => {
    const styled = `\u001b[31mRED\u001b[0m`;
    const history = `${"a".repeat(100)}${styled.repeat(50)}`;
    const capped = capHistoryBytes(history, 60);

    // The retained text begins with a complete escape sequence, so xterm replay
    // never starts mid-sequence.
    expect(capped.startsWith("\u001b")).toBe(true);
  });

  it("returns empty string for a non-positive byte limit", () => {
    expect(capHistoryBytes("anything", 0)).toBe("");
  });
});

describe("capHistoryLines", () => {
  it("keeps only the last N lines and preserves a trailing newline", () => {
    const history = "l1\nl2\nl3\nl4\n";
    expect(capHistoryLines(history, 2)).toBe("l3\nl4\n");
  });
});

describe("capHistoryByLimits", () => {
  it("applies both the byte ceiling and the line cap", () => {
    const frame = `\u001b[H${"y".repeat(500)}\n`;
    const history = frame.repeat(1_000);
    const capped = capHistoryByLimits(history, { maxLines: 10, maxBytes: 64_000 });

    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(64_000);
    expect(capped.split("\n").filter((line) => line.length > 0).length).toBeLessThanOrEqual(10);
  });
});
