import { describe, expect, it } from "vitest";

import {
  buildGeminiProbeEnv,
  buildGeminiProbeSessionNewParams,
  captureGeminiAcpProbeLogFailure,
  isGeminiCodeAssistMigrationAuthFailure,
  isGeminiOAuthBrowserPrompt,
  normalizeGeminiCapabilityProbeResult,
  parseGeminiAcpProbeError,
  parseGeminiAcpProbeLogFailure,
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

describe("buildGeminiProbeSessionNewParams", () => {
  it("keeps capability probes free of session MCP side effects", () => {
    expect(buildGeminiProbeSessionNewParams("/workspace")).toEqual({
      cwd: "/workspace",
      mcpServers: [],
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

describe("isGeminiCodeAssistMigrationAuthFailure", () => {
  it("detects the Gemini Code Assist to Antigravity migration message", () => {
    expect(
      isGeminiCodeAssistMigrationAuthFailure(
        "Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products.",
      ),
    ).toBe(true);
  });

  it("detects ACP loadCodeAssist premature-close auth failures", () => {
    expect(
      isGeminiCodeAssistMigrationAuthFailure(
        "Invalid response body while trying to fetch https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist: Premature close",
      ),
    ).toBe(true);
  });

  it("ignores unrelated transport errors", () => {
    expect(isGeminiCodeAssistMigrationAuthFailure("Network request failed: Premature close")).toBe(
      false,
    );
  });

  it("ignores non-loadCodeAssist cloudcode premature-close failures", () => {
    expect(
      isGeminiCodeAssistMigrationAuthFailure(
        "Invalid response body while trying to fetch https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse: Premature close",
      ),
    ).toBe(false);
  });
});

describe("parseGeminiAcpProbeError", () => {
  it("returns actionable auth guidance for the Antigravity migration failure", () => {
    const parsed = parseGeminiAcpProbeError({
      message:
        "Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products.",
    });

    expect(parsed.status).toBe("error");
    expect(parsed.auth.status).toBe("unauthenticated");
    expect(parsed.message).toContain("Antigravity");
    expect(parsed.message).toContain("GEMINI_API_KEY");
    expect(parsed.message).toContain("GOOGLE_GENAI_USE_VERTEXAI");
  });

  it("maps the issue #224 loadCodeAssist premature close to auth guidance", () => {
    const parsed = parseGeminiAcpProbeError({
      code: -32_000,
      message:
        "Invalid response body while trying to fetch https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist: Premature close",
    });

    expect(parsed.status).toBe("error");
    expect(parsed.auth.status).toBe("unauthenticated");
    expect(parsed.message).toContain("Antigravity");
    expect(parsed.message).toContain("Vertex AI");
  });

  it("adds setup guidance to generic Gemini auth failures", () => {
    const parsed = parseGeminiAcpProbeError({
      message: "API key is missing",
    });

    expect(parsed.status).toBe("error");
    expect(parsed.auth.status).toBe("unauthenticated");
    expect(parsed.message).toContain("API key is missing");
    expect(parsed.message).toContain("~/.gemini/.env");
  });
});

describe("parseGeminiAcpProbeLogFailure", () => {
  it("maps captured loadCodeAssist premature-close output to auth guidance", () => {
    const parsed = parseGeminiAcpProbeLogFailure(
      "Invalid response body while trying to fetch https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist: Premature close",
    );

    expect(parsed?.status).toBe("error");
    expect(parsed?.auth.status).toBe("unauthenticated");
    expect(parsed?.message).toContain("Antigravity");
    expect(parsed?.message).toContain("GEMINI_API_KEY");
  });

  it("maps captured generic Gemini auth output to setup guidance", () => {
    const parsed = parseGeminiAcpProbeLogFailure("API key is missing");

    expect(parsed?.status).toBe("error");
    expect(parsed?.auth.status).toBe("unauthenticated");
    expect(parsed?.message).toContain("~/.gemini/.env");
  });

  it("ignores captured non-auth process output", () => {
    expect(parseGeminiAcpProbeLogFailure("Gemini ACP exited with code 1")).toBeUndefined();
  });

  it("ignores generic configured wording in captured process output", () => {
    expect(parseGeminiAcpProbeLogFailure("forkpty: Device not configured")).toBeUndefined();
  });

  it("ignores non-loadCodeAssist cloudcode premature-close process output", () => {
    expect(
      parseGeminiAcpProbeLogFailure(
        "Invalid response body while trying to fetch https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse: Premature close",
      ),
    ).toBeUndefined();
  });
});

describe("captureGeminiAcpProbeLogFailure", () => {
  it("retains the first auth line when later stack frames are captured", () => {
    const authFailure = captureGeminiAcpProbeLogFailure(
      undefined,
      "Invalid response body while trying to fetch https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist: Premature close",
    );
    const afterStackFrame = captureGeminiAcpProbeLogFailure(
      authFailure,
      "    at async loadCodeAssist (/path/to/gemini.js:10:3)",
    );

    expect(afterStackFrame).toBe(authFailure);
    expect(afterStackFrame?.status).toBe("error");
    expect(afterStackFrame?.auth.status).toBe("unauthenticated");
    expect(afterStackFrame?.message).toContain("Antigravity");
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
