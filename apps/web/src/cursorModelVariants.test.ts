import { describe, expect, it } from "vitest";

import { collapseCursorModelVariants, normalizeCursorModelVariantBaseId } from "./cursorModelVariants";

describe("normalizeCursorModelVariantBaseId", () => {
  it("normalizes Cursor CLI reasoning, fast, and extra-high suffixes", () => {
    expect(normalizeCursorModelVariantBaseId("gpt-5.5-extra-high")).toBe("gpt-5.5");
    expect(normalizeCursorModelVariantBaseId("gpt-5.1-codex-max-medium-fast")).toBe(
      "gpt-5.1-codex-max",
    );
    expect(normalizeCursorModelVariantBaseId("claude-4.6-opus-max-thinking-fast")).toBe(
      "claude-opus-4-6",
    );
  });
});

describe("collapseCursorModelVariants", () => {
  it("collapses Cursor CLI variants into one model with trait capabilities", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "gpt-5.5-medium",
          name: "GPT-5.5 1M",
          upstreamProviderId: "openai",
          upstreamProviderName: "OpenAI",
          supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
          defaultReasoningEffort: "medium",
          contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
          defaultContextWindow: "1m",
        },
        {
          slug: "gpt-5.5-extra-high",
          name: "GPT-5.5 1M Extra High",
          upstreamProviderId: "openai",
          upstreamProviderName: "OpenAI",
          supportedReasoningEfforts: [{ value: "xhigh", label: "Extra High" }],
          defaultReasoningEffort: "xhigh",
          contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
          defaultContextWindow: "1m",
        },
      ]),
    ).toEqual([
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        supportedReasoningEfforts: [
          { value: "medium", label: "Medium", isDefault: true },
          { value: "xhigh", label: "Extra High" },
        ],
        defaultReasoningEffort: "medium",
        contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
        defaultContextWindow: "1m",
      },
    ]);
  });
});
