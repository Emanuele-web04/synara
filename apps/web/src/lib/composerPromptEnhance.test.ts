import { describe, expect, it } from "vitest";

import { enhanceComposerPrompt, resolvePromptEnhanceModelSelection } from "./composerPromptEnhance";

describe("composerPromptEnhance", () => {
  it("prefers the composer model when the provider supports text generation", () => {
    expect(
      resolvePromptEnhanceModelSelection({
        composerModelSelection: { provider: "codex", model: "gpt-5.4" },
        fallbackModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      }),
    ).toEqual({ provider: "codex", model: "gpt-5.4" });
  });

  it("falls back when the composer provider cannot do text generation", () => {
    expect(
      resolvePromptEnhanceModelSelection({
        composerModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        fallbackModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      }),
    ).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
  });

  it("calls enhancePrompt with the resolved model selection", async () => {
    const enhancePrompt = async (input: {
      cwd: string;
      prompt: string;
      textGenerationModelSelection?: { provider: string; model: string };
    }) => {
      expect(input.cwd).toBe("/tmp/project");
      expect(input.prompt).toBe("fix the bug");
      expect(input.textGenerationModelSelection).toEqual({
        provider: "cursor",
        model: "gpt-5.4",
      });
      return { enhancedPrompt: "Investigate and fix the reported bug." };
    };

    await expect(
      enhanceComposerPrompt({
        cwd: "/tmp/project",
        prompt: "fix the bug",
        enhancePrompt,
        composerModelSelection: { provider: "cursor", model: "gpt-5.4" },
        fallbackModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      }),
    ).resolves.toBe("Investigate and fix the reported bug.");
  });
});
