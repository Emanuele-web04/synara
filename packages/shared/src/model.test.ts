import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS,
  MODEL_OPTIONS_BY_PROVIDER,
  CODEX_REASONING_EFFORT_OPTIONS,
} from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  getDefaultModel,
  getModelCapabilities,
  getModelOptions,
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeModelSlug,
  resolveSelectableModel,
  resolveModelSlug,
  resolveModelSlugForProvider,
  getDefaultEffort,
  hasEffortLevel,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });

  it("uses provider-specific aliases", () => {
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-4-6");
    expect(normalizeModelSlug("opus-4.6", "claudeAgent")).toBe("claude-opus-4-6");
    expect(normalizeModelSlug("claude-haiku-4-5-20251001", "claudeAgent")).toBe("claude-haiku-4-5");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });

  it("supports provider-aware resolution", () => {
    expect(resolveModelSlugForProvider("claudeAgent", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
    expect(resolveModelSlugForProvider("claudeAgent", "sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelSlugForProvider("claudeAgent", "gpt-5.3-codex")).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
  });

  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS);
    expect(getModelOptions("claudeAgent")).toEqual(MODEL_OPTIONS_BY_PROVIDER.claudeAgent);
  });
});

describe("resolveSelectableModel", () => {
  it("resolves exact slug matches", () => {
    expect(
      resolveSelectableModel("codex", "gpt-5.3-codex", [
        { slug: "gpt-5.4", name: "GPT-5.4" },
        { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      ]),
    ).toBe("gpt-5.3-codex");
  });

  it("resolves case-insensitive display-name matches", () => {
    expect(
      resolveSelectableModel("codex", "gpt-5.3 codex", [
        { slug: "gpt-5.4", name: "GPT-5.4" },
        { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      ]),
    ).toBe("gpt-5.3-codex");
  });

  it("resolves provider-specific aliases after normalization", () => {
    expect(
      resolveSelectableModel("claudeAgent", "sonnet", [
        { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ]),
    ).toBe("claude-sonnet-4-6");
  });

  it("returns null for empty input", () => {
    expect(resolveSelectableModel("codex", "", [{ slug: "gpt-5.4", name: "GPT-5.4" }])).toBeNull();
    expect(
      resolveSelectableModel("codex", "   ", [{ slug: "gpt-5.4", name: "GPT-5.4" }]),
    ).toBeNull();
    expect(
      resolveSelectableModel("codex", null, [{ slug: "gpt-5.4", name: "GPT-5.4" }]),
    ).toBeNull();
  });

  it("returns null for unknown values that are not present in options", () => {
    expect(
      resolveSelectableModel("codex", "gpt-4.1", [{ slug: "gpt-5.4", name: "GPT-5.4" }]),
    ).toBeNull();
  });

  it("does not accept normalized custom-looking slugs unless they exist in options", () => {
    expect(
      resolveSelectableModel("codex", "custom/internal-model", [
        { slug: "gpt-5.4", name: "GPT-5.4" },
      ]),
    ).toBeNull();
  });

  it("respects provider boundaries", () => {
    expect(
      resolveSelectableModel("codex", "sonnet", [{ slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" }]),
    ).toBeNull();
    expect(
      resolveSelectableModel("claudeAgent", "5.3", [
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ]),
    ).toBeNull();
  });
});

describe("getModelCapabilities reasoningEffortLevels", () => {
  const values = (provider: "codex" | "claudeAgent", model: string | null) =>
    getModelCapabilities(provider, model).reasoningEffortLevels.map((l) => l.value);

  it("returns codex reasoning options for codex", () => {
    expect(values("codex", "gpt-5.4")).toEqual([...CODEX_REASONING_EFFORT_OPTIONS]);
  });

  it("returns claude effort options for Opus 4.6", () => {
    expect(values("claudeAgent", "claude-opus-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
  });

  it("returns claude effort options for Opus 4.7", () => {
    expect(values("claudeAgent", "claude-opus-4-7")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
    ]);
  });

  it("returns claude effort options for Sonnet 4.6", () => {
    expect(values("claudeAgent", "claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
  });

  it("returns no claude effort options for Haiku 4.5", () => {
    expect(values("claudeAgent", "claude-haiku-4-5")).toEqual([]);
  });

  it("co-locates labels with effort values", () => {
    const levels = getModelCapabilities("claudeAgent", "claude-opus-4-6").reasoningEffortLevels;
    const high = levels.find((l) => l.value === "high");
    expect(high).toEqual({ value: "high", label: "High", isDefault: true });
    const xhigh = getModelCapabilities("claudeAgent", "claude-opus-4-7").reasoningEffortLevels.find(
      (l) => l.value === "xhigh",
    );
    expect(xhigh).toEqual({ value: "xhigh", label: "Extra High" });
  });
});

describe("getDefaultEffort", () => {
  it("returns the default effort from capabilities", () => {
    expect(getDefaultEffort(getModelCapabilities("codex", "gpt-5.4"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("claudeAgent", "claude-opus-4-7"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("claudeAgent", "claude-opus-4-6"))).toBe("high");
    expect(getDefaultEffort(getModelCapabilities("claudeAgent", "claude-haiku-4-5"))).toBeNull();
  });
});

describe("hasEffortLevel", () => {
  it("validates effort against model capabilities", () => {
    const opusCaps = getModelCapabilities("claudeAgent", "claude-opus-4-6");
    expect(hasEffortLevel(opusCaps, "max")).toBe(true);
    expect(hasEffortLevel(opusCaps, "xhigh")).toBe(false);

    const opus47Caps = getModelCapabilities("claudeAgent", "claude-opus-4-7");
    expect(hasEffortLevel(opus47Caps, "xhigh")).toBe(true);

    const codexCaps = getModelCapabilities("codex", "gpt-5.4");
    expect(hasEffortLevel(codexCaps, "xhigh")).toBe(true);
    expect(hasEffortLevel(codexCaps, "max")).toBe(false);
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("prefixes ultrathink prompts exactly once", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this",
    );
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nInvestigate this", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this",
    );
  });

  it("leaves non-ultrathink prompts unchanged", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this", "high")).toBe("Investigate this");
  });
});

describe("normalizeCodexModelOptions", () => {
  it("drops default-only codex options", () => {
    expect(
      normalizeCodexModelOptions("gpt-5.4", { reasoningEffort: "high", fastMode: false }),
    ).toBeUndefined();
  });

  it("preserves non-default codex options", () => {
    expect(
      normalizeCodexModelOptions("gpt-5.4", { reasoningEffort: "xhigh", fastMode: true }),
    ).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    });
  });
});

describe("normalizeClaudeModelOptions", () => {
  it("drops unsupported fast mode for Sonnet while preserving max effort", () => {
    expect(
      normalizeClaudeModelOptions("claude-sonnet-4-6", {
        effort: "max",
        fastMode: true,
      }),
    ).toEqual({
      effort: "max",
    });
  });

  it("keeps the Haiku thinking toggle and removes unsupported effort", () => {
    expect(
      normalizeClaudeModelOptions("claude-haiku-4-5", {
        thinking: false,
        effort: "high",
      }),
    ).toEqual({
      thinking: false,
    });
  });
});

describe("getModelCapabilities Claude capability flags", () => {
  it("only enables adaptive reasoning for Opus 4.6 and Sonnet 4.6", () => {
    const has = (m: string | undefined) =>
      getModelCapabilities("claudeAgent", m).reasoningEffortLevels.length > 0;
    expect(has("claude-opus-4-7")).toBe(true);
    expect(has("claude-opus-4-6")).toBe(true);
    expect(has("claude-sonnet-4-6")).toBe(true);
    expect(has("claude-haiku-4-5")).toBe(false);
    expect(has(undefined)).toBe(false);
  });

  it("only enables max effort for Opus 4.6 and Sonnet 4.6", () => {
    const has = (m: string | undefined) =>
      getModelCapabilities("claudeAgent", m).reasoningEffortLevels.some((l) => l.value === "max");
    expect(has("claude-opus-4-7")).toBe(true);
    expect(has("claude-opus-4-6")).toBe(true);
    expect(has("claude-sonnet-4-6")).toBe(true);
    expect(has("claude-haiku-4-5")).toBe(false);
    expect(has(undefined)).toBe(false);
  });

  it("only enables Claude fast mode for Opus 4.6", () => {
    const has = (m: string | undefined) => getModelCapabilities("claudeAgent", m).supportsFastMode;
    expect(has("claude-opus-4-7")).toBe(true);
    expect(has("claude-opus-4-6")).toBe(true);
    expect(has("opus")).toBe(true);
    expect(has("claude-sonnet-4-6")).toBe(false);
    expect(has("claude-haiku-4-5")).toBe(false);
    expect(has(undefined)).toBe(false);
  });

  it("only enables ultrathink keyword handling for Opus 4.6 and Sonnet 4.6", () => {
    const has = (m: string | undefined) =>
      getModelCapabilities("claudeAgent", m).promptInjectedEffortLevels.includes("ultrathink");
    expect(has("claude-opus-4-7")).toBe(true);
    expect(has("claude-opus-4-6")).toBe(true);
    expect(has("claude-sonnet-4-6")).toBe(true);
    expect(has("claude-haiku-4-5")).toBe(false);
  });

  it("only enables the Claude thinking toggle for Haiku 4.5", () => {
    const has = (m: string | undefined) =>
      getModelCapabilities("claudeAgent", m).supportsThinkingToggle;
    expect(has("claude-opus-4-6")).toBe(false);
    expect(has("claude-sonnet-4-6")).toBe(false);
    expect(has("claude-haiku-4-5")).toBe(true);
    expect(has("haiku")).toBe(true);
    expect(has(undefined)).toBe(false);
  });
});

describe("isClaudeUltrathinkPrompt", () => {
  it("detects ultrathink prompts case-insensitively", () => {
    expect(isClaudeUltrathinkPrompt("Please ultrathink about this")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Ultrathink:\nInvestigate")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Think hard about this")).toBe(false);
    expect(isClaudeUltrathinkPrompt(undefined)).toBe(false);
  });
});
