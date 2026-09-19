import { describe, expect, it } from "vitest";

import {
  COMPUTER_HELP_INDEX,
  COMPUTER_HELP_SECTIONS,
  COMPUTER_HELP_TOPICS,
  computerToolInstructions,
} from "./computerGuidance.ts";

describe("computer guidance", () => {
  it("keeps the injected block inside the L5 budget", () => {
    const notes = computerToolInstructions();
    // The wave-2 measurement was 8,142 chars; the ceiling only ever moves
    // down. L23's browser recipe lives in the on-demand chapter, and the
    // shared block nets smaller.
    expect(notes.length).toBeLessThanOrEqual(8_300);
    expect(notes).not.toContain("relaunch visible");
    expect(notes).not.toContain("unhide with computer_set_app_visibility");
  });

  it("maps every refusal the guidance teaches to a next step", () => {
    const notes = computerToolInstructions();
    for (const code of [
      "computer_target_ambiguous",
      "same_pid_keyboard_ambiguity",
      "element_outside_target_window",
      "background_unavailable",
      "foreground_not_requested",
      "foreground_user_interaction",
      "browser_requires_setup",
      "browser_tab_required",
      "browser_tab_not_found",
      "foreign_process_termination_denied",
      "input_target_unavailable",
      "computer_controlled_by_other_thread",
    ]) {
      expect(notes, code).toContain(code);
    }
  });

  it("teaches in-page search as the browser path", () => {
    const browser = COMPUTER_HELP_SECTIONS.browser;
    expect(browser).toContain("page's own search box");
    expect(browser).toContain('input_route "dom_event"');
    expect(browser).toContain("fresh computer_browser_state");
    expect(browser).toContain("Do not leave the browser");
    expect(browser).toContain("rev-31");
    expect(browser).toContain("fallback, not the first move");
    expect(browser).toContain("driver_owned_headless");
    expect(browser).toContain("headless by default");
    expect(browser).toContain("isolated_named");
  });

  it("keeps the visibility chapter about explicit user-requested controls", () => {
    const hidden = COMPUTER_HELP_SECTIONS.hidden;
    expect(hidden).toContain("Explicit visibility controls");
    expect(hidden).toContain("computer_set_window_minimized");
    expect(hidden).toContain("computer_set_app_visibility");
    expect(hidden).not.toContain("launch_app");
    expect(hidden).not.toContain("invisible");
  });

  it("keeps every chapter indexed and non-empty", () => {
    expect(COMPUTER_HELP_TOPICS).toEqual(Object.keys(COMPUTER_HELP_SECTIONS));
    const indexLines = COMPUTER_HELP_INDEX.split("\n");
    expect(indexLines).toHaveLength(COMPUTER_HELP_TOPICS.length);
    for (const topic of COMPUTER_HELP_TOPICS) {
      expect(COMPUTER_HELP_SECTIONS[topic].length, topic).toBeGreaterThan(0);
      expect(
        indexLines.some((line) => line.startsWith(`${topic} —`)),
        topic,
      ).toBe(true);
    }
  });
});
