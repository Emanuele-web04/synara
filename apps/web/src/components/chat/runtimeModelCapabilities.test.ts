import type { ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  EMPTY_MODEL_CAPABILITIES,
  getDefaultEffort,
  getModelCapabilities,
} from "@synara/shared/model";

import { providerModelSupportsAutoRuntimeMode } from "../../lib/runtimeMode";
import { mergeDynamicModelOptions } from "../../providerModelOptions";
import {
  getRuntimeAwareModelCapabilities,
  resolveRuntimeModelDescriptor,
} from "./runtimeModelCapabilities";

describe("configured custom Claude controls", () => {
  it("keeps unknown and native legacy models empty without inferred capabilities", () => {
    for (const model of ["enterprise-model", "claude-opus-4-1", "claude-3-opus"]) {
      const caps = getRuntimeAwareModelCapabilities({
        provider: "claudeAgent",
        model,
        runtimeModel: { slug: model, name: model },
      });
      expect(caps).toEqual(EMPTY_MODEL_CAPABILITIES);
    }
  });

  it("offers explicit configured controls without inferring capacity, fast mode or a pinned effort", () => {
    const caps = getRuntimeAwareModelCapabilities({
      provider: "claudeAgent",
      model: "enterprise-model",
      runtimeModel: {
        slug: "enterprise-model",
        name: "Enterprise",
        isConfiguredCustomModel: true,
      },
    });
    expect(caps.reasoningEffortLevels.map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultrathink",
      "ultracode",
    ]);
    expect(getDefaultEffort(caps)).toBeNull();
    expect(caps.contextWindowTokens).toBeUndefined();
    expect(caps.contextWindowOptions).toEqual([]);
    expect(caps.supportsFastMode).toBe(false);
    expect(caps.supportsThinkingToggle).toBe(false);
    expect(caps.optionDescriptors?.map((option) => option.id)).toEqual([
      "effort",
      "autoCompactWindow",
    ]);
    expect(caps.optionDescriptors?.[0]).toMatchObject({
      currentValue: "auto",
      options: expect.arrayContaining([
        { id: "auto", label: "Auto (Claude Code)", isDefault: true },
      ]),
    });
    expect(getModelCapabilities("claudeAgent", "enterprise-model")).toEqual(
      EMPTY_MODEL_CAPABILITIES,
    );
  });

  it("does not expand known catalog or native legacy capabilities through a custom marker", () => {
    for (const model of ["claude-haiku-4-5", "claude-opus-4-1", "claude-3-opus"]) {
      expect(
        getRuntimeAwareModelCapabilities({
          provider: "claudeAgent",
          model,
          runtimeModel: { slug: model, name: model, isConfiguredCustomModel: true },
        }),
      ).toEqual(getModelCapabilities("claudeAgent", model));
    }
  });
});

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
