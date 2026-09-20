/** Shared provider-host Computer guidance. Never included in MCP initialize:
 * clients may expand server instructions per tool, and Pi uses native tools.
 *
 * Read-only vs mutation split, deliberately not a separate lease: perception
 * tools (computer_list_windows, computer_get_state, computer_screenshot,
 * computer_get_screen_size, computer_wait) and mutating tools share one
 * `computer:control` capability, so every served Computer tool needs the
 * Settings switch on plus OS grants behind it. Always leasing perception would
 * need a new `computer:control-read` capability in the gateway contract plus
 * per-tool `requiredCapability` splits in computerTools.ts — a contract and
 * tool-logic change, out of scope. Smallest safe step instead: the standing
 * one-line Computer affordance in harnessPolicy.ts (unconditional on the
 * Computer flag) plus this note, so a session without control routes
 * desktop-app work to the Settings switch rather than substituting
 * another surface or hallucinating a read-only grant it does not have.
 */

/**
 * The situational playbook chapters `computer_help` serves on demand. They
 * carry the same load they did when injected — a session now pays for one only
 * when the task actually touches that surface instead of every
 * computer-enabled session fronting the whole catalog.
 */
export const COMPUTER_HELP_SECTIONS = {
  browser:
    "computer_browser_* drives a browser through the desktop driver's CDP route; in-app browser work uses browser_*. Prepare with computer_browser_prepare (allow_launch:true plus an isolated profile, prefer mode \"isolated_named\"): the driver-owned launch is headless by default — no window, no Dock entry; windowed:true opts in to a visible one. To reuse a browser the user already runs (Helium, Chrome), pass that browser's pid: the driver starts its own driver_owned_headless instance and never touches the user's. Bind with computer_browser_state({pid}); target_id names the bound browser, each tab's tab_id names one tab — never pass one for the other. To find something on a site, computer_browser_type into its own search box (input_route \"dom_event\") and re-snapshot; do not leave the browser to look things up elsewhere. Refs die on navigation — snapshot again after it.",
  menus:
    'computer_list_apps answers "is X installed/running?" (pid, bundle id). computer_invoke_menu names exact menu-bar titles on the owning app; missing/ambiguous/disabled segments are refused, never coordinates. computer_set_window_frame moves a window in desktop coordinates; unconfirmed means observe, never replay. computer_verify_state checks live element/window predicates without dispatching; computer_zoom magnifies window regions. computer_get_accessibility_tree lists running apps and visible windows, scoped by window_id; contents stay computer_get_state. computer_get_cursor_position reads the pointer, never moving it. computer_kill_app force-quits — unsaved work lost; prefer Quit/Command-Q.',
  hidden:
    "Explicit visibility controls, for when the user asks to get something out of the way or bring it back: computer_set_window_minimized moves one exact window off-screen and back, and computer_set_app_visibility hides or unhides a whole running app by pid. Neither activates, focuses or switches Spaces, and windows under them keep answering the semantic tools; coordinate clicks and keystrokes still need a target on screen. A visibility result reports confirmed only from the driver's read-back; anything less means observe, never replay.",
  foreground:
    'Bringing a window in front of the user is opt-in per task: computer_activate_window, delivery_mode:"foreground", and launch_app hidden:false are refused with foreground_not_requested unless the user\'s own latest message asked to see the screen ("show me", "watch", "on my screen", "bring it to the front"). Naming an app is not asking to see it — a task that says "use Chrome" stays background. When the work truly needs visible input, ask the user to confirm they want to watch; their reply is the authorization, so retry only after it lands. Even then a raise is refused with foreground_user_interaction while the user was just interacting with the desktop through the pane — wait for quiet, do not retry immediately. Never raise to work around a background refusal, and never describe a window as shown unless the call succeeded.',
  forms:
    "Read existing values, group missing choices, prefer set_value for editable controls, and verify meaningful section boundaries. Never blindly repeat typing or toggles. If submission is forbidden avoid Enter in dropdowns: click an option, use Tab/Escape and verify. Distinguish verified, uncertain and missing values at handback; preserve the user's submission boundary.",
  tools:
    "The advertised computer_* catalog is deliberately short. More computer_* tools stay callable by their exact names even when they are not listed; the index appended after this paragraph names each one with a short description. Read a line before calling a tool that is not in your catalog.",
} as const;

export type ComputerHelpTopic = keyof typeof COMPUTER_HELP_SECTIONS;

export const COMPUTER_HELP_TOPICS = Object.keys(COMPUTER_HELP_SECTIONS) as ComputerHelpTopic[];

/** One line per chapter — what a bare computer_help call returns. */
export const COMPUTER_HELP_INDEX = [
  "browser — driving a driver-launched or approved browser tab over CDP (computer_browser_*)",
  "menus — app inventory, menu-bar titles, window frames, zoom, cursor position, state checks, force-quit (list_apps, invoke_menu, set_window_frame, kill_app, zoom, get_accessibility_tree, get_cursor_position, verify_state)",
  "hidden — explicit visibility controls (set_window_minimized, set_app_visibility) for windows and apps the user asks to move off-screen",
  "foreground — when a window may come forward: task-text authorization, refusal codes, wait-for-quiet",
  "forms — reading values, grouping choices, verifying boundaries on form tasks",
  "tools — the computer_* tools beyond the advertised catalog, callable by exact name",
].join("\n");

/** Delivered only in an activated provider session, never through MCP initialize. */
export function computerToolInstructions(): string {
  return [
    "## Synara computer use",
    "The computer_* tools are live on this session. Use them directly for the requested desktop or browser work. If your harness defers tools, look them up by these exact names; never list the whole catalog. Never substitute shell or AppleScript to get around a refusal. For Synara's own in-app browser use browser_*.",
    "Consent covers routine navigation and editing. Confirm with the user first for purchases or payments, deletions, messages or submissions to third parties, account or security changes, installing software, or sharing sensitive data. Hand authentication (passwords, Touch ID) back to the user. Stop when the user cancels or takes over.",
    "### Working loop",
    'Start with computer_launch_app or computer_list_windows({app}), then computer_get_state({window_id}) to read the elements. Act by ref (or exact label plus role) from that state; refs name duplicates that labels cannot. Re-observe after anything moves, opens or navigates. Use the observation each action returns for the next step; pass include_screenshot:false when elements are enough. Prefer computer_set_value for text fields; use computer_type_text only for a focused control without a value. press_key takes one key or a chord ("cmd+shift+n"); click takes count (1-3) and button.',
    "### Background first",
    'Everything runs behind the user\'s windows. Nothing activates, focuses or raises unless the user\'s own latest message asked to watch ("show me", "on my screen"). Naming an app is not asking to see it. computer_activate_window, delivery_mode:"foreground" and launch_app hidden:false refuse with foreground_not_requested otherwise; foreground_user_interaction means the user is interacting right now, so wait for quiet. Never raise to work around a background refusal.',
    "### Verdicts and refusals",
    'Each action reports delivery.effect: "verified" (effect observed), "dispatched-unknown" (input sent, effect unproven: inspect the observation before deciding, never replay it, never escalate to foreground) or "not-dispatched" (nothing happened; a corrected call is fine). same_pid_keyboard_ambiguity: background keys cannot be proven for this window, use set_value or an element action. element_outside_target_window or a stale or missing target: take a fresh get_state and re-address. input_target_unavailable: the window is hidden, minimized or gone, observe again. repeated_unverified_action: the same action was sent three times with no observed change, so change approach or ask the user. When input is paused, stop and hand back to the user.',
    "### Browser",
    "Web work goes through the driver's CDP route. computer_browser_prepare({allow_launch:true, profile:{mode:\"isolated_named\", name}}) launches a headless driver-owned browser with no window and no Dock entry; to reuse a browser the user already runs (Helium, Chrome), pass that browser's pid and the driver starts its own headless instance without touching the user's. computer_browser_state({pid}) binds it and returns target_id, tab_id and a snapshot with refs, names and prices. Navigate with computer_browser_navigate, act on refs with computer_browser_click, computer_browser_type (input_route \"dom_event\") and computer_browser_press. To find something on a site, type into the site's own search box and re-snapshot; do not leave the browser to look things up elsewhere. Refs die on navigation, so snapshot again after it.",
    "### More",
    "computer_help lists chapters and the full tool index; read it before using a tool that is not in your catalog",
  ].join("\n");
}
