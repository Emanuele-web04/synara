import { COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION } from "../computer/ComputerBackend.ts";
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
 * The one account of `delivery.verified`, told the same way everywhere.
 *
 * The three verdicts are spelled out rather than collapsed because both
 * simplifications fail. Without the sentence at all, an unconfirmed delivery
 * reads as plain success and the model re-sends the same keys — a real session
 * retyped an email address in six-character chunks and looped select-all/paste
 * six times because every call said `ok` while nothing had landed. Collapsing
 * the three into "anything but confirmed is suspect" is the opposite failure:
 * most native controls expose no value to read back, so that reading buys a
 * screenshot after every keystroke and slows every desktop turn for nothing.
 */
export const DELIVERY_VERDICT_GUIDANCE =
  'delivery.verified describes native read-back: "confirmed" means the effect was observed, ' +
  '"unconfirmed" means read-back did not establish it, and "unverifiable" means no reliable read-back was available. ' +
  'delivery.effect is "verified" only when established; "dispatched-unknown" means input may have taken effect. ' +
  "For unknown effects, inspect the returned observation or request fresh state before deciding the next action. " +
  'Never replay an uncertain action or promote it to foreground automatically. A "not-dispatched" refusal permits a corrected request.';

/**
 * The situational playbook chapters `computer_help` serves on demand. They
 * carry the same load they did when injected — a session now pays for one only
 * when the task actually touches that surface instead of every
 * computer-enabled session fronting the whole catalog.
 */
export const COMPUTER_HELP_SECTIONS = {
  browser:
    'computer_browser_* reaches a browser through the desktop driver\'s CDP route — the only surface that can drive a driver-launched isolated Chromium or an approved existing profile, and the only input route that works on a browser renderer the user is not looking at. Use the integrated browser_* tools for ordinary in-app browser work. Bind with computer_browser_prepare (allow_launch for an isolated profile), then computer_browser_state with the prepared pid and window_id to mint a target_id and tab ids; snapshot a tab before acting on it. Refs are exact and die on navigation — after computer_browser_navigate, take a fresh snapshot instead of retrying stale refs. A status:"refused" result is an answer, not an error: branch on its refusal code (for example browser_requires_setup → prepare, browser_wrong_target_refused → rebind the real window) rather than replaying the call.',
  menus:
    'computer_list_apps lists running and installed apps with pid and bundle id — "is X installed?" and "is X running?" — where computer_list_windows lists open windows. computer_invoke_menu names exact menu-bar titles on the owning app\'s process — ["File", "Save"]; a missing, ambiguous or disabled segment is refused and never falls back to coordinates. computer_set_window_frame moves a window in the desktop coordinates list_windows reports and is verified only by an independent read-back; an unconfirmed frame means observe before relying on it, never replay it. computer_verify_state checks live element or window predicates without dispatching anything, and computer_zoom returns a magnified JPEG of one window-local region. computer_get_accessibility_tree is the driver\'s fast desktop inventory — running apps and their on-screen windows, scoped to one app by window_id — for "what is running and visible", not what a window contains; the per-window elements digest stays computer_get_state. computer_get_cursor_position reports where the human\'s pointer currently sits in desktop coordinates, never moving it. computer_kill_app force-terminates the owning app — unsaved state is lost and every window closes — so prefer the cooperative path (a Quit menu item or Command-Q) first.',
  hidden:
    'A hidden or minimized window is the way to work without touching what the user sees: computer_launch_app({app:"...",hidden:true}) starts an app off-screen, computer_set_window_minimized moves one exact window, and computer_set_app_visibility hides a whole running app by pid. None of these activate, focus or switch Spaces, and none is needed to act — hidden windows keep answering the semantic tools (set_value, select_text, clicks by label, exact-window type_text, get_window_state). What stays refused on them is the raw stream: coordinate clicks and keystrokes still need a visible target, and nothing about hiding makes one. A visibility result reports confirmed only from the driver\'s read-back; anything less means observe, never replay.',
  foreground:
    'Bringing a window in front of the user is opt-in per task: computer_activate_window, delivery_mode:"foreground", and launch_app hidden:false are refused with foreground_not_requested unless the user\'s own latest message asked to see the screen ("show me", "watch", "on my screen", "bring it to the front"). Naming an app is not asking to see it — a task that says "use Chrome" stays background. When the work truly needs visible input, ask the user to confirm they want to watch; their reply is the authorization, so retry only after it lands. Even then a raise is refused with foreground_user_interaction while the user was just interacting with the desktop through the pane — wait for quiet, do not retry immediately. Never raise to work around a background refusal, and never describe a window as shown unless the call succeeded.',
  forms:
    "Read existing values, group missing choices, prefer set_value for editable controls, and verify meaningful section boundaries. Never blindly repeat typing or toggles. If submission is forbidden avoid Enter in dropdowns: click an option, use Tab/Escape and verify. Distinguish verified, uncertain and missing values at handback; preserve the user's submission boundary.",
  recording:
    'computer_recording_start opens a structured local log of this thread\'s computer calls — target identity, approval path, dispatch verdict, never screenshots and never clipboard contents — and computer_recording_stop closes it. The default "redacted" fidelity stores typed text as length plus a content hash; "full" keeps it verbatim so a replay can retype it, and still hashes anything sent to a protected field. computer_recording_list and computer_recording_read review sessions; computer_replay classifies a session\'s steps against the live desktop and only execute:true sends anything — re-issuing steps whose target re-resolves fresh, skipping what cannot be re-established honestly. A replay is never a shortcut around consent: it asks like the actions it re-issues.',
} as const;

export type ComputerHelpTopic = keyof typeof COMPUTER_HELP_SECTIONS;

export const COMPUTER_HELP_TOPICS = Object.keys(COMPUTER_HELP_SECTIONS) as ComputerHelpTopic[];

/** One line per chapter — what a bare computer_help call returns. */
export const COMPUTER_HELP_INDEX = [
  "browser — driving a driver-launched or approved browser tab over CDP (computer_browser_*)",
  "menus — app inventory, menu-bar items, window frames, exits (list_apps, invoke_menu, set_window_frame, kill_app, zoom, get_accessibility_tree, get_cursor_position, verify_state)",
  "hidden — working in windows the user never sees (launch_app hidden, set_window_minimized, set_app_visibility)",
  "foreground — when a window may come forward: task-text authorization, refusal codes, wait-for-quiet",
  "forms — reading values, grouping choices, verifying boundaries on form tasks",
  "recording — structured call logs and honest replay (recording_start/stop/list/read/export/delete, replay)",
].join("\n");

/** Delivered only in an activated provider session, never through MCP initialize. */
export function computerToolInstructions(): string {
  return [
    "## Synara computer use",
    "The user invoked Computer for this task. The computer_* tools are already exposed on this session's Synara tool surface — invoke them by those exact names; do not conclude they are unavailable from a file search or an unchecked surface, never tell the user computer control is off while the tools are listed, and do not ask for them to be enabled. Use them directly and complete the requested desktop work autonomously within that scope. Do not ask again for ordinary clicks, typing, scrolling or switching apps. Do not substitute shell, AppleScript or another automation surface to bypass a refusal. In-app browser requests still use browser_*.",
    "Task consent covers routine navigation and editing, not unrelated actions. Follow the applicable confirmation policy for deletion, purchases/payments/subscriptions, third-party communications or submissions, sharing sensitive data, binding agreements, account/access changes, newly acquired software, system/security settings and medical actions. Prepare the exact action before asking; honor specific prior authorization where that policy permits it. Hand personal authentication such as Touch ID back to the user. Stop when the user takes over, cancels or revokes Computer.",
    "### Efficient tool discovery and observation",
    'Use the available computer_* tools directly. With deferred tools, discover only the small set of tools needed next by exact names, in one lookup (for an app-button task: launch_app, get_state, click, computer_run); never print ALL_TOOLS or the entire Computer catalog. Start with computer_launch_app or computer_list_windows, then computer_get_state with window_id. Reuse the launch result\'s window id. If it is null, use computer_list_windows({app:"App Name"}) to inspect only that app, never dump unrelated windows. Element entries carry a ref; pass it as the ref argument on actions instead of re-quoting label and role — refs name the exact listed control, including duplicates. A short stable sequence can run as ordered awaited tool calls in one script, or as one computer_run call carrying the same steps when scripting is unavailable; stop on any refusal. When a later step depends on what earlier steps changed, give the run its own evidence — an if_element/unless_element guard, a get_state step to re-list elements, or a wait step — instead of running blind steps separately. Prefer elements for verification; add include_text or an image only when elements are insufficient. Do not request both a final action screenshot and an identical separate screenshot.',
    'Common start: computer_launch_app({app:"Calculator"}) returns window.id; computer_get_state({window_id:id}) returns elements without an image; computer_click({window_id:id,label:"exact observed label",role:"AXButton",include_screenshot:false}) presses one observed control. These are argument examples, not permission to guess controls. Use the tools under their provider-exposed names. Discover only additional tools or arguments when needed.',
    "### Pointing at the desktop",
    "Observe before acting. Prefer label and role from computer_get_state. For x/y use pixel coordinates in a screenshot you received, optionally named by screenshot_id. Never convert screenshot pixels into desktop coordinates. Observe again after the window or controls move.",
    "### Aiming the keyboard",
    "Pass window_id to select an exact input target; otherwise keys go to the last aimed window. The drawn cursor does not aim keys. Exact-window text uses focus-neutral semantic insertion when the window has one writable control; pass its observed label and role when several exist. It does not activate the app or share the human's focused keyboard stream. Other background key delivery may affect app focus and does not isolate human input. Foreground delivery and switching apps are covered by the active task's Computer consent and approval mode. Start in background: omit delivery_mode unless the user asked for visible use. Use foreground only after computer_activate_window, and only when the user's own task asked to see the screen; never switch mode to replay uncertainty. Never rearrange unrelated windows or bypass an input pause. focused means selected input target; active reports native activation when known.",
    "### Raising a window",
    'Bringing a window forward is opt-in by the user\'s words: computer_activate_window, delivery_mode:"foreground" and launch_app hidden:false refuse with foreground_not_requested unless the user\'s latest message asked to see the screen ("show me", "watch", "on my screen"). Naming an app is not asking to see it. If visible input is truly needed, ask the user to confirm they want to watch, then retry after their reply lands. Even authorized, a raise refuses with foreground_user_interaction while the user was just interacting — wait for quiet. Never raise to work around a background refusal. The foreground chapter in computer_help has the full contract.',
    "### The screenshot on every action",
    `Use returned post-action observations, capped at ${COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION} pixels, for the next step. Use include_screenshot:false for intermediate actions or when a final text observation verifies the result. Inspect the final result. screenshotUnchanged reuses the previous image and mapping, not that the action failed. targetWindowClosed means the target is gone. Use computer_wait for a known next control; request computer_screenshot detail when needed, not after every keystroke.`,
    "### Reading a delivery verdict",
    DELIVERY_VERDICT_GUIDANCE,
    "### When a computer tool refuses",
    "For computer_target_ambiguous narrow the target; for stale or missing targets observe again. same_pid_keyboard_ambiguity means background keys cannot prove the window — use an exact element action or foreground, never replay; element_outside_target_window means the ref went stale — fresh get_state and re-address; background_unavailable means that surface takes no background input — use foreground or the browser CDP route. foreground_not_requested means the user's task never asked to see that app or window — stay in background and ask the user to confirm they want to watch before any raise; their reply that asks to see the screen is the authorization. foreground_user_interaction means the user was just interacting with the desktop — wait for quiet, then retry only if the task still needs visible use. browser_requires_setup means no owned browser endpoint exists — prepare with allow_launch and an isolated profile (approval-gated), after reading the browser chapter; never work around it with coordinate clicks on another window. foreign_process_termination_denied means standard mode cannot kill that process — quit cooperatively through its menu or Command-Q, never retry kill. input_target_unavailable on a hidden window means activation cannot reach it — unhide with computer_set_app_visibility and verify, or relaunch visible with hidden:false. computer_controlled_by_other_thread means shared pointer or focused-keyboard work must wait; an independently addressed exact-window semantic text write may still proceed. When input is paused, stop mutations and hand back to the user; check window readiness after return. Missing permission or ComputerApprovalRequired needs user attention. Only effect=not-dispatched proves no input; effect=dispatched-unknown means inspect and never blindly replay. Never automatically retry an unknown effect or escalate it to foreground. No consent block this turn means this turn is not yet approved (perception-only calls and already-decided turns never show one). Say exactly that; do not claim control is off.",
    "### The detailed playbook",
    "computer_help carries the chapters this block omits — browser-tab driving, menus/frames/app exits, hidden workspaces, foreground authorization, form work, recording and replay — and lists them when called bare. Read the matching topic before touching a surface it covers.",
  ].join("\n");
}
