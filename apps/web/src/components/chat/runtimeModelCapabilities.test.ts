import type { ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { providerModelSupportsAutoRuntimeMode } from "../../lib/runtimeMode";
import { mergeDynamicModelOptions } from "../../providerModelOptions";
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
  it("falls back to the bare model identifier when the upstream prefix is stale", () => {
    const runtimeModels: ReadonlyArray<ProviderModelDescriptor> = [
      {
        slug: "opencode-go/muse-spark-1.3-contributor",
        name: "Muse Spark 1.3 Contributor",
        supportedReasoningEfforts: [{ value: "high", label: "High" }],
      },
    ];

    expect(
      resolveRuntimeModelDescriptor({
        provider: "opencode",
        model: "opencode/muse-spark-1.3-contributor",
        runtimeModels,
      }),
    ).toBe(runtimeModels[0]);
    expect(
      resolveRuntimeModelDescriptor({
        provider: "opencode",
        model: "muse-spark-1.3-contributor",
        runtimeModels,
      }),
    ).toBe(runtimeModels[0]);
  });

  it("prefers exact matches over the identifier fallback", () => {
    const zoned: ReadonlyArray<ProviderModelDescriptor> = [
      {
        slug: "opencode/muse-spark-1.3-contributor-free",
        name: "Muse Spark 1.3 Free",
      },
      {
        slug: "opencode-go/muse-spark-1.3-contributor",
        name: "Muse Spark 1.3 Contributor",
      },
    ];

    expect(
      resolveRuntimeModelDescriptor({
        provider: "opencode",
        model: "opencode/muse-spark-1.3-contributor-free",
        runtimeModels: zoned,
      }),
    ).toBe(zoned[0]);
  });

  it("does not borrow capabilities from an ambiguous upstream model", () => {
    const runtimeModels: ReadonlyArray<ProviderModelDescriptor> = [
      {
        slug: "openai/shared-model",
        name: "Shared model",
        supportedReasoningEfforts: [{ value: "high" }],
      },
      {
        slug: "gateway/shared-model",
        name: "Shared model",
        supportedReasoningEfforts: [{ value: "low" }],
      },
    ];

    for (const model of ["stale/shared-model", "shared-model"]) {
      expect(
        resolveRuntimeModelDescriptor({ provider: "opencode", model, runtimeModels }),
      ).toBeUndefined();
    }
    expect(
      resolveRuntimeModelDescriptor({
        provider: "opencode",
        model: "gateway/shared-model",
        runtimeModels,
      }),
    ).toBe(runtimeModels[1]);
  });

  it("preserves model namespaces when matching a stale upstream prefix", () => {
    const runtimeModels: ReadonlyArray<ProviderModelDescriptor> = [
      { slug: "gateway/vendor-a/shared-model", name: "Vendor A" },
      { slug: "gateway/vendor-b/shared-model", name: "Vendor B" },
    ];
    expect(
      resolveRuntimeModelDescriptor({
        provider: "opencode",
        model: "stale/vendor-b/shared-model",
        runtimeModels,
      }),
    ).toBe(runtimeModels[1]);
    expect(
      resolveRuntimeModelDescriptor({
        provider: "opencode",
        model: "stale/vendor-c/shared-model",
        runtimeModels,
      }),
    ).toBeUndefined();
  });
});
