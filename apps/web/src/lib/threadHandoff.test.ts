import { type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { resolveHandoffTargetProvider, resolveThreadHandoffModelSelection } from "./threadHandoff";

describe("threadHandoff", () => {
  it("cycles handoff targets across all supported providers", () => {
    expect(resolveHandoffTargetProvider("codex")).toBe("claudeAgent");
    expect(resolveHandoffTargetProvider("claudeAgent")).toBe("gemini");
    expect(resolveHandoffTargetProvider("gemini")).toBe("codex");
  });

  it("prefers sticky model selection for the resolved handoff target", () => {
    const stickySelection = {
      provider: "gemini",
      model: "gemini-2.5-pro",
    } satisfies ModelSelection;

    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        },
        projectDefaultModelSelection: {
          provider: "gemini",
          model: "gemini-3.1-pro-preview",
        },
        stickyModelSelectionByProvider: {
          gemini: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
  });

  it("falls back to the resolved provider default model when no sticky or project default exists", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "gemini",
            model: "gemini-2.5-pro",
          },
        },
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
  });
});
