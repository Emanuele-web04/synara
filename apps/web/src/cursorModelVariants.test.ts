import { describe, expect, it } from "vitest";

import {
  canonicalizeCursorModelSelection,
  collapseCursorModelVariants,
  cursorModelOptionsFromVariantSlug,
  mergeCursorModelVariantsWithBaseControls,
  normalizeCursorModelVariantBaseId,
} from "./cursorModelVariants";

describe("normalizeCursorModelVariantBaseId", () => {
  it("normalizes Cursor CLI reasoning, fast, and extra-high suffixes", () => {
    expect(normalizeCursorModelVariantBaseId("gpt-5.5-extra-high")).toBe("gpt-5.5");
    expect(normalizeCursorModelVariantBaseId("gpt-5.1-codex-max-medium-fast")).toBe(
      "gpt-5.1-codex-max",
    );
    expect(normalizeCursorModelVariantBaseId("claude-4.6-opus-max-thinking-fast")).toBe(
      "claude-opus-4-6",
    );
    expect(normalizeCursorModelVariantBaseId("claude-5-sonnet-max-fast")).toBe("claude-sonnet-5");
    expect(normalizeCursorModelVariantBaseId("grok-4-5-fast-high")).toBe("grok-4-5");
    expect(normalizeCursorModelVariantBaseId("grok-4.5-high-fast")).toBe("grok-4.5");
  });
});

describe("cursorModelOptionsFromVariantSlug", () => {
  it("extracts reasoning and fast traits from Grok CLI variant ids", () => {
    expect(cursorModelOptionsFromVariantSlug("grok-4-5-fast-high")).toEqual({
      reasoningEffort: "high",
      fastMode: true,
    });
    expect(cursorModelOptionsFromVariantSlug("grok-4.5-high-fast")).toEqual({
      reasoningEffort: "high",
      fastMode: true,
    });
  });
});

describe("canonicalizeCursorModelSelection", () => {
  it("rewrites Grok Fast High variants onto a base model with selectors", () => {
    expect(
      canonicalizeCursorModelSelection({
        model: "grok-4-5-fast-high",
      }),
    ).toEqual({
      model: "grok-4-5",
      options: {
        reasoningEffort: "high",
        fastMode: true,
      },
    });
  });

  it("keeps explicit options over slug-inferred traits", () => {
    expect(
      canonicalizeCursorModelSelection({
        model: "grok-4-5-fast-high",
        options: { reasoningEffort: "medium", fastMode: false },
      }),
    ).toEqual({
      model: "grok-4-5",
      options: {
        reasoningEffort: "medium",
        fastMode: false,
      },
    });
  });
});

describe("mergeCursorModelVariantsWithBaseControls", () => {
  it("keeps raw Cursor CLI variants while adding a rich base model first", () => {
    const models = [
      {
        slug: "claude-fable-5-high",
        name: "Fable 5 1M",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportedReasoningEfforts: [{ value: "high", label: "High" }],
        defaultReasoningEffort: "high",
      },
      {
        slug: "claude-fable-5-max",
        name: "Fable 5 1M Max",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportedReasoningEfforts: [{ value: "max", label: "Max" }],
        defaultReasoningEffort: "max",
      },
    ];

    const merged = mergeCursorModelVariantsWithBaseControls(models);

    expect(merged.map((model) => model.slug)).toEqual([
      "claude-fable-5",
      "claude-fable-5-high",
      "claude-fable-5-max",
    ]);
    expect(merged[0]).toMatchObject({
      slug: "claude-fable-5",
      contextWindowOptions: [
        { value: "300k", label: "300K", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      defaultContextWindow: "300k",
    });
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
        contextWindowOptions: [
          { value: "272k", label: "272K", isDefault: true },
          { value: "1m", label: "1M" },
        ],
        defaultContextWindow: "272k",
      },
    ]);
  });

  it("collapses Grok Fast High CLI variants like GPT and Claude", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "grok-4-5-fast-high",
          name: "Grok 4.5 Fast High",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
          defaultReasoningEffort: "high",
        },
        {
          slug: "grok-4-5-fast-medium",
          name: "Grok 4.5 Fast Medium",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
          supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
          defaultReasoningEffort: "medium",
        },
        {
          slug: "grok-4-5-low",
          name: "Grok 4.5 Low",
          upstreamProviderId: "xai",
          upstreamProviderName: "xAI",
          supportedReasoningEfforts: [{ value: "low", label: "Low" }],
          defaultReasoningEffort: "low",
        },
      ]),
    ).toEqual([
      {
        slug: "grok-4-5",
        name: "Grok 4.5",
        upstreamProviderId: "xai",
        upstreamProviderName: "xAI",
        supportedReasoningEfforts: [
          { value: "high", label: "High", isDefault: true },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        defaultReasoningEffort: "high",
        supportsFastMode: true,
      },
    ]);
  });

  it("restores Cursor CLI fallback context choices for Fable 5 variants", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "claude-fable-5-high",
          name: "Fable 5 1M",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
          defaultReasoningEffort: "high",
        },
        {
          slug: "claude-fable-5-max",
          name: "Fable 5 1M Max",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "max", label: "Max" }],
          defaultReasoningEffort: "max",
        },
      ]),
    ).toEqual([
      {
        slug: "claude-fable-5",
        name: "Fable 5",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportedReasoningEfforts: [
          { value: "high", label: "High", isDefault: true },
          { value: "max", label: "Max" },
        ],
        defaultReasoningEffort: "high",
        contextWindowOptions: [
          { value: "300k", label: "300K", isDefault: true },
          { value: "1m", label: "1M" },
        ],
        defaultContextWindow: "300k",
      },
    ]);
  });

  it("restores Cursor CLI fallback context choices for Sonnet 5 variants", () => {
    expect(
      collapseCursorModelVariants([
        {
          slug: "claude-sonnet-5-xhigh",
          name: "Sonnet 5 1M Extra High",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "xhigh", label: "Extra High" }],
          defaultReasoningEffort: "xhigh",
        },
        {
          slug: "claude-sonnet-5-max",
          name: "Sonnet 5 1M Max",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "max", label: "Max" }],
          defaultReasoningEffort: "max",
        },
      ]),
    ).toEqual([
      {
        slug: "claude-sonnet-5",
        name: "Sonnet 5",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportedReasoningEfforts: [
          { value: "xhigh", label: "Extra High", isDefault: true },
          { value: "max", label: "Max" },
        ],
        defaultReasoningEffort: "xhigh",
        contextWindowOptions: [
          { value: "300k", label: "300K", isDefault: true },
          { value: "1m", label: "1M" },
        ],
        defaultContextWindow: "300k",
      },
    ]);
  });
});
