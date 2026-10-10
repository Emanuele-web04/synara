import { describe, expect, it } from "vitest";

import {
  buildInlineTerminalContextText,
  resolveUserMessageMarkdownText,
} from "./userMessageTerminalContexts";

describe("userMessageTerminalContexts", () => {
  it("builds plain inline terminal text labels", () => {
    expect(
      buildInlineTerminalContextText([
        { header: "Terminal 1 lines 12-13" },
        { header: "Terminal 2 line 4" },
      ]),
    ).toBe("@terminal-1:12-13 @terminal-2:4");
  });

  it("prefixes visible user text with terminal labels when they are not already inline", () => {
    expect(
      resolveUserMessageMarkdownText("Investigate this", [{ header: "Terminal 1 lines 12-13" }]),
    ).toBe("@terminal-1:12-13 Investigate this");
    expect(
      resolveUserMessageMarkdownText("yo @terminal-1:12-13 whats up", [
        { header: "Terminal 1 lines 12-13" },
      ]),
    ).toBe("yo @terminal-1:12-13 whats up");
  });
});
