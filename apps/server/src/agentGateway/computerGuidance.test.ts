import { describe, expect, it } from "vitest";

import {
  COMPUTER_HELP_INDEX,
  COMPUTER_HELP_SECTIONS,
  COMPUTER_HELP_TOPICS,
  computerToolInstructions,
} from "./computerGuidance.ts";
import { renderSynaraHarnessPolicy } from "./harnessPolicy.ts";

describe("computer guidance", () => {
  it("keeps core guidance concise and explains the callable batch route", () => {
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
    expect(notes).toContain("Use computer_run to batch known desktop steps in one call");
    expect(notes).toContain('computer_help({tool:"computer_invoke_menu"})');
    expect(notes).toContain("computer_inspect route");
    expect(notes).toContain("does not add it to your provider catalog");
    expect(notes.length).toBeLessThanOrEqual(3_800);
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

  it("separates nonactivating launch from hiding and accepts direct visibility confirmation", () => {
    const notes = computerToolInstructions();
    expect(notes).toContain("launch_app opens without activation");
    expect(notes).toContain("hidden:true explicitly hides the app");
    expect(notes).toContain("direct confirmation of a visibility question");
    expect(notes).not.toContain("pixel fallback can briefly take keyboard focus");
    expect(notes).not.toContain("launch_app hidden:false");
    expect(COMPUTER_HELP_SECTIONS.foreground).toContain("direct affirmative reply");
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
    expect(browser).toContain('scope:"navigation",status:"confirmed"');
    expect(browser).toContain("proves field content, not submission");
    expect(browser).toContain("never automatically repeat input");
  });

  it("limits Linux mutations to owned headless browsers with a confirmed direct-X11 Escape listener", () => {
    const notes = computerToolInstructions();
    const linux = COMPUTER_HELP_SECTIONS.linux;
    for (const text of [
      "display/AT-SPI access",
      "native desktop input is unavailable",
      "only driver-owned isolated headless profiles",
      "verified Linux driver",
      "confirmed direct-X11 Escape listener",
      "does not detect general human takeover",
      "Wayland/XWayland portal registration and standalone hosts cannot prove Escape",
      "input_monitor_unavailable",
      "passive browser_prepare (allow_launch:false, no strategy)",
      "linux_browser_cleanup_unavailable",
      "Visible launches and personal-profile control are unavailable",
      "do not retry through shell or foreground input",
    ]) {
      expect(linux, text).toContain(text);
    }
    expect(linux.length).toBeLessThanOrEqual(900);
    expect(notes).toContain("Linux native desktop input is unavailable");
    expect(notes).toContain("packaged host's direct-X11 Escape listener");
    expect(notes).toContain("Wayland/XWayland and standalone hosts permit browser reads only");
    expect(notes).not.toContain(linux);
    for (const guidance of [notes, linux, COMPUTER_HELP_SECTIONS.browser]) {
      expect(guidance).not.toContain("Linux cannot launch headlessly");
      expect(guidance).not.toContain("native input and headless launch are unavailable");
      expect(guidance).not.toContain("explicitly requested visible launch");
    }
    const disabled = renderSynaraHarnessPolicy({
      gatewayControlAvailable: true,
      enableComputerControl: false,
    });
    expect(disabled).not.toContain("computer_");
    expect(disabled).not.toContain("direct-X11");
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
    for (const topic of ["browser", "hidden", "foreground", "forms", "spaces"] as const) {
      expect(COMPUTER_HELP_SECTIONS[topic].length, topic).toBeLessThanOrEqual(900);
    }
    expect(COMPUTER_HELP_SECTIONS.tools.length).toBeGreaterThanOrEqual(100);
    expect(COMPUTER_HELP_SECTIONS.tools.length).toBeLessThanOrEqual(300);
    expect(COMPUTER_HELP_SECTIONS.tools).toContain("computer_run");
    expect(COMPUTER_HELP_SECTIONS.tools).toContain("computer_inspect");

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
      expect(COMPUTER_HELP_SECTIONS[app].length).toBeLessThanOrEqual(700);
      expect(COMPUTER_HELP_INDEX).toContain(`${app} —`);
      expect(notes).not.toContain(COMPUTER_HELP_SECTIONS[app]);
    }
    expect(COMPUTER_HELP_SECTIONS.electron).toContain("same_pid_keyboard_ambiguity");
    expect(COMPUTER_HELP_SECTIONS.editors).toContain("not that it was saved or synced");
  });

  it("describes managed inventory and explicit reservation without promising OS ownership", () => {
    const spaces = COMPUTER_HELP_SECTIONS.spaces;
    expect(spaces).toContain("including empty ones");
    expect(spaces).toContain("Use Space ID 42 for this task");
    expect(spaces).toContain("Native create, switch, move and follow are unsupported");
    expect(spaces).toContain("not OS ownership or continuous isolation");
    expect(computerToolInstructions()).not.toContain(spaces);
  });
});
