// FILE: ChatHeader.test.ts
// Purpose: Covers chat header presentation helpers that choose thread identity chrome.
// Layer: Component unit tests
// Depends on: ChatHeader pure helpers and Vitest assertions.

import { describe, expect, it } from "vitest";

import { resolveChatHeaderThreadIconKind } from "./ChatHeader";
import {
  describeProviderHandoffTrail,
  resolveProviderHandoffTrailPresentation,
} from "./ProviderHandoffTrail";

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

describe("provider handoff trail presentation", () => {
  const trail = [
    { provider: "claudeAgent" as const, isReturn: false },
    { provider: "antigravity" as const, isReturn: false },
    { provider: "codex" as const, isReturn: false },
    { provider: "grok" as const, isReturn: false },
    { provider: "claudeAgent" as const, isReturn: true },
    { provider: "droid" as const, isReturn: false },
  ];

  it("keeps the origin and latest providers while compressing long paths", () => {
    expect(resolveProviderHandoffTrailPresentation(trail)).toEqual({
      first: trail[0],
      trailing: trail.slice(-3),
      hiddenCount: 2,
    });
  });

  it("describes forward moves and returns explicitly", () => {
    expect(describeProviderHandoffTrail(trail.slice(0, 5))).toBe(
      "Started with Claude, continued with Antigravity, continued with Codex, continued with Grok, returned to Claude",
    );
  });
});
