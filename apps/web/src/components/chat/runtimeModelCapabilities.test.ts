import type { ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { providerModelSupportsAutoRuntimeMode } from "../../lib/runtimeMode";
import { mergeDynamicModelOptions } from "../../providerModelOptions";
import {
  getRuntimeAwareModelCapabilities,
  resolveRuntimeModelDescriptor,
} from "./runtimeModelCapabilities";

describe("resolveRuntimeModelDescriptor", () => {
  it("uses Claude's discovered efforts and respects explicit unsupported values", () => {
    const runtimeModel: ProviderModelDescriptor = {
      slug: "claude-haiku-5-5",
      name: "Haiku 5.5",
      supportedReasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }],
      defaultReasoningEffort: "medium",
    };
    const caps = getRuntimeAwareModelCapabilities({
      provider: "claudeAgent",
      model: runtimeModel.slug,
      runtimeModel,
    });
    expect(caps.reasoningEffortLevels.map((level) => level.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(caps.reasoningEffortLevels.find((level) => level.isDefault)?.value).toBe("medium");

    const unsupported = getRuntimeAwareModelCapabilities({
      provider: "claudeAgent",
      model: runtimeModel.slug,
      runtimeModel: { ...runtimeModel, supportedReasoningEfforts: [] },
    });
    expect(unsupported.reasoningEffortLevels).toEqual([]);
  });
  it("matches a Claude model by its resolved canonical id", () => {
    const runtimeModels: ReadonlyArray<ProviderModelDescriptor> = [
      {
        slug: "sonnet",
        resolvedModel: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        supportsAutoMode: false,
      },
    ];

    expect(
      resolveRuntimeModelDescriptor({
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        runtimeModels,
      }),
    ).toBe(runtimeModels[0]);
  });

  it.each([
    ["opus", true],
    ["opus[1m]", true],
    ["opus[1m]", false],
  ] as const)("preserves Auto support for discovered %s (%s)", (slug, supportsAutoMode) => {
    const runtimeModels: ReadonlyArray<ProviderModelDescriptor> = [
      { slug, resolvedModel: "claude-opus-6[1m]", name: "Opus", supportsAutoMode },
    ];
    const [option] = mergeDynamicModelOptions({
      provider: "claudeAgent",
      staticOptions: [],
      dynamicModels: runtimeModels,
    });
    expect(option?.slug).toBe("claude-opus-6");
    const descriptor = resolveRuntimeModelDescriptor({
      provider: "claudeAgent",
      model: option?.slug,
      runtimeModels,
    });
    expect(descriptor).toBe(runtimeModels[0]);
    expect(
      providerModelSupportsAutoRuntimeMode("claudeAgent", descriptor, {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        supportsAutoRuntimeMode: true,
        checkedAt: new Date(0).toISOString(),
      }),
    ).toBe(supportsAutoMode);
  });

  it("prefers an exact Claude descriptor over a context-qualified fallback", () => {
    const runtimeModels: ReadonlyArray<ProviderModelDescriptor> = [
      {
        slug: "opus[1m]",
        resolvedModel: "claude-opus-6[1m]",
        name: "Opus",
        supportsAutoMode: true,
      },
      { slug: "claude-opus-6", name: "Opus", supportsAutoMode: false },
    ];
    expect(
      resolveRuntimeModelDescriptor({
        provider: "claudeAgent",
        model: "claude-opus-6",
        runtimeModels,
      }),
    ).toBe(runtimeModels[1]);
  });

  it("does not resolve an explicitly qualified selection to a bare Claude descriptor", () => {
    expect(
      resolveRuntimeModelDescriptor({
        provider: "claudeAgent",
        model: "claude-opus-6[1m]",
        runtimeModels: [{ slug: "claude-opus-6", name: "Opus", supportsAutoMode: true }],
      }),
    ).toBeUndefined();
  });
});
