import { ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  BOT_TEMPLATES,
  botScopePathMatches,
  economyModelSlug,
  filesOutsideBotScope,
  mascotForIndex,
  sentenceList,
  suggestBotDrafts,
} from "./bots";

const projectId = ProjectId.makeUnsafe("project-1");

describe("suggestBotDrafts", () => {
  it("suggests Frontend, Backend and CI from folders, at most three", () => {
    const scan = suggestBotDrafts({
      projectId,
      projectName: "shop",
      topFolders: ["apps", "server", "node_modules", ".git", "docs"],
      appsFolders: ["web", "ios"],
      hasGitHubWorkflows: true,
      takenNames: [],
    });
    expect(scan.drafts.map((draft) => draft.name)).toEqual(["Frontend", "Backend", "Mobile"]);
    expect(scan.drafts[0]!.scope).toEqual({ projects: [projectId], paths: ["apps/web/**"] });
    expect(scan.found).toEqual(["apps/web", "server", "apps/ios"]);
    expect(scan.message).toBe("shop has apps/web, server and apps/ios. Set up bots for them?");
  });

  it("names a duplicate after the project and falls back to one whole-project bot", () => {
    const named = suggestBotDrafts({
      projectId,
      projectName: "shop",
      topFolders: ["web"],
      appsFolders: [],
      hasGitHubWorkflows: false,
      takenNames: ["frontend"],
    });
    expect(named.drafts[0]!.name).toBe("Frontend · shop");

    const whole = suggestBotDrafts({
      projectId,
      projectName: "notes",
      topFolders: ["src"],
      appsFolders: [],
      hasGitHubWorkflows: false,
      takenNames: [],
    });
    expect(whole.drafts).toHaveLength(1);
    expect(whole.drafts[0]!.name).toBe("notes");
    expect(whole.drafts[0]!.scope.paths).toEqual([]);
    expect(whole.message).toBe("notes looks like one project. Set up a bot for it?");
  });
});

describe("bot scope paths", () => {
  it("matches folders, single and double stars", () => {
    expect(botScopePathMatches("apps/web/src/App.tsx", ["apps/web/**"])).toBe(true);
    expect(botScopePathMatches("apps/web/src/App.tsx", ["apps/web"])).toBe(true);
    expect(botScopePathMatches("apps/server/a.ts", ["apps/web/**"])).toBe(false);
    expect(botScopePathMatches("src/a.test.ts", ["**/*.test.ts"])).toBe(true);
    expect(botScopePathMatches("a.test.ts", ["**/*.test.ts"])).toBe(true);
    expect(botScopePathMatches("src/deep/a.ts", ["src/*.ts"])).toBe(false);
    expect(botScopePathMatches("anything", [])).toBe(true);
  });

  it("lists the files outside the scope", () => {
    expect(
      filesOutsideBotScope(["apps/web/a.ts", "packages/x/b.ts", "apps/web/c.css"], ["apps/web/**"]),
    ).toEqual(["packages/x/b.ts"]);
    expect(filesOutsideBotScope(["a"], [])).toEqual([]);
  });
});

describe("economy models and mascots", () => {
  it("picks Luna on Codex and Sonnet on Claude, nothing elsewhere", () => {
    expect(economyModelSlug("codex", ["gpt-6-astra", "gpt-6-luna"])).toBe("gpt-6-luna");
    expect(economyModelSlug("codex", ["gpt-5.4", "gpt-5.4-mini"])).toBe("gpt-5.4-mini");
    expect(economyModelSlug("claudeAgent", ["claude-opus-5-5", "claude-sonnet-5"])).toBe(
      "claude-sonnet-5",
    );
    expect(economyModelSlug("cursor", ["auto"])).toBeNull();
  });

  it("cycles the palette and keeps templates valid", () => {
    expect(mascotForIndex(0)).toEqual({ shape: "circle", color: "#1a80fa" });
    expect(mascotForIndex(9).shape).toBe("circle");
    expect(new Set(BOT_TEMPLATES.map((template) => template.name)).size).toBe(BOT_TEMPLATES.length);
    expect(sentenceList(["a", "b", "c"])).toBe("a, b and c");
  });
});
