import { describe, expect, it } from "vitest";

import {
  PROJECT_BOT_HEARTBEAT_PROMPT,
  PROJECT_BOT_PLAYBOOK,
  PROJECT_BOT_PLAYBOOK_PATH,
  PROJECT_BOT_WATCH_RULES,
} from "./projectBotPlaybook.ts";

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
    expect(PROJECT_BOT_PLAYBOOK).toContain("report in this chat");
    expect(PROJECT_BOT_PLAYBOOK).toContain("Never say you did not wait");
    expect(PROJECT_BOT_PLAYBOOK).toContain("inbox/<threadId>/report.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("The worker does not have to remember a tool");
  });

  it("tells heartbeat wakes to report in chat instead of asking for a goal", () => {
    expect(PROJECT_BOT_HEARTBEAT_PROMPT).toContain("reply in this chat");
    expect(PROJECT_BOT_HEARTBEAT_PROMPT).toContain("Do not ask the user to start a goal");
    expect(PROJECT_BOT_WATCH_RULES).toContain("Do not say you will not wait");
  });
});
