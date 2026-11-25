// FILE: ProviderCommandReactor.skillMentions.test.ts
// Purpose: Covers provider-specific prompt text normalization for selected skills.
// Layer: Server orchestration tests
// Exports: Vitest cases for ProviderCommandReactor helpers.

import { describe, expect, it } from "vitest";

import { normalizeSkillMentionTextForProvider } from "./ProviderCommandReactor.ts";

describe("normalizeSkillMentionTextForProvider", () => {
  it("translates slash-selected skills to Codex dollar mentions before provider dispatch", () => {
    expect(
      normalizeSkillMentionTextForProvider({
        provider: "codex",
        messageText: "Use /check-code and /recap please",
        skills: [
          { name: "check-code", path: "/skills/check-code/SKILL.md" },
          { name: "recap", path: "/skills/recap/SKILL.md" },
        ],
      }),
    ).toBe("Use $check-code and $recap please");
  });

  it("leaves non-Codex slash skills untouched", () => {
    expect(
      normalizeSkillMentionTextForProvider({
        provider: "cursor",
        messageText: "Use /check-code please",
        skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
      }),
    ).toBe("Use /check-code please");
  });

  describe("Claude", () => {
    const claudeSkill = { name: "reviewer", path: "/home/.claude/skills/reviewer/SKILL.md" };
    const sharedCodexSkill = {
      name: "check-code",
      path: "/home/.codex/skills/check-code/SKILL.md",
    };

    it("turns a leading skill shared from another provider into a $mention", () => {
      expect(
        normalizeSkillMentionTextForProvider({
          provider: "claudeAgent",
          messageText: "/check-code fix the bugs and keep /check-code notes",
          skills: [sharedCodexSkill],
        }),
      ).toBe("$check-code fix the bugs and keep /check-code notes");
    });

    it("turns a leading .claude skill glued to punctuation into a $mention", () => {
      expect(
        normalizeSkillMentionTextForProvider({
          provider: "claudeAgent",
          messageText: "/reviewer, then fix the bugs",
          skills: [claudeSkill],
        }),
      ).toBe("$reviewer, then fix the bugs");
    });

    it("keeps a leading .claude skill and mid-sentence tokens for Claude Code", () => {
      for (const messageText of ["/reviewer fix the bugs", "Please /check-code this"]) {
        expect(
          normalizeSkillMentionTextForProvider({
            provider: "claudeAgent",
            messageText,
            skills: [claudeSkill, sharedCodexSkill],
          }),
        ).toBe(messageText);
      }
    });
  });
});
