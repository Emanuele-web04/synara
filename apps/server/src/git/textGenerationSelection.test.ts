import { describe, expect, it } from "vitest";

import { resolveTextGenerationInputForSelection } from "./textGenerationSelection.ts";

describe("resolveTextGenerationInputForSelection", () => {
  it("routes Claude provider instances directly to text generation", () => {
    expect(
      resolveTextGenerationInputForSelection(
        {
          instanceId: "claude_work",
          model: "claude-opus-4-6",
        },
        {
          claudeAgent: {
            homePath: "/tmp/claude-work",
            environment: { ANTHROPIC_AUTH_TOKEN: "token" },
          },
        },
      ),
    ).toEqual({
      modelSelection: {
        instanceId: "claude_work",
        model: "claude-opus-4-6",
      },
      providerOptions: {
        claudeAgent: {
          homePath: "/tmp/claude-work",
          environment: { ANTHROPIC_AUTH_TOKEN: "token" },
        },
      },
    });
  });
});
