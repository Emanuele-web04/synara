// Visible measurement semantics: measured zero survives while absent field coverage stays unknown.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnBreakdownTable } from "./TurnBreakdownTable";

describe("turn measurement display", () => {
  it("renders token fields independently and does not invent legacy token coverage", () => {
    const row = {
      provider: "codex",
      model: "gpt-6-sol",
      effort: "high",
      interactionMode: "other",
      runtimeMode: "other",
      origin: "other",
      turns: 2,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      meanDurationMs: null,
      meanInputTokens: 0,
      meanOutputTokens: null,
      inputTokens: 0,
      inputSamples: 1,
      outputTokens: 0,
      outputSamples: 0,
      cachedInputTokens: 2,
      cachedInputSamples: 1,
    };
    const measured = renderToStaticMarkup(<TurnBreakdownTable rows={[row]} />);
    expect(measured).toContain("0 / Unknown / 2");
    expect(measured).toContain("1 / 0 / 1");
    const { inputSamples, outputSamples, cachedInputSamples, ...legacy } = row;
    const sampled = renderToStaticMarkup(<TurnBreakdownTable rows={[legacy]} legacy />);
    expect(sampled).toContain("Unknown / Unknown / Unknown");
    expect(sampled).not.toContain("0 / Unknown / 2");
  });
});
