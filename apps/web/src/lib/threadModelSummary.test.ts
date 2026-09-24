import { describe, expect, it } from "vitest";

import { formatThreadModelSummaryLabel, resolveThreadModelSummary } from "./threadModelSummary";

describe("resolveThreadModelSummary", () => {
  it("returns null without a selection", () => {
    expect(resolveThreadModelSummary(null)).toBeNull();
    expect(resolveThreadModelSummary(undefined)).toBeNull();
  });

  it("summarizes a codex selection with its reasoning effort", () => {
    const summary = resolveThreadModelSummary({
      provider: "codex",
      model: "gpt-5.5",
      options: { reasoningEffort: "high" },
    });

    expect(summary?.provider).toBe("codex");
    expect(summary?.modelLabel.length).toBeGreaterThan(0);
    expect(summary?.statusLabel?.toLowerCase()).toBe("high");
  });

  it("falls back to the model's default effort when none is stored", () => {
    const withEffort = resolveThreadModelSummary({
      provider: "codex",
      model: "gpt-5.5",
      options: { reasoningEffort: "low" },
    });
    const withoutOptions = resolveThreadModelSummary({
      provider: "codex",
      model: "gpt-5.5",
    });

    expect(withEffort?.statusLabel?.toLowerCase()).toBe("low");
    expect(withoutOptions?.statusLabel).not.toBeNull();
    expect(withoutOptions?.statusLabel).not.toBe(withEffort?.statusLabel);
  });

  it("summarizes a claude selection", () => {
    const summary = resolveThreadModelSummary({
      provider: "claudeAgent",
      model: "claude-sonnet-5",
      options: { effort: "high" },
    });

    expect(summary?.provider).toBe("claudeAgent");
    expect(summary?.modelLabel.length).toBeGreaterThan(0);
    expect(summary?.fastMode).toBe(false);
  });
});

describe("formatThreadModelSummaryLabel", () => {
  it("joins model and effort without repeating the provider name", () => {
    const claude = resolveThreadModelSummary({
      provider: "claudeAgent",
      model: "claude-opus-5.5",
      options: { effort: "medium" },
    });
    expect(claude).not.toBeNull();
    const label = formatThreadModelSummaryLabel(claude!);
    expect(label).toContain(claude!.modelLabel);
    expect(label).toContain("Medium");
    expect(label).toBe(`${claude!.modelLabel} · Medium`);
    expect(label.startsWith("Claude ·")).toBe(false);
  });

  it("renders the model alone when there is no effort label", () => {
    expect(
      formatThreadModelSummaryLabel({
        provider: "codex",
        modelLabel: "GPT-5 Codex",
        statusLabel: null,
        fastMode: false,
      }),
    ).toBe("GPT-5 Codex");
  });
});
