import { describe, expect, it } from "vitest";

import {
  consumeTerminalThreadTitleInput,
  deriveTerminalThreadTitleFromCommand,
  isGenericTerminalThreadTitle,
} from "./terminalThreadTitle";
import { TerminalThreadTitleTracker } from "./terminalThreadTitleTracker";

describe("terminalThreadTitle", () => {
  it("recognizes the generic terminal placeholder title", () => {
    expect(isGenericTerminalThreadTitle("New terminal")).toBe(true);
    expect(isGenericTerminalThreadTitle("git push")).toBe(false);
  });

  it("derives CLI-focused labels from submitted commands", () => {
    expect(deriveTerminalThreadTitleFromCommand("codex --model gpt-5.4")).toBe("Codex CLI");
    expect(deriveTerminalThreadTitleFromCommand("claude code")).toBe("Claude Code");
    expect(deriveTerminalThreadTitleFromCommand("git push origin main")).toBe("git push");
    expect(deriveTerminalThreadTitleFromCommand("npm run dev -- --token secret")).toBe(
      "npm run dev",
    );
  });

  it("drops blank and low-signal shell commands", () => {
    expect(deriveTerminalThreadTitleFromCommand("   ")).toBeNull();
    expect(deriveTerminalThreadTitleFromCommand("cd /repo/project")).toBeNull();
  });

  it("buffers terminal input until Enter and emits a sanitized title once submitted", () => {
    const firstChunk = consumeTerminalThreadTitleInput("", "git pu");
    expect(firstChunk).toEqual({ buffer: "git pu", title: null });

    const secondChunk = consumeTerminalThreadTitleInput(firstChunk.buffer, "sh origin main\r");
    expect(secondChunk).toEqual({ buffer: "", title: "git push" });
  });

  it("only emits tracked titles while the thread still has the generic placeholder", () => {
    const tracker = new TerminalThreadTitleTracker();

    expect(
      tracker.consumeWrite({
        currentTitle: "New terminal",
        data: "codex --model gpt-5.4\r",
        terminalId: "default",
        threadId: "thread-1",
      }),
    ).toBe("Codex CLI");
    expect(
      tracker.consumeWrite({
        currentTitle: "Manual rename",
        data: "git push origin main\r",
        terminalId: "default",
        threadId: "thread-1",
      }),
    ).toBeNull();
  });
});
