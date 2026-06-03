import { describe, expect, it } from "vitest";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import {
  HANDOFF_CONTEXT_WRAPPER_OVERHEAD,
  buildHandoffBootstrapTextFromImportedMessages,
  calculateAvailableHandoffBootstrapChars,
} from "./handoffContext";

describe("handoffContext", () => {
  it("builds source provider, title, branch, and worktree context", () => {
    const text = buildHandoffBootstrapTextFromImportedMessages({
      sourceProvider: "codex",
      thread: {
        title: "Fix login redirect",
        branch: "feature/login",
        worktreePath: "/repo/.worktrees/login",
      },
      importedMessages: [
        { role: "user", text: "The login page loops." },
        { role: "assistant", text: "I found the redirect condition." },
      ],
    });

    expect(text).toContain("This conversation was handed off from codex.");
    expect(text).toContain("Original conversation title: Fix login redirect");
    expect(text).toContain("Git branch: feature/login");
    expect(text).toContain("Worktree path: /repo/.worktrees/login");
    expect(text).toContain("Most recent imported messages:");
  });

  it("separates earlier message summary from the six most recent messages", () => {
    const text = buildHandoffBootstrapTextFromImportedMessages({
      sourceProvider: "claudeAgent",
      thread: {
        title: "Long handoff",
        branch: null,
        worktreePath: null,
      },
      importedMessages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `message ${index + 1}`,
      })),
    });

    expect(text).toContain("Earlier conversation summary:");
    expect(text).toContain("- User: message 1");
    expect(text).toContain("- Assistant: message 2");
    expect(text).toContain("Most recent imported messages:");
    expect(text).toContain("User:\nmessage 3");
    expect(text).toContain("Assistant:\nmessage 8");
  });

  it("truncates the complete preview under a small budget", () => {
    const text = buildHandoffBootstrapTextFromImportedMessages({
      sourceProvider: "gemini",
      thread: {
        title: "Tiny budget",
        branch: null,
        worktreePath: null,
      },
      importedMessages: [{ role: "user", text: "x".repeat(200) }],
      maxChars: 80,
    });

    expect(text).toHaveLength(80);
    expect(text?.endsWith("...")).toBe(true);
  });

  it("calculates handoff budget with the runtime wrapper overhead", () => {
    expect(calculateAvailableHandoffBootstrapChars("hello")).toBe(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS - "hello".length - HANDOFF_CONTEXT_WRAPPER_OVERHEAD,
    );
    expect(calculateAvailableHandoffBootstrapChars("x".repeat(200_000))).toBe(0);
  });
});
