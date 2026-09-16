import type { ProviderKind, ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import type { ComposerModelPreset } from "../../lib/composerModelPresets";
import {
  captureComposerModelPreset,
  planComposerModelPreset,
} from "./composerModelPresetSelection";
import { getComposerTraitSelection } from "./composerTraits";

const PRESET: ComposerModelPreset = {
  provider: "codex",
  model: "gpt-5.5",
  reasoning: { kind: "effort", optionId: "reasoningEffort", value: "xhigh", label: "Extra High" },
};
const INPUT = {
  preset: PRESET,
  lockedProvider: null,
  providerAvailable: true,
  availableModels: [{ slug: PRESET.model, name: "GPT-5.5" }],
  prompt: "Keep this prompt",
};

describe("composer preset capture and application", () => {
  it("captures the current effort, but never speed, context, or prompt content", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "PRIVATE PROMPT", {
      reasoningEffort: "xhigh",
      fastMode: true,
    });
    expect(captureComposerModelPreset({ provider: "codex", model: "gpt-5.5", selection })).toEqual(
      PRESET,
    );
    expect(planComposerModelPreset(INPUT)).toEqual({
      kind: "ready",
      patch: { reasoningEffort: "xhigh" },
    });
  });

  it.each([
    { lockedProvider: "cursor" as const },
    { availableModels: [] },
    { providerAvailable: false },
    { loading: true },
  ])("does not fall back when the exact preset is unavailable: %j", (overrides) => {
    expect(planComposerModelPreset({ ...INPUT, ...overrides }).kind).toBe("unavailable");
  });

  it("uses live efforts instead of assuming static model support", () => {
    const runtimeModel: ProviderModelDescriptor = {
      slug: PRESET.model,
      name: "GPT-5.5",
      supportedReasoningEfforts: [{ value: "low" }, { value: "high" }],
    };
    expect(planComposerModelPreset({ ...INPUT, runtimeModel })).toEqual({
      kind: "unavailable",
      reason: "Saved effort is no longer supported.",
    });
    const preset: ComposerModelPreset = {
      ...PRESET,
      reasoning: { kind: "effort", optionId: "reasoningEffort", value: "ultra", label: "Ultra" },
    };
    expect(
      planComposerModelPreset({
        ...INPUT,
        preset,
        runtimeModel: {
          ...runtimeModel,
          supportedReasoningEfforts: [{ value: "low" }, { value: "ultra" }],
        },
      }),
    ).toEqual({ kind: "ready", patch: { reasoningEffort: "ultra" } });
  });

  it.each<[ProviderKind, string]>([
    ["codex", "reasoningEffort"],
    ["cursor", "reasoningEffort"],
    ["claudeAgent", "effort"],
    ["opencode", "variant"],
    ["pi", "thinkingLevel"],
  ])("restores %s through its own %s descriptor", (provider, optionId) => {
    const runtimeModel: ProviderModelDescriptor = {
      slug: "sample-model",
      name: "Sample model",
      optionDescriptors: [
        {
          id: optionId,
          label: "Effort",
          type: "select",
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    };
    const preset: ComposerModelPreset = {
      provider,
      model: runtimeModel.slug,
      reasoning: { kind: "effort", optionId, value: "high", label: "High" },
    };
    expect(
      planComposerModelPreset({
        ...INPUT,
        preset,
        runtimeModel,
        availableModels: [{ slug: runtimeModel.slug, name: runtimeModel.name }],
      }),
    ).toEqual({ kind: "ready", patch: { [optionId]: "high" } });
    expect(
      planComposerModelPreset({
        ...INPUT,
        preset: {
          ...preset,
          reasoning: { kind: "effort", optionId: "oldOption", value: "high", label: "High" },
        },
        runtimeModel,
        availableModels: [{ slug: runtimeModel.slug, name: runtimeModel.name }],
      }).kind,
    ).toBe("unavailable");
  });

  it("captures and reapplies Ultrathink without saving the prompt or duplicating its prefix", () => {
    const provider = "claudeAgent";
    const model = "claude-opus-4-8";
    const selection = getComposerTraitSelection(provider, model, "Ultrathink:\nPRIVATE", undefined);
    const preset = captureComposerModelPreset({ provider, model, selection });
    expect(preset.reasoning).toMatchObject({ kind: "effort", value: "ultrathink" });
    expect(JSON.stringify(preset)).not.toContain("PRIVATE");
    const input = { ...INPUT, preset, availableModels: [{ slug: model, name: "Opus" }] };
    expect(planComposerModelPreset(input)).toEqual({
      kind: "ready",
      prompt: "Ultrathink:\nKeep this prompt",
    });
    expect(planComposerModelPreset({ ...input, prompt: "Ultrathink:\nExisting" })).toEqual({
      kind: "ready",
    });
    expect(
      planComposerModelPreset({
        ...input,
        prompt: "Ultrathink:\nExisting",
        preset: {
          provider,
          model,
          reasoning: { kind: "effort", optionId: "effort", value: "high", label: "High" },
        },
      }),
    ).toEqual({
      kind: "unavailable",
      reason: "Remove Ultrathink from the prompt to change effort.",
    });
  });

  it("captures thinking-only and model-only providers without inventing an effort", () => {
    const provider = "grok";
    const model = "grok-4.6";
    const runtimeModel: ProviderModelDescriptor = {
      slug: model,
      name: "Grok",
      optionDescriptors: [
        { id: "thinking", type: "boolean", label: "Thinking", currentValue: false },
      ],
    };
    const preset = captureComposerModelPreset({
      provider,
      model,
      selection: getComposerTraitSelection(provider, model, "", undefined, runtimeModel),
    });
    expect(preset.reasoning).toEqual({ kind: "thinking", value: false });
    expect(
      planComposerModelPreset({
        ...INPUT,
        preset,
        runtimeModel,
        availableModels: [{ slug: model, name: "Grok" }],
      }),
    ).toEqual({ kind: "ready", patch: { thinking: false } });
    const clinePreset = captureComposerModelPreset({
      provider: "cline",
      model: "default",
      selection: getComposerTraitSelection("cline", "default", "", undefined),
    });
    expect(clinePreset.reasoning).toBeNull();
    expect(
      planComposerModelPreset({
        ...INPUT,
        preset: clinePreset,
        availableModels: [{ slug: "default", name: "Default" }],
      }),
    ).toEqual({ kind: "ready" });
  });
});
