import { describe, expect, it } from "vitest";

import { normalizeGeminiCapabilityProbeResult } from "./geminiAcpProbe";

describe("normalizeGeminiCapabilityProbeResult", () => {
  it("treats authenticated ACP sessions without model discovery as ready", () => {
    expect(
      normalizeGeminiCapabilityProbeResult({
        status: "warning",
        auth: { status: "authenticated" },
        models: [],
        message:
          "Gemini CLI is installed, but DP Code could not verify authentication or discover models. Gemini ACP session started, but it did not report any available models.",
      }),
    ).toEqual({
      status: "ready",
      auth: { status: "authenticated" },
      models: [],
      message:
        "Gemini CLI is installed and authenticated, but it did not report any available models. DP Code will use its built-in Gemini model list.",
    });
  });

  it("preserves successful model discovery results", () => {
    const result = {
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      models: [{ slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
      message: "Gemini CLI is installed and authenticated.",
    };

    expect(normalizeGeminiCapabilityProbeResult(result)).toEqual(result);
  });

  it("preserves warnings when authentication is still unknown", () => {
    const result = {
      status: "warning" as const,
      auth: { status: "unknown" as const },
      models: [],
      message:
        "Gemini CLI is installed, but DP Code could not verify authentication or discover models. Timed out while starting Gemini ACP session.",
    };

    expect(normalizeGeminiCapabilityProbeResult(result)).toEqual(result);
  });
});
