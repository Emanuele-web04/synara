// FILE: ChatHeader.test.ts
// Purpose: Covers chat header presentation helpers that choose thread identity chrome.
// Layer: Component unit tests
// Depends on: ChatHeader pure helpers and Vitest assertions.

import { describe, expect, it } from "vitest";

import {
  resolveChatHeaderContinuationTooltip,
  resolveChatHeaderContinuationSummary,
  resolveChatHeaderThreadIconKind,
} from "./ChatHeader";

describe("resolveChatHeaderThreadIconKind", () => {
  it("uses the terminal icon for terminal-first threads", () => {
    expect(resolveChatHeaderThreadIconKind("terminal", "New terminal")).toBe("terminal");
  });

  it("keeps provider branding for chat-first threads", () => {
    expect(resolveChatHeaderThreadIconKind("chat", "Fix auth flow")).toBe("provider");
  });

  it("hides provider branding for untouched new chat threads", () => {
    expect(resolveChatHeaderThreadIconKind("chat", "New thread")).toBe("none");
  });
});

describe("resolveChatHeaderContinuationSummary", () => {
  it("selects the first outgoing handoff link as primary", () => {
    const summary = resolveChatHeaderContinuationSummary([
      { threadId: "thread-latest" as never, provider: "claudeAgent" },
      { threadId: "thread-older" as never, provider: "gemini" },
    ]);

    expect(summary).toEqual({
      primary: { threadId: "thread-latest", provider: "claudeAgent" },
      overflowCount: 1,
    });
  });

  it("returns no primary link when a thread has no continuations", () => {
    expect(resolveChatHeaderContinuationSummary([])).toEqual({
      primary: null,
      overflowCount: 0,
    });
  });

  it("describes continuation overflow for compact header tooltips", () => {
    expect(
      resolveChatHeaderContinuationTooltip({
        primary: { provider: "claudeAgent" },
        overflowCount: 2,
      }),
    ).toBe("Continued with Claude; 2 more continuations");
    expect(
      resolveChatHeaderContinuationTooltip({
        primary: { provider: "gemini" },
        overflowCount: 0,
      }),
    ).toBe("Continued with Gemini");
    expect(resolveChatHeaderContinuationTooltip({ primary: null, overflowCount: 0 })).toBeNull();
  });
});
