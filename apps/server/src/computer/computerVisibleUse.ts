import type { OrchestrationMessage } from "@synara/contracts";

/**
 * Whether one computer task may move a window in front of the user.
 *
 * The never-raise default is the containment the Helium incident demanded: a
 * task that said "use Helium" was never asked to *show* Helium, yet the run
 * raised it, then ran twenty-one foreground excursions through it while the
 * user was typing. Raising is therefore opt-in per task, and the opt-in is the
 * user's own words — not the model's judgment, not the approval mode, not
 * `full-access`.
 *
 * The answer is computed from the thread's latest user-authored message:
 * the same opening line the consent model already treats as the task, read
 * fresh on every foreground call so a user reply that authorizes visibility
 * ("yes, show me the browser") takes effect immediately, and a reply that does not
 * ("stop") revokes it just as fast.
 */
export interface ComputerForegroundAuthorization {
  /** The user's own latest task text explicitly asked to see the screen. */
  readonly userRequestedVisibleUse: boolean;
}

/** The authorization a call carries when nothing asked for visible use. */
export const COMPUTER_FOREGROUND_NOT_AUTHORIZED: ComputerForegroundAuthorization = {
  userRequestedVisibleUse: false,
};

/** Refusal code: the task never asked to see the app or window. */
export const COMPUTER_FOREGROUND_NOT_REQUESTED_CODE = "foreground_not_requested";

/** Refusal code: the user was interacting with the desktop moments ago. */
export const COMPUTER_FOREGROUND_USER_INTERACTION_CODE = "foreground_user_interaction";

/**
 * How long after the user's own desktop input a foreground excursion is
 * refused. The desktop queue already serializes pane input and agent calls, so
 * this window only has to cover rapid interleaving — the user clicking or
 * typing through the computer pane while the agent works. Two seconds is the
 * measured pace of a click-then-read cycle and stays short enough that an
 * authorized task resumes promptly once the user stops.
 */
export const COMPUTER_USER_INTERACTION_QUIET_MS = 2_000;

/**
 * The phrases that count as the user asking to see the desktop. Deliberately
 * explicit and visible-use-only: "use Chrome" is not "show me Chrome", and a
 * task that only names an app stays background. A false negative costs one
 * refusal that asks the model to have the user confirm; a false positive
 * re-opens the exact focus theft this gate exists to stop, so the list errs
 * toward refusing.
 */
const VISIBLE_USE_PATTERNS: readonly RegExp[] = [
  /\bshow (?:me )?(?:the |my )?(?:[\w-]+ ){0,3}(?:window|app|screen|desktop|browser|page)(?=\s*(?:[.!?,;:]|$))/i,
  /\bshow me what you(?: are|'re) doing\b/i,
  /\b(?:i (?:want|would like|'d like) to |let me )watch (?:you|it|the (?:app|browser|window))\b/i,
  /\blet me see (?:it|you) work(?:ing)?\b/i,
  /\bi (?:want|would like|'d like) to see (?:the |my )?(?:[\w-]+ ){0,3}(?:window|app|screen|desktop|browser|page)(?=\s*(?:[.!?,;:]|$))/i,
  /\b(?:put|show|display)\b[^.!?\n]{0,40}\bon (?:my|the) screen\b/i,
  /\b(?:make|keep) (?:it|(?:the |my )?(?:[\w-]+ ){0,3}(?:app|window|browser)) visible\b/i,
  /\b(?:bring|put|move)\b[^.!?]{0,40}\b(?:to the )?front(?=\s*(?:[.!?,;:]|$))/i,
  /\buse (?:the )?foreground(?: mode)?(?=\s*(?:[.!?,;:]|$))/i,
  /\btake over (?:my|the) (?:screen|desktop|computer)\b/i,
  /\bdrive (?:my|the) (?:screen|desktop|computer)\b/i,
];

// Explicit background/negative instructions take precedence, even when the
// message also contains a visible-use phrase. Ambiguous requests stay hidden.
const BACKGROUND_USE_PATTERNS: readonly RegExp[] = [
  /\b(?:do not|don['’]t|never|not|avoid|without|stop)\b[^.!?\n]{0,100}\b(?:show|watch|visible|foreground|front|focus|raise|screen|desktop)\b/i,
  /\b(?:keep|stay|remain|work|run|use)\b[^.!?\n]{0,60}\b(?:background|hidden|invisible)\b/i,
  /\bbackground[- ]only\b/i,
];

/** Whether one message text explicitly asks to see the desktop. Pure. */
export function messageRequestsVisibleUse(text: string): boolean {
  const request = text
    .replace(/```[\s\S]*?```|`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, "")
    .replace(/^\s*>.*$/gm, "");
  return (
    !BACKGROUND_USE_PATTERNS.some((pattern) => pattern.test(request)) &&
    VISIBLE_USE_PATTERNS.some((pattern) => pattern.test(request))
  );
}

/**
 * The latest user-authored message in a thread's message list, or undefined
 * when the thread has none. Automation- and agent-dispatched messages are
 * skipped: only a person's own words can authorize visible use.
 */
export function latestUserAuthoredMessage(
  messages: readonly OrchestrationMessage[],
): OrchestrationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (message.dispatchOrigin === "automation" || message.dispatchOrigin === "agent") continue;
    return message;
  }
  return undefined;
}

/**
 * The authorization a thread's current task carries. The message list is the
 * projection's ascending order; only the newest user message decides, so an
 * earlier "show me" cannot authorize a later background-only task and a later
 * "stop" revokes an earlier one.
 */
export function computerForegroundAuthorizationForMessages(
  messages: readonly OrchestrationMessage[],
): ComputerForegroundAuthorization {
  const latest = latestUserAuthoredMessage(messages);
  return {
    userRequestedVisibleUse: latest !== undefined && messageRequestsVisibleUse(latest.text),
  };
}
