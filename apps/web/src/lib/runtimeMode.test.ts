import { describe, expect, it } from "vitest";

import {
  normalizeRuntimeModeForProvider,
  providerModelSupportsAutoRuntimeMode,
  providerSupportsAutoRuntimeMode,
  RUNTIME_MODE_PRESENTATION,
  runtimeModePresentation,
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
          driver: "claudeAgent",
          instanceId: "claudeAgent",
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
        driver: "codex",
        instanceId: "codex",
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
          driver: "claudeAgent",
          instanceId: "claudeAgent",
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

describe("runtimeModePresentation", () => {
  it("describes each mode with the provider's own mechanism for Claude and Codex", () => {
    expect(runtimeModePresentation("auto", "claudeAgent").description).toContain("classifier");
    expect(runtimeModePresentation("approval-required", "codex").description).toContain(
      "Read-only sandbox",
    );
    expect(runtimeModePresentation("auto", "codex").label).toBe(
      RUNTIME_MODE_PRESENTATION.auto.label,
    );
  });

  it("keeps the generic wording for other providers", () => {
    expect(runtimeModePresentation("full-access", "cursor")).toEqual(
      RUNTIME_MODE_PRESENTATION["full-access"],
    );
    expect(runtimeModePresentation("approval-required", undefined)).toEqual(
      RUNTIME_MODE_PRESENTATION["approval-required"],
    );
  });
});
