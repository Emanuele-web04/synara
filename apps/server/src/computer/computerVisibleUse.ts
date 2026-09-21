import type { OrchestrationMessage } from "@synara/contracts";

/**
 * Whether one computer task may move a window in front of the user.
 *
 * The never-raise default is the containment the Helium incident demanded: a
 * task that said "use Helium" was never asked to *show* Helium, yet the run
 * raised it, then ran twenty-one foreground excursions through it while the
 * user was typing. Raising is therefore opt-in per task, and the opt-in is the
 * user's own request or direct confirmation — not the model's judgment, not
 * the approval mode, not `full-access`.
 *
 * The answer is reconstructed from durable human messages in this task.
 * Explicit consent survives a chain of routine continuations; a new task,
 * stop, background request, imported history or nonhuman dispatch ends it.
 * There is no thread-wide grant that a later unrelated turn can inherit.
 */
export interface ComputerForegroundAuthorization {
  /** The user explicitly requested or confirmed visible use for the current task. */
  readonly userRequestedVisibleUse: boolean;
}

export interface ComputerForegroundContext {
  /** Names from the desktop's observed app inventory, never model arguments or window titles. */
  readonly knownAppNames?: readonly string[];
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
  /\b(?:bring|put|move)\b[^.!?]{0,40}\b(?:front|foreground)(?=\s*(?:[.!?,;:]|$))/i,
  /\buse (?:the )?foreground(?: mode)?(?=\s*(?:[.!?,;:]|$))/i,
  /\btake over (?:my|the) (?:screen|desktop|computer)\b/i,
  /\bdrive (?:my|the) (?:screen|desktop|computer)\b/i,
  /\b(?:mostra(?:mi|re)?|porta(?:re)?|metti|mettere)\b[^.!?\n]{0,60}\b(?:sullo schermo|in primo piano)\b/i,
  /\bvoglio vedere (?:la finestra|il browser|lo schermo|il desktop)\b/i,
];

// Explicit background/negative instructions take precedence, even when the
// message also contains a visible-use phrase. Ambiguous requests stay hidden.
const BACKGROUND_USE_PATTERNS: readonly RegExp[] = [
  /\b(?:do not|don['’]t|never|not|avoid|without|stop)\b[^.!?\n]{0,100}\b(?:show|watch|visible|foreground|front|focus|raise|screen|desktop)\b/i,
  /\b(?:keep|stay|remain|work|run|use)\b[^.!?\n]{0,60}\b(?:background|hidden|invisible)\b/i,
  /\bbackground[- ]only\b/i,
  /\b(?:non|senza|evita|smetti di)\b[^.!?\n]{0,100}\b(?:mostrare|mostrarmi|primo piano|schermo|focus)\b/i,
  /\b(?:lavora|resta|rimani|mantieni)\b[^.!?\n]{0,60}\b(?:background|nascost[ao])\b/i,
];

function unquotedRequest(text: string): string {
  return text
    .replace(/<untrusted_text\b[^>]*>[\s\S]*?(?:<\/untrusted_text>|$)/gi, "")
    .replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, "")
    .replace(/(^|[\s(])'[^'\n]+'(?=$|[\s.,;:)])/g, "$1")
    .replace(/^\s*>.*$/gm, "");
}

function requestsKnownAppVisibility(text: string, context: ComputerForegroundContext): boolean {
  const app = text
    .trim()
    .match(/^(?:please[, ]+)?(?:show(?: me)?|display|mostra(?:mi)?)\s+(.+?)[.!?]*$/iu)?.[1];
  if (!app) return false;
  const name = app.trim().toLocaleLowerCase();
  return (
    context.knownAppNames?.some((candidate) => candidate.trim().toLocaleLowerCase() === name) ===
    true
  );
}

/** Whether one message text explicitly asks to see the desktop. Pure. */
export function messageRequestsVisibleUse(
  text: string,
  context: ComputerForegroundContext = {},
): boolean {
  const request = unquotedRequest(text);
  return (
    !BACKGROUND_USE_PATTERNS.some((pattern) => pattern.test(request)) &&
    (VISIBLE_USE_PATTERNS.some((pattern) => pattern.test(request)) ||
      requestsKnownAppVisibility(request, context))
  );
}

function isAffirmativeReply(text: string): boolean {
  return /^(?:yes|yeah|yep|ok(?:ay)?|sure|go ahead|s[iì]|va bene|certo|procedi|vai)(?:[, ]+(?:please|go ahead|per favore|fallo))?[.!]*$/iu.test(
    text.trim(),
  );
}

function asksVisibleUsePermission(text: string, context: ComputerForegroundContext): boolean {
  const question = unquotedRequest(text).trim();
  // Take only the final, standalone permission question. General task
  // approval ("continue?") and statements about visible use do not qualify.
  const action = question.match(
    /(?:^|[.!?]\s+)(?:can i|may i|shall i|do you want me to|would you like me to|is it (?:ok(?:ay)?|alright) (?:if i|to)|posso|vuoi che)\s+([^?]*\?)$/iu,
  )?.[1];
  return action !== undefined && messageRequestsVisibleUse(action, context);
}

function isLocalHumanMessage(message: OrchestrationMessage): boolean {
  return (
    message.role === "user" &&
    message.dispatchOrigin !== "automation" &&
    message.dispatchOrigin !== "agent" &&
    (message.source === "native" || message.source === "async-user-input")
  );
}

function isLocalAssistantMessage(
  message: OrchestrationMessage | undefined,
): message is OrchestrationMessage {
  return message?.role === "assistant" && message.source === "native" && !message.streaming;
}

/** A short affirmative answers one direct visibility question, never quoted page text. */
function confirmsVisibleUse(
  reply: OrchestrationMessage,
  preceding: OrchestrationMessage | undefined,
  context: ComputerForegroundContext,
): boolean {
  return (
    isLocalAssistantMessage(preceding) &&
    isAffirmativeReply(reply.text) &&
    asksVisibleUsePermission(preceding.text, context)
  );
}

/** The persisted answer names its exact response message; generated question text is not consent. */
function confirmsStructuredVisibleUse(
  messages: readonly OrchestrationMessage[],
  replyIndex: number,
  context: ComputerForegroundContext,
): boolean {
  const reply = messages[replyIndex]!;
  for (let index = replyIndex - 1; index >= 0; index -= 1) {
    const question = messages[index]!;
    // Answering a stale card from an earlier user task must not grant the new task visibility.
    if (question.role === "user") return false;
    const input = question.asyncUserInput;
    if (input?.response?.messageId !== reply.id) continue;
    return (
      isLocalAssistantMessage(question) &&
      input.questions.length === 1 &&
      input.response.answers.length === 1 &&
      isAffirmativeReply(input.response.answers[0]!) &&
      asksVisibleUsePermission(input.questions[0]!.title, context)
    );
  }
  return false;
}

/** Only a whole, scope-preserving reply may carry earlier consent into this turn. */
function isRoutineContinuation(message: OrchestrationMessage): boolean {
  if (message.attachments?.length || message.skills?.length || message.mentions?.length)
    return false;
  return /^(?:(?:ok(?:ay)?|yes|s[iì])[, ]+)?(?:please[, ]+)?(?:continue(?: (?:working|with (?:the |this |our )?(?:same |current )?(?:task|work|plan)))?|keep (?:going|working)|carry on|go (?:on|ahead)|proceed(?: with (?:the |this |our )?(?:same |current )?(?:task|work|plan))?|(?:try|retry)(?: (?:again|that|it|the same step))?|continua(?: pure)?|prosegui|procedi|vai|riprova)(?:[, ]+(?:please|per favore))?[.!]*$/iu.test(
    message.text.trim(),
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
 * Reconstruct this task's grant, stopping at the first human scope change.
 * Routine continuations preserve an explicit grant; they cannot create one.
 * A new task, refusal or nonhuman/imported turn is a barrier, so a later
 * "continue" cannot recover consent from an unrelated historical task.
 */
export function computerForegroundAuthorizationForMessages(
  messages: readonly OrchestrationMessage[],
  context: ComputerForegroundContext = {},
): ComputerForegroundAuthorization {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (!isLocalHumanMessage(message)) return COMPUTER_FOREGROUND_NOT_AUTHORIZED;
    if (message.source === "async-user-input") {
      return { userRequestedVisibleUse: confirmsStructuredVisibleUse(messages, index, context) };
    }
    if (
      messageRequestsVisibleUse(message.text, context) ||
      confirmsVisibleUse(message, messages[index - 1], context)
    ) {
      return { userRequestedVisibleUse: true };
    }
    if (!isRoutineContinuation(message)) return COMPUTER_FOREGROUND_NOT_AUTHORIZED;
  }
  return COMPUTER_FOREGROUND_NOT_AUTHORIZED;
}
