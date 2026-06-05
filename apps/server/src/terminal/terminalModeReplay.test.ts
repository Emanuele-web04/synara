import { describe, expect, it } from "vitest";

import { createTerminalModeReplayTracker } from "./terminalModeReplay";

function withTracker<T>(
  test: (tracker: ReturnType<typeof createTerminalModeReplayTracker>) => T,
): T {
  const tracker = createTerminalModeReplayTracker(120, 32);
  try {
    return test(tracker);
  } finally {
    tracker.dispose();
  }
}

describe("createTerminalModeReplayTracker", () => {
  it("returns no preamble for default terminal modes", () => {
    withTracker((tracker) => {
      expect(tracker.buildPreamble()).toBe("");
    });
  });

  it("tracks kitty keyboard mode independently of scrollback size", () => {
    withTracker((tracker) => {
      tracker.feed("\u001b[>7u");

      const filler = "x".repeat(2048);
      for (let index = 0; index < 100; index += 1) {
        tracker.feed(filler);
      }

      expect(tracker.buildPreamble()).toBe("\u001b[=7;1u");
    });
  });

  it("drops kitty keyboard mode after explicit pop or zero-set", () => {
    withTracker((tracker) => {
      tracker.feed("\u001b[>7u");
      expect(tracker.buildPreamble()).toBe("\u001b[=7;1u");

      tracker.feed("\u001b[<u");
      expect(tracker.buildPreamble()).toBe("");

      tracker.feed("\u001b[>7u");
      tracker.feed("\u001b[=0;1u");
      expect(tracker.buildPreamble()).toBe("");
    });
  });

  it("tracks bracketed paste, focus reporting, mouse tracking, and cursor visibility", () => {
    withTracker((tracker) => {
      tracker.feed("\u001b[?2004h\u001b[?1004h\u001b[?1002h\u001b[?25l");

      const preamble = tracker.buildPreamble();
      expect(preamble).toContain("\u001b[?2004h");
      expect(preamble).toContain("\u001b[?1004h");
      expect(preamble).toContain("\u001b[?1002h");
      expect(preamble).toContain("\u001b[?25l");

      tracker.feed("\u001b[?2004l");
      expect(tracker.buildPreamble()).not.toContain("?2004");
    });
  });

  it("preserves mode state across resizes and split escape feeds", () => {
    withTracker((tracker) => {
      tracker.feed("\u001b[");
      tracker.feed(">7");
      tracker.feed("u");
      tracker.resize(80, 24);
      tracker.resize(80, 24);
      tracker.resize(160, 48);

      expect(tracker.buildPreamble()).toBe("\u001b[=7;1u");
    });
  });
});
