import { describe, expect, it } from "vitest";

import {
  RUNTIME_MODE_PRESENTATION,
  normalizeRuntimeModeForProvider,
  providerModelSupportsAutoRuntimeMode,
  providerSupportsAutoRuntimeMode,
} from "./runtimeMode";

describe("runtime mode provider support", () => {
  it("offers AI-reviewed auto mode to Codex and Claude Code", () => {
    expect(providerSupportsAutoRuntimeMode("codex")).toBe(true);
    expect(providerSupportsAutoRuntimeMode("claudeAgent")).toBe(true);
  });

  it("falls back to supervised mode for providers without auto review", () => {
    expect(normalizeRuntimeModeForProvider("auto", "opencode")).toBe("approval-required");
    expect(normalizeRuntimeModeForProvider("full-access", "opencode")).toBe("full-access");
  });

  it("describes Auto as AI-reviewed rather than unrestricted", () => {
    expect(RUNTIME_MODE_PRESENTATION.auto).toEqual({
      label: "Auto",
      description:
        "An AI reviewer handles routine approvals; higher-risk actions may be blocked or ask you.",
    });
  });

  it("uses Claude's explicit model and CLI capability signals", () => {
    expect(
      providerModelSupportsAutoRuntimeMode(
        "claudeAgent",
        { slug: "claude-test", name: "Claude Test", supportsAutoMode: false },
        null,
      ),
    ).toBe(false);
    expect(
      providerModelSupportsAutoRuntimeMode(
        "claudeAgent",
        { slug: "claude-test", name: "Claude Test", supportsAutoMode: true },
        {
          provider: "claudeAgent",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          supportsAutoRuntimeMode: false,
          checkedAt: new Date(0).toISOString(),
        },
      ),
    ).toBe(false);
  });

  it("hides Auto when the installed Codex CLI lacks native review support", () => {
    expect(
      providerModelSupportsAutoRuntimeMode("codex", undefined, {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        supportsAutoRuntimeMode: false,
        checkedAt: new Date(0).toISOString(),
      }),
    ).toBe(false);
  });

  it("hides Auto until exact CLI and Claude model capability are known", () => {
    expect(providerModelSupportsAutoRuntimeMode("codex", undefined, null)).toBe(false);
    expect(
      providerModelSupportsAutoRuntimeMode(
        "claudeAgent",
        { slug: "claude-test", name: "Claude Test" },
        {
          provider: "claudeAgent",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          supportsAutoRuntimeMode: true,
          checkedAt: new Date(0).toISOString(),
        },
      ),
    ).toBe(false);
  });
});
