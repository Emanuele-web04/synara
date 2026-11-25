import { describe, expect, it } from "vitest";

import {
  COMPUTER_HELP_INDEX,
  COMPUTER_HELP_SECTIONS,
  COMPUTER_HELP_TOPICS,
  computerToolInstructions,
} from "./computerGuidance.ts";

describe("computer guidance", () => {
  it("keeps every chapter indexed and non-empty", () => {
    expect(COMPUTER_HELP_TOPICS).toEqual(Object.keys(COMPUTER_HELP_SECTIONS));
    for (const topic of COMPUTER_HELP_TOPICS) {
      expect(COMPUTER_HELP_SECTIONS[topic].length, topic).toBeGreaterThan(0);
    }

    const indexLines = COMPUTER_HELP_INDEX.split("\n");
    expect(indexLines).toHaveLength(COMPUTER_HELP_TOPICS.length);
    for (const topic of COMPUTER_HELP_TOPICS) {
      expect(
        indexLines.some((line) => line.startsWith(`${topic} —`)),
        topic,
      ).toBe(true);
    }
    for (const line of indexLines) {
      expect(
        COMPUTER_HELP_TOPICS.some((topic) => line.startsWith(`${topic} —`)),
        line,
      ).toBe(true);
    }
  });

  it("keeps application playbooks on demand without expanding the active prompt", () => {
    const notes = computerToolInstructions();
    for (const app of [
      "finder",
      "editors",
      "terminals",
      "electron",
      "calculator",
      "slack",
    ] as const) {
      expect(COMPUTER_HELP_INDEX).toContain(`${app} —`);
      expect(notes).not.toContain(COMPUTER_HELP_SECTIONS[app]);
    }
  });
});
