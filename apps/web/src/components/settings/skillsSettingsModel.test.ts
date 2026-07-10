// FILE: skillsSettingsModel.test.ts
// Purpose: Locks down Settings -> Skills grouping for duplicate provider skill copies.
// Layer: Web settings logic tests

import type { ProviderSkillDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildSettingsSkillGroups, buildSettingsSkillSections } from "./skillsSettingsModel";

function skill(partial: Partial<ProviderSkillDescriptor>): ProviderSkillDescriptor {
  return {
    name: "example",
    enabled: true,
    path: "/tmp/example/SKILL.md",
    ...partial,
  };
}

describe("buildSettingsSkillGroups", () => {
  it("renders duplicate provider copies as one shared skill group", () => {
    const groups = buildSettingsSkillGroups([
      skill({
        name: "check-code",
        description: "Codex copy",
        path: "/Users/test/.codex/skills/check-code/SKILL.md",
        scope: "codex",
      }),
      skill({
        name: "check-code",
        description: "Claude copy",
        path: "/Users/test/.claude/skills/check-code/SKILL.md",
        scope: "claude",
      }),
      skill({
        name: "check-code",
        description: "Gemini copy",
        path: "/Users/test/.gemini/skills/check-code/SKILL.md",
        scope: "gemini",
      }),
      skill({
        name: "cursor-only",
        path: "/Users/test/.cursor/skills/cursor-only/SKILL.md",
        scope: "cursor",
      }),
    ]);

    const shared = groups.find((group) => group.key === "check-code");
    expect(shared?.section).toBe("shared");
    expect(shared?.providers).toEqual(["codex", "claudeAgent", "gemini"]);
    expect(shared?.sources.map((source) => source.origin)).toEqual(["codex", "claude", "gemini"]);
    expect(shared?.sources.map((source) => source.skill.path)).toEqual([
      "/Users/test/.codex/skills/check-code/SKILL.md",
      "/Users/test/.claude/skills/check-code/SKILL.md",
      "/Users/test/.gemini/skills/check-code/SKILL.md",
    ]);

    const cursorOnly = groups.find((group) => group.key === "cursor-only");
    expect(cursorOnly?.section).toBe("cursor");
    expect(cursorOnly?.providers).toEqual(["cursor"]);
  });

  it("does not show provider icons for shared alias-only skills", () => {
    const groups = buildSettingsSkillGroups([
      skill({
        name: "portable-review",
        description: "Shared standard copy",
        path: "/Users/test/.agents/skills/portable-review/SKILL.md",
        scope: "agents",
      }),
    ]);

    expect(groups[0]?.providers).toEqual([]);
    expect(groups[0]?.section).toBe("agents");
  });
});

describe("buildSettingsSkillSections", () => {
  it("places shared skill groups before provider-only sections", () => {
    const sections = buildSettingsSkillSections([
      skill({
        name: "logic-consolidator",
        path: "/Users/test/.codex/skills/logic-consolidator/SKILL.md",
        scope: "codex",
      }),
      skill({
        name: "logic-consolidator",
        path: "/Users/test/.claude/skills/logic-consolidator/SKILL.md",
        scope: "claude",
      }),
      skill({
        name: "cursor-only",
        path: "/Users/test/.cursor/skills/cursor-only/SKILL.md",
        scope: "cursor",
      }),
    ]);

    expect(sections.map((section) => section.title)).toEqual(["Shared skills", "From Cursor"]);
    expect(sections[0]?.groups.map((group) => group.key)).toEqual(["logic-consolidator"]);
  });
});
