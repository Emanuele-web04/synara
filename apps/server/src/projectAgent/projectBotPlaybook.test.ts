import { describe, expect, it } from "vitest";

import { PROJECT_BOT_PLAYBOOK, PROJECT_BOT_PLAYBOOK_PATH } from "./projectBotPlaybook.ts";

describe("project bot playbook", () => {
  it("is a docs file the coordinator can maintain", () => {
    expect(PROJECT_BOT_PLAYBOOK_PATH).toBe("docs/project-bot.md");
  });

  it("teaches how to keep the project markdown files", () => {
    expect(PROJECT_BOT_PLAYBOOK).toContain("instructions.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("decisions.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("overview.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("archived.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("expected revision");
    expect(PROJECT_BOT_PLAYBOOK).toContain("clickable link");
  });
});
