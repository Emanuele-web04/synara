import { describe, expect, it } from "vitest";

import {
  activeComputerGuidanceProfile,
  COMPUTER_HELP_INDEX,
  COMPUTER_HELP_SECTIONS,
  COMPUTER_HELP_TOPICS,
  computerHelpSections,
  computerToolInstructions,
  DEFAULT_COMPUTER_GUIDANCE_PROFILE,
  setActiveComputerGuidanceProfile,
} from "./computerGuidance.ts";
import { renderSynaraHarnessPolicy } from "./harnessPolicy.ts";

/**
 * The instructions and the Linux chapter exactly as the Cua host has always
 * rendered them. Pinned byte for byte: a desktop that registers no profile of
 * its own — the Cua host on any platform, the test double, an unavailable
 * backend — must keep this text unchanged.
 */
const LEGACY_INSTRUCTIONS = JSON.parse(
  '"## Synara computer use\\nThe computer_* tools are live on this session. Use them directly for the requested desktop or browser work. If your harness defers advertised tools, look them up by exact name; never list the whole catalog. Never substitute shell or AppleScript to get around a refusal. For Synara\'s own in-app browser use browser_*.\\nConsent covers routine navigation and editing. Confirm with the user first for purchases or payments, deletions, messages or submissions to third parties, account or security changes, installing software, or sharing sensitive data. Hand authentication (passwords, Touch ID) back to the user. Stop when the user cancels or takes over.\\n### Working loop\\nStart with computer_launch_app or computer_list_windows({app}), then computer_get_state({window_id}). Act by ref (or exact label plus role); re-observe after navigation or layout changes. Use each action\'s observation; include_screenshot:false when elements suffice. set_value replaces a field; type_text with window_id alone inserts the whole string into its focused field. Never spell text through press_key; use writable refs for exact semantic insertion. Neither sends keydown/keyup; verify app reactions. press_key takes one key or a chord (\\"cmd+shift+n\\"); click takes count (1-3) and button.\\n### Background first\\nPrefer semantic controls. macOS launch_app opens without activation; hidden:true explicitly hides the app. Foreground work needs the user\'s visible-use request or direct confirmation of a visibility question; naming an app is insufficient. computer_activate_window, computer_invoke_menu, delivery_mode:\\"foreground\\" and browser_prepare windowed:true otherwise refuse with foreground_not_requested. foreground_user_interaction means wait for quiet. Never raise to bypass a background refusal.\\n### Verdicts and refusals\\ndelivery.effect: \\"verified\\" proves an observed effect; \\"dispatched-unknown\\" means inspect before deciding, never replay it or escalate to foreground; \\"not-dispatched\\" permits a corrected call. same_pid_keyboard_ambiguity means the requested window/field is not the proven keyboard destination: use an exact semantic control, never retry keys blindly. computer_controlled_by_other_thread: another task owns this app or exclusive desktop input; wait, do not retry-loop. Independent apps can proceed in the background. element_outside_target_window, stale targets or input_target_unavailable: get_state and re-address. repeated_unverified_action or repeated_computer_refusal: the same approaches made no progress; correct the target or stop, never replay uncertain input. When input is paused, stop and hand back to the user.\\n### Browser\\ncomputer_browser_prepare({allow_launch:true, profile:{mode:\\"isolated_named\\", name}}) launches a separate headless browser without the user\'s cookies; never silently substitute it for their browser. computer_browser_state({pid}) binds its target_id and tab_id; browser actions require those IDs, not pid/window_id. Linux native desktop input is unavailable; browser control needs a verified driver and packaged host\'s direct-X11 Escape listener. Wayland/XWayland and standalone hosts permit browser reads only: see computer_help({topic:\\"linux\\"}). Navigate with computer_browser_navigate; act on refs with computer_browser_click, computer_browser_type (input_route \\"dom_event\\") and computer_browser_press. Use the site\'s own search box and re-snapshot. Refs die on navigation: snapshot again.\\n### More\\nUse computer_run to batch known desktop steps in one call. computer_help({tool:\\"computer_invoke_menu\\"}) returns one exact schema and a computer_run or computer_inspect route; looking up a tool does not add it to your provider catalog. Use topic for on-demand app playbooks."',
) as string;
const LEGACY_LINUX_CHAPTER = JSON.parse(
  '"Linux observation and preview depend on display/AT-SPI access and compositor support; native desktop input is unavailable. Browser control supports only driver-owned isolated headless profiles with the verified Linux driver and packaged host\'s confirmed direct-X11 Escape listener. Escape stops input; this shortcut does not detect general human takeover. Wayland/XWayland portal registration and standalone hosts cannot prove Escape: browser mutations refuse with input_monitor_unavailable. Browser reads, dialog inspection and passive browser_prepare (allow_launch:false, no strategy) remain available. A missing driver capability returns linux_browser_cleanup_unavailable. Visible launches and personal-profile control are unavailable, even with consent; do not retry through shell or foreground input."',
) as string;

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

  it("keeps the Cua host's text byte-identical whatever profile is registered", () => {
    expect(computerToolInstructions()).toBe(LEGACY_INSTRUCTIONS);
    expect(COMPUTER_HELP_SECTIONS.linux).toBe(LEGACY_LINUX_CHAPTER);
    expect(activeComputerGuidanceProfile()).toBe(DEFAULT_COMPUTER_GUIDANCE_PROFILE);
    // A Cua host on a Mac, and a backend that declares no seat of its own,
    // both render the legacy policy.
    for (const profile of [
      { dialect: "macos", dedicatedSeat: false } as const,
      { dialect: "linux", dedicatedSeat: false } as const,
    ]) {
      try {
        setActiveComputerGuidanceProfile(profile);
        expect(activeComputerGuidanceProfile()).toBe(profile);
        expect(
          renderSynaraHarnessPolicy({ gatewayControlAvailable: true, enableComputerControl: true }),
        ).toContain(LEGACY_INSTRUCTIONS);
      } finally {
        setActiveComputerGuidanceProfile(undefined);
      }
    }
    expect(activeComputerGuidanceProfile()).toBe(DEFAULT_COMPUTER_GUIDANCE_PROFILE);
  });

  it("describes a dedicated-seat Linux desktop as one the agent can drive", () => {
    // Only the profile a compositor backend registers changes the text: the
    // Cua host on Linux, with no seat of its own, keeps the legacy wording.
    const desktop = { dialect: "linux", dedicatedSeat: true } as const;
    expect(computerToolInstructions({ dialect: "linux", dedicatedSeat: false })).toBe(
      LEGACY_INSTRUCTIONS,
    );
    expect(computerHelpSections({ dialect: "linux", dedicatedSeat: false }).linux).toBe(
      LEGACY_LINUX_CHAPTER,
    );

    const notes = computerToolInstructions(desktop);
    expect(notes).not.toContain("native desktop input is unavailable");
    expect(notes).not.toContain("computer_browser_prepare");
    expect(notes).toContain("seat of its own");
    expect(notes).toContain("computer_human_active");
    expect(notes).toContain("This desktop has no computer_browser_* route");
    expect(notes).toContain('press_key takes one key or a chord ("ctrl+shift+n")');
    for (const heading of ["### Working loop", "### Background first", "### Browser", "### More"]) {
      expect(notes, heading).toContain(heading);
    }
    expect(notes.length).toBeLessThanOrEqual(3_800);

    const linux = computerHelpSections(desktop).linux;
    expect(linux).toContain("compositor plugin (KWin or Hyprland)");
    expect(linux).toContain("Meta+Shift+Esc");
    expect(linux).toContain("never touched");
    expect(linux).not.toContain("native desktop input is unavailable");
    expect(linux.length).toBeLessThanOrEqual(900);

    try {
      setActiveComputerGuidanceProfile(desktop);
      const policy = renderSynaraHarnessPolicy({
        gatewayControlAvailable: true,
        enableComputerControl: true,
      });
      expect(policy).toContain("seat of its own");
      expect(policy).not.toContain("Linux native desktop input is unavailable");
    } finally {
      setActiveComputerGuidanceProfile(undefined);
    }
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
