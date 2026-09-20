import { describe, expect, it } from "vitest";

import {
  COMPUTER_HELP_INDEX,
  COMPUTER_HELP_SECTIONS,
  COMPUTER_HELP_TOPICS,
  computerToolInstructions,
} from "./computerGuidance.ts";

describe("computer guidance", () => {
  it("matches the verbatim guidance text with the help-index last line", () => {
    const notes = computerToolInstructions();
    expect(notes.startsWith("## Synara computer use\n")).toBe(true);
    for (const heading of [
      "### Working loop",
      "### Background first",
      "### Verdicts and refusals",
      "### Browser",
      "### More",
    ]) {
      expect(notes, heading).toContain(heading);
    }
    expect(notes).toContain("press_key takes one key or a chord");
    expect(notes).toContain("repeated_unverified_action");
    expect(
      notes.endsWith(
        "computer_help lists chapters and the full tool index; read it before using a tool that is not in your catalog",
      ),
    ).toBe(true);
    // Pins the verbatim body: GUIDANCE-v2.txt with only the last line
    // swapped for the help/tool-index pointer.
    expect(notes.length).toBe(3_488);
    for (const retired of [
      "computer_recording",
      "computer_replay",
      "computer_double_click",
      "computer_hotkey",
      "computer_triple_click",
      "computer_right_click",
    ]) {
      expect(notes, retired).not.toContain(retired);
    }
  });

  it("maps every refusal the guidance teaches to a next step", () => {
    const notes = computerToolInstructions();
    for (const code of [
      "foreground_not_requested",
      "foreground_user_interaction",
      "same_pid_keyboard_ambiguity",
      "element_outside_target_window",
      "input_target_unavailable",
      "repeated_unverified_action",
    ]) {
      expect(notes, code).toContain(code);
    }
  });

  it("keeps the browser chapter on the CDP route", () => {
    const browser = COMPUTER_HELP_SECTIONS.browser;
    expect(browser).toContain("desktop driver's CDP route");
    expect(browser).toContain("allow_launch:true");
    expect(browser).toContain('"isolated_named"');
    expect(browser).toContain("headless by default");
    expect(browser).toContain("driver_owned_headless");
    expect(browser).toContain("computer_browser_state({pid})");
    expect(browser).toContain("target_id");
    expect(browser).toContain("tab_id");
    expect(browser).toContain('input_route "dom_event"');
    expect(browser).toContain("own search box");
    expect(browser).toContain("do not leave the browser");
    expect(browser).toContain("Refs die on navigation");
  });

  it("keeps the visibility chapter about explicit user-requested controls", () => {
    const hidden = COMPUTER_HELP_SECTIONS.hidden;
    expect(hidden).toContain("Explicit visibility controls");
    expect(hidden).toContain("computer_set_window_minimized");
    expect(hidden).toContain("computer_set_app_visibility");
    expect(hidden).not.toContain("launch_app");
    expect(hidden).not.toContain("invisible");
  });

  it("keeps every chapter indexed, non-empty and inside its budget", () => {
    expect(COMPUTER_HELP_TOPICS).toEqual(Object.keys(COMPUTER_HELP_SECTIONS));
    expect(COMPUTER_HELP_TOPICS).toContain("tools");
    expect(COMPUTER_HELP_TOPICS).not.toContain("recording");

    expect(COMPUTER_HELP_SECTIONS.menus.length).toBeLessThanOrEqual(700);
    for (const topic of ["browser", "hidden", "foreground", "forms"] as const) {
      expect(COMPUTER_HELP_SECTIONS[topic].length, topic).toBeLessThanOrEqual(900);
    }
    expect(COMPUTER_HELP_SECTIONS.tools.length).toBeGreaterThanOrEqual(100);
    expect(COMPUTER_HELP_SECTIONS.tools.length).toBeLessThanOrEqual(300);
    // The tools chapter is intro only; per-tool index lines are appended by
    // the computer_help handler, so it must not name concrete tools itself.
    expect(COMPUTER_HELP_SECTIONS.tools).not.toMatch(/computer_[a-z]/);

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
});
