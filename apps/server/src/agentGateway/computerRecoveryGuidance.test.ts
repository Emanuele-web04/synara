import { describe, expect, it } from "vitest";

import {
  COMPUTER_HELP_INDEX,
  COMPUTER_HELP_SECTIONS,
  COMPUTER_HELP_TOPICS,
  computerToolInstructions,
} from "./computerGuidance.ts";

describe("computer recovery playbooks", () => {
  it.each(["notion", "recovery", "reading", "attachments"] as const)(
    "exposes %s through on-demand help without inflating the core prompt",
    (topic) => {
      expect(COMPUTER_HELP_TOPICS).toContain(topic);
      expect(COMPUTER_HELP_INDEX).toContain(`${topic} —`);
      expect(COMPUTER_HELP_SECTIONS[topic].length).toBeLessThanOrEqual(900);
      expect(computerToolInstructions()).not.toContain(COMPUTER_HELP_SECTIONS[topic]);
      expect(computerToolInstructions().length).toBeLessThanOrEqual(3_800);
    },
  );

  it("keeps recovery from authorizing replay, false success or foreground bypass", () => {
    const recovery = COMPUTER_HELP_SECTIONS.recovery;
    expect(recovery).toContain("zero delivered-character count");
    expect(recovery).toContain("dispatched-unknown still forbids replay");
    expect(recovery).toContain("not solved by alternating paste, keys or scroll");
    expect(recovery).toContain("a fresh screenshot alone does not reset the guard");
    expect(recovery).toContain("approval_expired means no decision and no input");
    expect(recovery).toContain("An explicit decline or cancel remains binding");
    expect(recovery).toContain("permission denial needs user action");
  });

  it("covers the reported Notion and reading pitfalls without inventing upload support", () => {
    expect(COMPUTER_HELP_SECTIONS.notion).toContain("cmd+left/right");
    expect(COMPUTER_HELP_SECTIONS.notion).toContain("1) may autoformat");
    expect(COMPUTER_HELP_SECTIONS.notion).toContain("AX quiet is not proof");
    expect(COMPUTER_HELP_SECTIONS.reading).toContain("elementsSourceIncomplete");
    expect(COMPUTER_HELP_SECTIONS.reading).toContain("Requested pixels are not measured movement");
    expect(COMPUTER_HELP_SECTIONS.attachments).toContain("observed Attach/Upload control");
    expect(COMPUTER_HELP_SECTIONS.attachments).toContain("Do not assume computer_paste");
    expect(COMPUTER_HELP_SECTIONS.attachments).toContain("without the required approval");
  });
});
