// FILE: composerMentions.test.ts
// Purpose: Lock down composer mention token parsing plus outgoing skill/plugin reference filtering.
// Layer: Web composer helper tests

import { describe, expect, it } from "vitest";

import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
  formatComposerMentionToken,
  resolveMentionChipKind,
} from "./composerMentions";

describe("composer mention reference filtering", () => {
  it("does not invent plugin references for plain file or folder mentions", () => {
    expect(filterPromptProviderMentionReferences("Open @Things please", [])).toEqual([]);
  });

  it("preserves selected plugin references only while their token remains in the prompt", () => {
    const thingsPlugin = { name: "things", path: "plugin://things@openai-curated" };
    const githubPlugin = { name: "github", path: "plugin://github@openai-curated" };

    expect(
      filterPromptProviderMentionReferences("Open @Things please", [thingsPlugin, githubPlugin]),
    ).toEqual([thingsPlugin]);
  });

  it("drops selected plugin references after the matching token is removed", () => {
    const thingsPlugin = { name: "things", path: "plugin://things@openai-curated" };

    expect(
      filterPromptProviderMentionReferences("Open @src/things please", [thingsPlugin]),
    ).toEqual([]);
  });

  it("matches quoted plugin mention tokens when the plugin name contains whitespace", () => {
    const plugin = { name: "Google Drive", path: "plugin://google-drive@openai-curated" };

    expect(filterPromptProviderMentionReferences('Use @"Google Drive" please', [plugin])).toEqual([
      plugin,
    ]);
  });

  it("matches plugin mention tokens from plugin:// paths when display names differ", () => {
    const plugin = { name: "Linear Plugin", path: "plugin://linear@openai-curated" };

    expect(filterPromptProviderMentionReferences("Use @linear please", [plugin])).toEqual([plugin]);
  });

  it("resolves plugin chip kind from stored mention references", () => {
    const plugin = { name: "linear", path: "plugin://linear@openai-curated" };

    expect(resolveMentionChipKind("linear")).toBe("path");
    expect(resolveMentionChipKind("linear", { kind: "plugin" })).toBe("plugin");
    expect(resolveMentionChipKind("linear", { mentionReferences: [plugin] })).toBe("plugin");
  });

  it("keeps selected slash and dollar skills only when their prompt token remains", () => {
    const checkCode = { name: "check-code", path: "/skills/check-code/SKILL.md" };
    const refactorCode = { name: "refactor-code", path: "/skills/refactor-code/SKILL.md" };

    expect(
      filterPromptSkillReferences(
        "Use $check-code and /refactor-code",
        [checkCode, refactorCode],
        "codex",
      ),
    ).toEqual([checkCode, refactorCode]);
    expect(
      filterPromptSkillReferences("Use $check-code", [checkCode, refactorCode], "codex"),
    ).toEqual([checkCode]);
  });

  it("uses pi's explicit skill prefix when filtering pi skill references", () => {
    const skill = { name: "planner", path: "/skills/planner/SKILL.md" };

    expect(filterPromptSkillReferences("Use /planner", [skill], "pi")).toEqual([]);
    expect(filterPromptSkillReferences("Use /skill:planner", [skill], "pi")).toEqual([skill]);
  });
});

describe("formatComposerMentionToken", () => {
  it("quotes mention tokens with whitespace", () => {
    expect(formatComposerMentionToken("Google Drive")).toBe('@"Google Drive"');
  });
});
