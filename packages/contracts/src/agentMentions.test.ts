import { describe, expect, it } from "vitest";

import {
  getAgentMentionAliases,
  getAgentMentionAutocompleteAliases,
  resolveAgentAlias,
} from "./agentMentions";

describe("agentMentions", () => {
  it("shows one preferred alias per Codex model in autocomplete", () => {
    expect(getAgentMentionAutocompleteAliases("codex")).toEqual([
      {
        alias: "5.4",
        provider: "codex",
        kind: "model",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        color: "violet",
      },
      {
        alias: "mini",
        provider: "codex",
        kind: "model",
        model: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        color: "fuchsia",
      },
      {
        alias: "5.3-codex",
        provider: "codex",
        kind: "model",
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        color: "teal",
      },
      {
        alias: "spark",
        provider: "codex",
        kind: "model",
        model: "gpt-5.3-codex-spark",
        displayName: "GPT-5.3 Codex Spark",
        color: "cyan",
      },
      {
        alias: "5.2",
        provider: "codex",
        kind: "model",
        model: "gpt-5.2",
        displayName: "GPT-5.2",
        color: "amber",
      },
      {
        alias: "5.2-codex",
        provider: "codex",
        kind: "model",
        model: "gpt-5.2-codex",
        displayName: "GPT-5.2 Codex",
        color: "orange",
      },
    ]);
  });

  it("shows provider-specific Claude subagents in autocomplete", () => {
    expect(getAgentMentionAutocompleteAliases("claudeAgent")).toEqual([
      {
        alias: "explore",
        provider: "claudeAgent",
        kind: "claude-subagent",
        agentName: "explore",
        displayName: "Explore",
        color: "cyan",
        description:
          "Read-only codebase explorer. Use for file discovery, code search, and gathering context before implementation.",
        prompt:
          "You are a focused codebase exploration specialist. Search broadly, gather the most relevant findings, and return a concise summary with the key files, evidence, and risks. Do not make code changes.",
        tools: ["Read", "Grep", "Glob"],
        model: "haiku",
      },
      {
        alias: "review",
        provider: "claudeAgent",
        kind: "claude-subagent",
        agentName: "review",
        displayName: "Code Review",
        color: "amber",
        description:
          "Bug and risk reviewer. Use for code review, regression hunting, and edge-case analysis.",
        prompt:
          "You are a senior code reviewer. Focus on behavioral regressions, correctness bugs, edge cases, and missing tests. Return findings first, then open questions, then a brief summary.",
        tools: ["Read", "Grep", "Glob"],
        model: "sonnet",
      },
      {
        alias: "build",
        provider: "claudeAgent",
        kind: "claude-subagent",
        agentName: "build",
        displayName: "Implementer",
        color: "violet",
        description:
          "Implementation teammate. Use for scoped code changes, debugging, and hands-on execution tasks.",
        prompt:
          "You are an implementation-focused coding teammate. Make targeted changes, validate assumptions with the available tools, and return a short implementation summary plus any remaining risks.",
        tools: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit"],
        model: "sonnet",
      },
      {
        alias: "plan",
        provider: "claudeAgent",
        kind: "claude-subagent",
        agentName: "plan",
        displayName: "Planner",
        color: "fuchsia",
        description:
          "Planning specialist. Use for breaking work into steps, evaluating approaches, and preparing execution plans.",
        prompt:
          "You are a planning specialist. Clarify goals, evaluate tradeoffs, identify edge cases, and return a concrete ordered plan with the main risks called out explicitly.",
        tools: ["Read", "Grep", "Glob", "TodoWrite"],
        model: "sonnet",
      },
    ]);
  });

  it("keeps compatibility aliases resolvable even when hidden from autocomplete", () => {
    const codexCompatAlias = resolveAgentAlias("codex", "codex");
    const claudeCompatAlias = resolveAgentAlias("reviewer", "claudeAgent");

    expect(getAgentMentionAliases("codex").map(({ alias }) => alias)).toContain("codex");
    expect(getAgentMentionAliases("codex").map(({ alias }) => alias)).toContain("5.3-spark");
    expect(getAgentMentionAliases("codex").map(({ alias }) => alias)).toContain("5.4-mini");
    expect(getAgentMentionAliases("claudeAgent").map(({ alias }) => alias)).toContain("reviewer");
    expect(getAgentMentionAliases("claudeAgent").map(({ alias }) => alias)).toContain("planner");

    expect(codexCompatAlias?.kind).toBe("model");
    expect(codexCompatAlias?.provider).toBe("codex");
    expect(codexCompatAlias?.kind === "model" ? codexCompatAlias.model : null).toBe(
      "gpt-5.3-codex",
    );
    expect(claudeCompatAlias?.kind).toBe("claude-subagent");
    expect(claudeCompatAlias?.provider).toBe("claudeAgent");
    expect(claudeCompatAlias?.kind === "claude-subagent" ? claudeCompatAlias.agentName : null).toBe(
      "review",
    );
  });
});
