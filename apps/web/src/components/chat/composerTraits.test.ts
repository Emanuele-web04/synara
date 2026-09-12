import { describe, expect, it } from "vitest";

import {
  getComposerTraitSelection,
  planComposerEffortChange,
  resolveComposerEffortLadderIndex,
} from "./composerTraits";

describe("planComposerEffortChange", () => {
  it("patches the provider's effort option for plain ladder levels", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "", {
      reasoningEffort: "medium",
    });

    expect(
      planComposerEffortChange({ provider: "codex", selection, prompt: "", value: "xhigh" }),
    ).toEqual({ kind: "options", patch: { reasoningEffort: "xhigh" } });
    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection: getComposerTraitSelection("claudeAgent", "claude-opus-5", "", undefined),
        prompt: "",
        value: "max",
      }),
    ).toEqual({ kind: "options", patch: { effort: "max" } });
  });

  it("rewrites the prompt for prompt-injected levels", () => {
    const selection = getComposerTraitSelection("claudeAgent", "claude-opus-4-8", "", undefined);

    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection,
        prompt: "",
        value: "ultrathink",
      }),
    ).toEqual({ kind: "prompt", prompt: "Ultrathink:\n" });
    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection,
        prompt: "Fix the flaky test",
        value: "ultrathink",
      }),
    ).toEqual({ kind: "prompt", prompt: "Ultrathink:\nFix the flaky test" });
  });

  it("ignores changes while Ultrathink pins the effort and for unknown values", () => {
    const pinned = getComposerTraitSelection(
      "claudeAgent",
      "claude-opus-4-8",
      "Ultrathink:\nGo",
      undefined,
    );
    expect(
      planComposerEffortChange({
        provider: "claudeAgent",
        selection: pinned,
        prompt: "Ultrathink:\nGo",
        value: "low",
      }),
    ).toBeNull();

    const free = getComposerTraitSelection("codex", "gpt-5.5", "", undefined);
    expect(
      planComposerEffortChange({ provider: "codex", selection: free, prompt: "", value: "turbo" }),
    ).toBeNull();
    expect(
      planComposerEffortChange({ provider: "codex", selection: free, prompt: "", value: "" }),
    ).toBeNull();
  });
});

describe("resolveComposerEffortLadderIndex", () => {
  it("follows the selected effort and falls back to the first stop", () => {
    const selection = getComposerTraitSelection("codex", "gpt-5.5", "", {
      reasoningEffort: "high",
    });
    expect(resolveComposerEffortLadderIndex(selection)).toBe(
      selection.effortLevels.findIndex((level) => level.value === "high"),
    );
    expect(resolveComposerEffortLadderIndex({ ...selection, effort: "unknown" })).toBe(0);
  });

  it("rests on the prompt-injected stop while Ultrathink pins the ladder", () => {
    const selection = getComposerTraitSelection(
      "claudeAgent",
      "claude-opus-4-8",
      "Ultrathink:\nGo",
      undefined,
    );
    expect(selection.ultrathinkPromptControlled).toBe(true);
    expect(resolveComposerEffortLadderIndex(selection)).toBe(
      selection.effortLevels.findIndex((level) => level.value === "ultrathink"),
    );
  });
});
