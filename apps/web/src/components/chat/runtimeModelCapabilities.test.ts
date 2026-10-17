import type { ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { providerModelSupportsAutoRuntimeMode } from "../../lib/runtimeMode";
import { mergeDynamicModelOptions, type ProviderOptions } from "../../providerModelOptions";
import { getComposerProviderState } from "./composerProviderRegistry";
import { getComposerTraitSelection } from "./composerTraits";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";

describe("resolveRuntimeModelDescriptor", () => {
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

describe("Claude runtime effort default", () => {
  // Hosts before the adapter fix published CLI effort ladders without a default.
  const runtimeModel: ProviderModelDescriptor = {
    slug: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
      },
    ],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
      value,
      label: value,
    })),
  };
  const selection = (options: ProviderOptions | undefined) =>
    getComposerTraitSelection("claudeAgent", "claude-fable-5-1", "", options, runtimeModel);

  it("shows an unset effort as the default instead of the first level", () => {
    expect(selection(undefined)).toMatchObject({ effort: "high", defaultEffort: "high" });
  });

  it("keeps High selected after the composer drops the default level", () => {
    const { modelOptionsForDispatch } = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-fable-5-1",
      runtimeModel,
      prompt: "",
      modelOptions: { claudeAgent: { effort: "high" } },
    });
    expect(modelOptionsForDispatch).toBeUndefined();
    expect(selection(modelOptionsForDispatch).effort).toBe("high");
    expect(selection({ effort: "medium" }).effort).toBe("medium");
  });
});
