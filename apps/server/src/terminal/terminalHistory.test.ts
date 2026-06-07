import { describe, expect, it } from "vitest";

import {
  capHistoryByLimits,
  capHistoryBytes,
  capHistoryLines,
  TerminalHistoryBuffer,
  type HistoryLimits,
} from "./terminalHistory";

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

describe("TerminalHistoryBuffer", () => {
  const ESC = String.fromCharCode(0x1b);

  /** Reference: eager per-chunk capping, the behavior the buffer must reproduce. */
  function eagerCap(chunks: string[], limits: HistoryLimits): string {
    let history = "";
    for (const chunk of chunks) {
      history = capHistoryByLimits(`${history}${chunk}`, limits);
    }
    return history;
  }

  it("returns content unchanged while under both caps", () => {
    const buffer = new TerminalHistoryBuffer({ maxLines: 1_000, maxBytes: 1_000 });
    buffer.append("hello ");
    buffer.append("world\n");
    expect(buffer.toString()).toBe("hello world\n");
    expect(buffer.isEmpty).toBe(false);
  });

  it("starts empty and reports isEmpty", () => {
    const buffer = new TerminalHistoryBuffer({ maxLines: 10, maxBytes: 10 });
    expect(buffer.isEmpty).toBe(true);
    expect(buffer.toString()).toBe("");
  });

  it("fromString round-trips content under the caps", () => {
    const buffer = TerminalHistoryBuffer.fromString("seed\ntext\n", {
      maxLines: 10,
      maxBytes: 100,
    });
    expect(buffer.toString()).toBe("seed\ntext\n");
  });

  it("reset() clears all content", () => {
    const buffer = TerminalHistoryBuffer.fromString("data", { maxLines: 10, maxBytes: 100 });
    buffer.reset();
    expect(buffer.isEmpty).toBe(true);
    expect(buffer.toString()).toBe("");
  });

  it("matches eager per-chunk capping for a newline-heavy stream over the line cap", () => {
    const limits: HistoryLimits = { maxLines: 50, maxBytes: 1_048_576 };
    const chunks = Array.from({ length: 400 }, (_, index) => `line-${index}\n`);

    const buffer = new TerminalHistoryBuffer(limits);
    for (const chunk of chunks) buffer.append(chunk);

    expect(buffer.toString()).toBe(eagerCap(chunks, limits));
  });

  it("matches eager per-chunk capping for a byte-bound ANSI redraw stream", () => {
    const limits: HistoryLimits = { maxLines: 5_000, maxBytes: 16_384 };
    // Cursor-move redraws with almost no newlines: byte cap dominates.
    const chunks = Array.from({ length: 500 }, () => `${ESC}[H${ESC}[2K${"x".repeat(200)}`);

    const buffer = new TerminalHistoryBuffer(limits);
    for (const chunk of chunks) buffer.append(chunk);

    const result = buffer.toString();
    expect(result).toBe(eagerCap(chunks, limits));
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(limits.maxBytes);
  });

  it("matches eager capping when both caps bind and chunk sizes vary", () => {
    const limits: HistoryLimits = { maxLines: 30, maxBytes: 4_096 };
    const chunks: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const width = 10 + (index % 7) * 40;
      chunks.push(`${"=".repeat(width)}${index % 3 === 0 ? "\n" : ""}`);
    }

    const buffer = new TerminalHistoryBuffer(limits);
    for (const chunk of chunks) buffer.append(chunk);

    expect(buffer.toString()).toBe(eagerCap(chunks, limits));
  });

  it("keeps the retained byte footprint bounded regardless of total output", () => {
    const limits: HistoryLimits = { maxLines: 5_000, maxBytes: 65_536 };
    const buffer = new TerminalHistoryBuffer(limits);
    for (let index = 0; index < 2_000; index += 1) {
      buffer.append(`${"y".repeat(1_000)}\n`); // ~2 MB streamed total
    }
    expect(Buffer.byteLength(buffer.toString(), "utf8")).toBeLessThanOrEqual(limits.maxBytes);
  });

  it("never splits a multi-byte code point across the cap boundary", () => {
    const limits: HistoryLimits = { maxLines: 5_000, maxBytes: 401 };
    const buffer = new TerminalHistoryBuffer(limits);
    for (let index = 0; index < 1_000; index += 1) buffer.append("🙂");
    const result = buffer.toString();
    expect(result).not.toContain("�");
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  });

  it("interleaves appends and reads without changing the result", () => {
    const limits: HistoryLimits = { maxLines: 40, maxBytes: 8_192 };
    const chunks = Array.from({ length: 200 }, (_, index) => `row ${index} ${"#".repeat(60)}\n`);

    const interleaved = new TerminalHistoryBuffer(limits);
    const readOnce = new TerminalHistoryBuffer(limits);
    for (const chunk of chunks) {
      interleaved.append(chunk);
      // Force a materialize+compact between appends.
      interleaved.toString();
      readOnce.append(chunk);
    }

    expect(interleaved.toString()).toBe(readOnce.toString());
    expect(readOnce.toString()).toBe(eagerCap(chunks, limits));
  });
});
