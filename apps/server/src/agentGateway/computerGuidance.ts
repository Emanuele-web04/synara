import { COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION } from "../computer/ComputerBackend.ts";
/** Shared provider-host Computer guidance. Never included in MCP initialize:
 * clients may expand server instructions per tool, and Pi uses native tools.
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

/** Delivered only in an activated provider session, never through MCP initialize. */
export function computerToolInstructions(): string {
  return [
    "## Synara computer use",
    "The user invoked Computer for this task. Use computer_* directly and complete the requested desktop work autonomously within that scope. Do not ask again for ordinary clicks, typing, scrolling or switching apps. Do not substitute shell, AppleScript or another automation surface to bypass a refusal. In-app browser requests still use browser_*.",
    "Task consent covers routine navigation and editing, not unrelated actions. Follow the applicable confirmation policy for deletion, purchases/payments/subscriptions, third-party communications or submissions, sharing sensitive data, binding agreements, account/access changes, newly acquired software, system/security settings and medical actions. Prepare the exact action before asking; honor specific prior authorization where that policy permits it. Hand personal authentication such as Touch ID back to the user. Stop when the user takes over, cancels or revokes Computer.",
    "### Efficient tool discovery and observation",
    'Use the available computer_* tools directly. With deferred tools, discover only the small set of tools needed next by exact names, in one lookup (for an app-button task: launch_app, get_state, click); never print ALL_TOOLS or the entire Computer catalog. Start with computer_launch_app or computer_list_windows, then computer_get_state with window_id. Reuse the launch result\'s window id. If it is null, use computer_list_windows({app:"App Name"}) to inspect only that app, never dump unrelated windows. A short stable sequence can run as ordered awaited tool calls in one script; stop on any refusal. Use include_screenshot:false for intermediate actions and verify once at the end. Prefer elements for verification; add include_text or an image only when elements are insufficient. Do not request both a final action screenshot and an identical separate screenshot.',
    'Common start: computer_launch_app({app:"Calculator"}) returns window.id; computer_get_state({window_id:id}) returns elements without an image; computer_click({window_id:id,label:"exact observed label",role:"AXButton",delivery_mode:"foreground",include_screenshot:false}) presses one observed control. These are argument examples, not permission to guess controls. Use the tools under their provider-exposed names. Discover only additional tools or arguments when needed.',
    "### Pointing at the desktop",
    "Observe before acting. Prefer label and role from computer_get_state. For x/y use pixel coordinates in a screenshot you received, optionally named by screenshot_id. Never convert screenshot pixels into desktop coordinates. Observe again after the window or controls move.",
    "### Aiming the keyboard",
    "Pass window_id to select an exact input target; otherwise keys go to the last aimed window. The drawn cursor does not aim keys. Background delivery may affect app focus and does not isolate human input. Foreground delivery and switching apps are covered by the active task's Computer consent and approval mode. When asked to open and use an app visibly, choose delivery_mode:foreground from the first mutation; use background when the user requests background work. Do not change delivery mode to replay an uncertain action. Never rearrange unrelated windows or bypass an input pause. focused means selected input target; active reports native activation when known.",
    "### The screenshot on every action",
    `Use returned post-action observations, capped at ${COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION} pixels, for the next step. Use include_screenshot:false for intermediate actions or when a final text observation verifies the result. Inspect the final result. screenshotUnchanged reuses the previous image and mapping, not that the action failed. targetWindowClosed means the target is gone. Use computer_wait for a known next control; request computer_screenshot detail when needed, not after every keystroke.`,
    "### Reading a delivery verdict",
    DELIVERY_VERDICT_GUIDANCE,
    "### When a computer tool refuses",
    "For computer_target_ambiguous narrow the target; for stale or missing targets observe again. computer_controlled_by_other_thread means wait, not compete. When input is paused, stop mutations and hand back to the user; check window readiness after return. Missing permission or ComputerApprovalRequired needs user attention. Only effect=not-dispatched proves no input; effect=dispatched-unknown means inspect and never blindly replay. Never automatically retry an unknown effect or escalate it to foreground.",
    "### Form progress and handback",
    "Read existing values, group missing choices, prefer set_value for editable controls, and verify meaningful section boundaries. Never blindly repeat typing or toggles. If submission is forbidden avoid Enter in dropdowns: click an option, use Tab/Escape and verify. Distinguish verified, uncertain and missing values at handback; preserve the user's submission boundary.",
  ].join("\n");
}
