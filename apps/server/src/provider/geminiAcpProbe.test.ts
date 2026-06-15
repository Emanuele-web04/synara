import { describe, expect, it } from "vitest";

import {
  buildGeminiProbeEnv,
  isGeminiOAuthBrowserPrompt,
  normalizeGeminiCapabilityProbeResult,
} from "./geminiAcpProbe";

describe("buildGeminiProbeEnv", () => {
  it("suppresses browser auth flows for health probes", () => {
    expect(buildGeminiProbeEnv({ PATH: "/bin", CI: "false" })).toMatchObject({
      PATH: "/bin",
      NO_BROWSER: "true",
      BROWSER: "www-browser",
      CI: "true",
      DEBIAN_FRONTEND: "noninteractive",
    });
  });
});

describe("isGeminiOAuthBrowserPrompt", () => {
  it("detects Gemini OAuth browser output", () => {
    expect(isGeminiOAuthBrowserPrompt("Opening your browser for OAuth sign-in...")).toBe(true);
    expect(
      isGeminiOAuthBrowserPrompt(
        "https://accounts.google.com/v3/signin/accountchooser?client_id=x",
      ),
    ).toBe(true);
  });

  it("ignores ordinary ACP output", () => {
    expect(isGeminiOAuthBrowserPrompt('{"jsonrpc":"2.0","id":1,"result":{}}')).toBe(false);
  });
});

describe("normalizeGeminiCapabilityProbeResult", () => {
  it("treats authenticated ACP sessions without model discovery as ready", () => {
    expect(
      normalizeGeminiCapabilityProbeResult({
        status: "warning",
        auth: { status: "authenticated" },
        models: [],
        message:
          "Gemini CLI is installed, but Synara could not verify authentication or discover models. Gemini ACP session started, but it did not report any available models.",
      }),
    ).toEqual({
      status: "ready",
      auth: { status: "authenticated" },
      models: [],
      message:
        "Gemini CLI is installed and authenticated, but it did not report any available models. Synara will use its built-in Gemini model list.",
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
        "Gemini CLI is installed, but Synara could not verify authentication or discover models. Timed out while starting Gemini ACP session.",
    };

    expect(normalizeGeminiCapabilityProbeResult(result)).toEqual(result);
  });
});
