import { describe, expect, it } from "vitest";

import {
  normalizeHermesCapabilityProbeResult,
  parseHermesAcpProbeError,
  parseHermesDiscoveredModels,
} from "./hermesAcpProbe.ts";

describe("parseHermesDiscoveredModels", () => {
  it("parses ACP availableModels and upstream provider ids", () => {
    expect(
      parseHermesDiscoveredModels({
        models: {
          currentModelId: "opencode-go:deepseek-v4-flash",
          availableModels: [
            {
              modelId: "opencode-go:deepseek-v4-flash",
              name: "deepseek-v4-flash",
              description: "Provider: OpenCode Go • current",
            },
            {
              modelId: "opencode-go:minimax-m2.7",
              name: "minimax-m2.7",
            },
          ],
        },
      }),
    ).toEqual([
      {
        slug: "opencode-go:deepseek-v4-flash",
        name: "deepseek-v4-flash",
        upstreamProviderId: "opencode-go",
        upstreamProviderName: "OpenCode Go",
      },
      {
        slug: "opencode-go:minimax-m2.7",
        name: "minimax-m2.7",
        upstreamProviderId: "opencode-go",
        upstreamProviderName: "OpenCode Go",
      },
    ]);
  });
});

describe("parseHermesAcpProbeError", () => {
  it("marks authentication failures as unauthenticated", () => {
    expect(parseHermesAcpProbeError({ message: "Authentication required." })).toEqual({
      status: "error",
      auth: { status: "unauthenticated" },
      message: expect.stringContaining("Hermes is not authenticated"),
    });
  });
});

describe("normalizeHermesCapabilityProbeResult", () => {
  it("treats authenticated sessions without models as ready with fallback message", () => {
    expect(
      normalizeHermesCapabilityProbeResult({
        status: "warning",
        auth: { status: "authenticated" },
        models: [],
      }),
    ).toEqual({
      status: "ready",
      auth: { status: "authenticated" },
      models: [],
      message: expect.stringContaining("profile defaults"),
    });
  });
});
