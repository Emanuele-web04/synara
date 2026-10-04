import { describe, expect, it } from "vitest";

import {
  formatModelSpeedEffort,
  formatModelSpeedModelName,
  formatModelSpeedModelSummary,
  formatModelSpeedSummary,
} from "./ModelSpeedLabel";

describe("formatModelSpeedSummary", () => {
  it("names the model with the picker's display name and tags fast mode", () => {
    expect(
      formatModelSpeedSummary(93.2, [
        {
          outputTokens: 1_200,
          generationMs: 12_900,
          provider: "claudeAgent",
          model: "claude-opus-5-5",
          fastMode: true,
          effort: "high",
        },
      ]),
    ).toBe("93 tok/s · Claude Opus 5.5 · Fast");
    expect(
      formatModelSpeedSummary(80, [
        { outputTokens: 800, generationMs: 10_000, provider: "codex", model: "gpt-5-codex" },
      ]),
    ).toBe("80 tok/s · GPT-5 Codex");
  });

  it("does not repeat Fast for a dedicated fast slug", () => {
    expect(
      formatModelSpeedSummary(200, [
        {
          outputTokens: 2_000,
          generationMs: 10_000,
          provider: "codex",
          model: "gpt-5.5-fast",
          fastMode: true,
        },
      ]),
    ).toBe("200 tok/s · GPT-5.5 Fast");
  });

  it("shows only the combined rate when folded turns used different models", () => {
    expect(
      formatModelSpeedSummary(60, [
        { outputTokens: 1_000, generationMs: 10_000, provider: "codex", model: "gpt-5-codex" },
        {
          outputTokens: 200,
          generationMs: 10_000,
          provider: "codex",
          model: "gpt-5-codex",
          fastMode: true,
        },
      ]),
    ).toBe("60 tok/s");
  });

  it("falls back to the generic display name without a provider", () => {
    expect(formatModelSpeedModelName({ model: "claude-opus-4-8" })).toBe("Claude Opus 4.8");
    expect(formatModelSpeedModelName({})).toBeNull();
  });
});

describe("formatModelSpeedEffort", () => {
  it("uses the picker's effort label", () => {
    expect(formatModelSpeedEffort({ provider: "codex", model: "gpt-5.4", effort: "high" })).toBe(
      "High",
    );
    expect(formatModelSpeedEffort({ effort: "xhigh" })).toBe("Extra High");
    expect(formatModelSpeedEffort({ provider: "codex", model: "gpt-5.4" })).toBeNull();
  });
});

describe("formatModelSpeedModelSummary", () => {
  it("returns the model part on its own so the meter can put it on its own line", () => {
    expect(
      formatModelSpeedModelSummary([
        {
          outputTokens: 1_000,
          generationMs: 10_000,
          provider: "claudeAgent",
          model: "claude-opus-5-5",
          fastMode: true,
        },
      ]),
    ).toBe("Claude Opus 5.5 · Fast");
    expect(formatModelSpeedModelSummary([{ outputTokens: 1_000, generationMs: 10_000 }])).toBe(
      null,
    );
  });
});
