import { describe, expect, it } from "vitest";

import {
  normalizeRuntimeModeForProvider,
  autoRuntimeModeSelectionIssue,
  providerSupportsAutoRuntimeMode,
  runtimeModeEscalatesPrivilege,
} from "./runtimeMode";

describe("runtime mode compatibility", () => {
  it("limits Auto to providers with a native reviewer", () => {
    expect(providerSupportsAutoRuntimeMode("codex")).toBe(true);
    expect(providerSupportsAutoRuntimeMode("claudeAgent")).toBe(true);
    expect(providerSupportsAutoRuntimeMode("opencode")).toBe(false);
    expect(providerSupportsAutoRuntimeMode("cursor")).toBe(false);
  });

  it("normalizes only unsupported Auto selections", () => {
    expect(normalizeRuntimeModeForProvider("auto", "opencode")).toBe("approval-required");
    expect(normalizeRuntimeModeForProvider("approval-required", "opencode")).toBe(
      "approval-required",
    );
    expect(normalizeRuntimeModeForProvider("full-access", "opencode")).toBe("full-access");
  });

  it("treats Auto as more privileged than Supervised but less privileged than Full access", () => {
    expect(runtimeModeEscalatesPrivilege("approval-required", "auto")).toBe(true);
    expect(runtimeModeEscalatesPrivilege("auto", "full-access")).toBe(true);
    expect(runtimeModeEscalatesPrivilege("auto", "approval-required")).toBe(false);
  });
});

it.each([
  "codex",
  "claudeAgent",
  "opencode",
  "cursor",
  "grok",
  "devin",
  "droid",
  "pi",
  "antigravity",
] as const)(
  "keeps local Auto available for %s independently of native Auto capabilities",
  (provider) => {
    expect(normalizeRuntimeModeForProvider("auto-local", provider)).toBe("auto-local");
    expect(
      autoRuntimeModeSelectionIssue({
        runtimeMode: "auto-local",
        modelSelection: { provider, model: "test", supportsAutoMode: false },
      }),
    ).toBeNull();
  },
);
