import { describe, expect, it } from "vitest";

import {
  getAgentMentionAliases,
  getAgentMentionAutocompleteAliases,
  resolveAgentAlias,
} from "./agentMentions";

describe("agentMentions", () => {
  it("shows one preferred alias per model in autocomplete", () => {
    expect(getAgentMentionAutocompleteAliases()).toEqual([
      {
        alias: "5.2",
        model: "gpt-5.2",
        displayName: "GPT-5.2",
        color: "amber",
      },
      {
        alias: "5.2-codex",
        model: "gpt-5.2-codex",
        displayName: "GPT-5.2 Codex",
        color: "orange",
      },
      {
        alias: "codex",
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        color: "teal",
      },
      {
        alias: "spark",
        model: "gpt-5.3-codex-spark",
        displayName: "GPT-5.3 Spark",
        color: "cyan",
      },
      {
        alias: "5.4",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        color: "violet",
      },
      {
        alias: "mini",
        model: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        color: "fuchsia",
      },
    ]);
  });

  it("keeps compatibility aliases resolvable even when hidden from autocomplete", () => {
    expect(getAgentMentionAliases().map(({ alias }) => alias)).toContain("5.3");
    expect(getAgentMentionAliases().map(({ alias }) => alias)).toContain("5.3-spark");
    expect(getAgentMentionAliases().map(({ alias }) => alias)).toContain("5.4-mini");

    expect(resolveAgentAlias("5.3")?.model).toBe("gpt-5.3-codex");
    expect(resolveAgentAlias("5.3-spark")?.model).toBe("gpt-5.3-codex-spark");
    expect(resolveAgentAlias("5.4-mini")?.model).toBe("gpt-5.4-mini");
  });
});
