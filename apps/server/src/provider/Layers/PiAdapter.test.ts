// FILE: PiAdapter.test.ts
// Purpose: Verifies Pi adapter model discovery exposes only SDK-supported thinking levels.
// Layer: Provider adapter tests
// Depends on: PiAdapter discovery helpers and Pi model metadata shapes.

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  ensurePiSubagentChildLauncherEnv,
  getPiSupportedThinkingOptions,
  makePiSubagentPromptItemId,
  makePiUserInputOptions,
  PLAIN_PI_EXTENSION_THEME,
} from "./PiAdapter";

function makePiModel(input: {
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
  return {
    reasoning: input.reasoning,
    ...(input.thinkingLevelMap !== undefined ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
  };
}

describe("getPiSupportedThinkingOptions", () => {
  it("hides thinking controls for non-reasoning models", () => {
    expect(getPiSupportedThinkingOptions(makePiModel({ reasoning: false }))).toEqual([]);
  });

  it("advertises xhigh only when the concrete Pi model supports it", () => {
    const withoutXHigh = getPiSupportedThinkingOptions(makePiModel({ reasoning: true }));
    const withXHigh = getPiSupportedThinkingOptions(
      makePiModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    );

    expect(withoutXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(withXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("respects provider-level disabled thinking levels", () => {
    const options = getPiSupportedThinkingOptions(
      makePiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
        },
      }),
    );

    expect(options.map((option) => option.value)).toEqual(["minimal", "low", "medium", "high"]);
  });
});

describe("Pi extension UI helpers", () => {
  it("keeps original select values while showing normalized unique labels", () => {
    const mappings = makePiUserInputOptions(["  OpenRouter  ", "", "OpenRouter"]);

    expect(mappings.map((mapping) => mapping.value)).toEqual(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.option.label)).toEqual([
      "OpenRouter",
      "Option 2",
      "OpenRouter (2)",
    ]);
  });

  it("provides a no-color theme object for UI-gated extensions", () => {
    expect(PLAIN_PI_EXTENSION_THEME.fg("accent", "ready")).toBe("ready");
    expect(PLAIN_PI_EXTENSION_THEME.bold("done")).toBe("done");
    expect(PLAIN_PI_EXTENSION_THEME.getThinkingBorderColor("medium")("thinking")).toBe("thinking");
  });
});

describe("Pi subagent child launcher env", () => {
  it("defaults embedded subagent launches to the Pi CLI", () => {
    const env: { PI_SUBAGENT_PI_COMMAND?: string } = {};

    ensurePiSubagentChildLauncherEnv(env);

    expect(env.PI_SUBAGENT_PI_COMMAND).toBe("pi");
  });

  it("preserves an explicit subagent launcher override", () => {
    const env = { PI_SUBAGENT_PI_COMMAND: "custom-pi-wrapper pi" };

    ensurePiSubagentChildLauncherEnv(env);

    expect(env.PI_SUBAGENT_PI_COMMAND).toBe("custom-pi-wrapper pi");
  });
});

describe("Pi subagent transcript helpers", () => {
  it("uses distinct prompt item ids for repeated prompts to the same child thread", () => {
    const first = makePiSubagentPromptItemId("child-provider-1");
    const second = makePiSubagentPromptItemId("child-provider-1");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^pi-subagent-prompt-child-provider-1-/);
    expect(second).toMatch(/^pi-subagent-prompt-child-provider-1-/);
  });
});
