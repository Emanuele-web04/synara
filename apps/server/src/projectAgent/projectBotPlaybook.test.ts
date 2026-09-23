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

  it("teaches how to keep the group markdown files", () => {
    expect(PROJECT_BOT_PLAYBOOK).toContain("instructions.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("decisions.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("overview.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("archived.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("memory/MEMORY.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("expected revision");
    expect(PROJECT_BOT_PLAYBOOK).toContain("clickable link");
    expect(PROJECT_BOT_PLAYBOOK).toContain("report in this chat");
    expect(PROJECT_BOT_PLAYBOOK).toContain("Never say you did not wait");
    expect(PROJECT_BOT_PLAYBOOK).toContain("inbox/<threadId>/report.md");
    expect(PROJECT_BOT_PLAYBOOK).toContain("The thread does not have to remember a tool");
  });

  it("teaches the group tools and routing rules", () => {
    expect(PROJECT_BOT_PLAYBOOK).toContain("synara_project_remember");
    expect(PROJECT_BOT_PLAYBOOK).toContain("synara_project_forget");
    expect(PROJECT_BOT_PLAYBOOK).toContain("synara_project_library_add");
    expect(PROJECT_BOT_PLAYBOOK).toContain("synara_project_list_threads");
    expect(PROJECT_BOT_PLAYBOOK).toContain("synara_send_message");
    expect(PROJECT_BOT_PLAYBOOK).toContain("synara_create_thread");
    expect(PROJECT_BOT_PLAYBOOK).toContain("synara_create_threads");
    expect(PROJECT_BOT_PLAYBOOK).toContain("linked repository");
    expect(PROJECT_BOT_PLAYBOOK).toContain("Suggested threads");
  });

  it("requires every part of a request to be dispatched before the turn ends", () => {
    expect(PROJECT_BOT_PLAYBOOK).toContain("## Completing a request");
    expect(PROJECT_BOT_PLAYBOOK).toContain("Every part of a user message counts as asked-for work");
    expect(PROJECT_BOT_PLAYBOOK).toContain(
      "Never end a turn with work you promised but did not dispatch",
    );
    expect(PROJECT_BOT_PLAYBOOK).toContain("before you finish the turn");
    expect(PROJECT_BOT_PLAYBOOK).toContain("forgotten preference");
  });

  it("routes repository work to threads instead of doing it itself", () => {
    expect(PROJECT_BOT_PLAYBOOK).toContain("You do not write application code yourself");
    expect(PROJECT_BOT_PLAYBOOK).toContain("goes to a thread, not to you");
  });

  it("tells heartbeat wakes to report in chat instead of asking for a goal", () => {
    expect(PROJECT_BOT_HEARTBEAT_PROMPT).toContain("reply in this chat");
    expect(PROJECT_BOT_HEARTBEAT_PROMPT).toContain("Do not ask the user to start a goal");
    expect(PROJECT_BOT_WATCH_RULES).toContain("Do not say you will not wait");
  });
});
