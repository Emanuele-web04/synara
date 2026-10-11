import { describe, expect, it } from "vitest";
import type { ProviderModelDescriptor } from "@synara/contracts";

import { formatThreadModelSummaryLabel, resolveThreadModelSummary } from "./threadModelSummary";

describe("resolveThreadModelSummary", () => {
  const runtimeModel: ProviderModelDescriptor = {
    slug: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    supportedReasoningEfforts: [
      { value: "medium", label: "Medium" },
      { value: "xhigh", label: "Extra High" },
    ],
    defaultReasoningEffort: "medium",
    supportsFastMode: true,
  };

  it("shows effort and Fast for a runtime-discovered model outside the static catalog", () => {
    const summary = resolveThreadModelSummary(
      {
        provider: "codex",
        model: "gpt-6.1-sol",
        options: { reasoningEffort: "xhigh", fastMode: true },
      },
      runtimeModel,
    );

    expect(summary).toMatchObject({ statusLabel: "Extra High", fastMode: true });
  });

  it("uses the runtime default effort when no override is stored", () => {
    expect(
      resolveThreadModelSummary({ provider: "codex", model: "gpt-6.1-sol" }, runtimeModel),
    ).toMatchObject({ statusLabel: "Medium", fastMode: false });
  });

  it("respects runtime Fast support instead of the static catalog", () => {
    expect(
      resolveThreadModelSummary(
        { provider: "codex", model: "gpt-5.5", options: { fastMode: true } },
        { ...runtimeModel, slug: "gpt-5.5", supportsFastMode: false },
      ),
    ).toMatchObject({ fastMode: false });
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
