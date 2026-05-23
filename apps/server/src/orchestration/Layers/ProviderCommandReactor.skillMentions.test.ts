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
});
