// FILE: composerMentions.test.ts
// Purpose: Lock down composer mention token parsing plus outgoing skill/plugin reference filtering.
// Layer: Web composer helper tests

import { describe, expect, it } from "vitest";

import {
  createComposerMentionTokenRegex,
  extractComposerMentionPath,
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
  formatComposerMentionToken,
  isThreadProviderMentionReference,
  resolveMentionChipKind,
} from "./composerMentions";

function parseMentionToken(token: string): string {
  const match = createComposerMentionTokenRegex({
    includeTrailingTokenAtEnd: true,
    global: false,
  }).exec(token);
  if (!match) {
    throw new Error(`Expected a valid composer mention token: ${token}`);
  }
  return extractComposerMentionPath(match);
}

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

  it("serializes and reconciles a quoted thread token with its authoritative thread id", () => {
    const mention = { name: "Release planning", path: "thread://thread-123" };
    const token = formatComposerMentionToken(mention.name);

    expect(token).toBe('@"Release planning"');
    expect(isThreadProviderMentionReference(mention)).toBe(true);
    expect(filterPromptProviderMentionReferences(`Compare ${token} please`, [mention])).toEqual([
      mention,
    ]);
    expect(filterPromptProviderMentionReferences("Compare the plan please", [mention])).toEqual([]);
    expect(resolveMentionChipKind(mention.name, { mentionReferences: [mention] })).toBe("thread");
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

  it("quotes paths with parentheses so they stay one mention token (#351)", () => {
    expect(formatComposerMentionToken("/Users/me/Mac (2)/Projects")).toBe(
      '@"/Users/me/Mac (2)/Projects"',
    );
    expect(formatComposerMentionToken("/Users/me/Happy Dropbox/Mac (2)/app")).toBe(
      '@"/Users/me/Happy Dropbox/Mac (2)/app"',
    );
  });

  it("leaves simple paths unquoted", () => {
    expect(formatComposerMentionToken("/Users/me/projects/app")).toBe("@/Users/me/projects/app");
  });

  it.each([
    "/Users/me/Happy Dropbox/Mac (2)/app",
    String.raw`C:\Users\me\Project (2)`,
    '/tmp/A "B"/repo',
    "/Users/me/@scope/package",
    " /tmp/path with edge whitespace ",
  ])("round-trips quoted path bytes for %s", (path) => {
    expect(parseMentionToken(formatComposerMentionToken(path))).toBe(path);
  });

  it("escapes embedded quotes and backslashes in quoted tokens", () => {
    expect(formatComposerMentionToken(String.raw`C:\A "B"`)).toBe(String.raw`@"C:\\A \"B\""`);
  });

  it("parses an unclosed quote followed by a backslash run in linear time (no ReDoS)", () => {
    // Regression guard: with an ambiguous escape alternation this backtracks
    // exponentially and the test times out instead of finishing instantly.
    const attack = `@"${"\\".repeat(512)}x no closing quote`;
    const matches = [
      ...attack.matchAll(createComposerMentionTokenRegex({ includeTrailingTokenAtEnd: true })),
    ];
    // Without a closing quote only the unquoted fallback token matches.
    expect(matches.map((match) => extractComposerMentionPath(match))).toEqual([
      `"${"\\".repeat(512)}x`,
    ]);
  });
});
