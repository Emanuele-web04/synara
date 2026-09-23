import { createHash } from "node:crypto";

import type { ComputerAuditEffect } from "@synara/contracts";

export interface ComputerProgressScope {
  readonly threadId: string;
  readonly turnId: string;
  readonly sessionKey?: string;
}

export interface ComputerProgressAction {
  readonly scope: ComputerProgressScope;
  /** Stable resolved target identity, excluding observation/screenshot IDs. */
  readonly targetKey: string;
  /** Stable semantic action identity, excluding observation/screenshot IDs. */
  readonly actionKey: string;
}

export interface ComputerProgressOutcome {
  readonly effect: ComputerAuditEffect;
  readonly code?: string;
}

export interface ComputerProgressBlock {
  readonly code: "repeated_computer_refusal" | "repeated_unverified_action";
  readonly message: string;
  /** This blocked call was not sent; earlier uncertain input may have been. */
  readonly effect: "not-dispatched";
  readonly retryable: false;
  readonly previousInputMayHaveTakenEffect: boolean;
}

interface RefusedAction {
  readonly action: string;
  readonly reason: string;
}

interface TargetHistory {
  readonly uncertainActions: string[];
  readonly refusals: RefusedAction[];
}

const HISTORY_LIMIT = 12;
const REFUSAL_LIMIT = 3;
const CYCLE_REPETITIONS = 3;
const MAXIMUM_CYCLE_LENGTH = 4;
// Admission can recover without a desktop action proving progress (for
// example, another task releases its lease or the user grants a permission).
// These codes are exempt only when the outcome proves no input was sent.
const TRANSIENT_ADMISSION_CODES = new Set([
  "computer_controlled_by_other_thread",
  "computer_busy",
  "native_input_busy",
  "computer_input_paused",
  "desktop_input_paused",
  "input_admission_closed",
  "input_monitor_unavailable",
  "computer_control_revoked",
  "computer_stopped",
  "computer_permission_required",
  "computer_setup_required",
  "browser_requires_setup",
  "approval_denied",
  "approval_unavailable",
  "approval_queue_full",
  "target_not_on_active_space",
  "auth_sheet_focused",
]);

// Retain neither raw arguments nor unbounded strings in long-lived state.
const digest = (value: string): string => createHash("sha256").update(value).digest("base64url");

const scopeKey = (scope: ComputerProgressScope): string =>
  digest(JSON.stringify([scope.threadId, scope.turnId, scope.sessionKey ?? null]));

function appendBounded<T>(entries: T[], value: T): void {
  entries.push(value);
  if (entries.length > HISTORY_LIMIT) entries.shift();
}

function repeatsUncertainCycle(actions: readonly string[], nextAction: string): boolean {
  // Preserve the existing limit: two identical uncertain deliveries do not
  // justify sending a third. Different actions need stronger loop evidence.
  if (actions.at(-1) === nextAction && actions.at(-2) === nextAction) return true;

  for (let period = 2; period <= MAXIMUM_CYCLE_LENGTH; period += 1) {
    const length = period * CYCLE_REPETITIONS;
    const start = actions.length - length;
    if (start < 0 || actions[start] !== nextAction) continue;
    let repeats = true;
    for (let index = start + period; index < actions.length; index += 1) {
      if (actions[index] !== actions[index - period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

function repeatsRefusal(refusals: readonly RefusedAction[], action: string): boolean {
  const reasons = new Map<string, number>();
  for (const refusal of refusals) {
    reasons.set(refusal.reason, (reasons.get(refusal.reason) ?? 0) + 1);
  }
  // A new semantic approach remains available. Once an approach has already
  // received the repeated refusal, alternating it with another cannot evade it.
  return refusals.some(
    (refusal) => refusal.action === action && (reasons.get(refusal.reason) ?? 0) >= REFUSAL_LIMIT,
  );
}

/**
 * Stops confirmed mutation retry patterns, not ordinary multi-step work.
 * Callers record only completed mutations, never this guard's own refusal.
 * Merely obtaining a fresh observation provides no evidence of progress.
 */
export class ComputerProgressGuard {
  private readonly scopes = new Map<string, Map<string, TargetHistory>>();

  constructor(
    private readonly maximumScopes = 256,
    private readonly maximumTargetsPerScope = 8,
  ) {
    for (const limit of [maximumScopes, maximumTargetsPerScope]) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError("Computer progress history limits must be positive integers.");
      }
    }
  }

  check(action: ComputerProgressAction): ComputerProgressBlock | undefined {
    const history = this.scopes.get(scopeKey(action.scope))?.get(digest(action.targetKey));
    if (history === undefined) return undefined;

    const key = digest(action.actionKey);
    const uncertain = repeatsUncertainCycle(history.uncertainActions, key);
    if (!uncertain && !repeatsRefusal(history.refusals, key)) return undefined;

    const previousInputMayHaveTakenEffect = history.uncertainActions.length > 0;
    return {
      code: uncertain ? "repeated_unverified_action" : "repeated_computer_refusal",
      effect: "not-dispatched",
      retryable: false,
      previousInputMayHaveTakenEffect,
      message:
        (uncertain
          ? "A repeated action sequence has no verified effect. This call was not sent. "
          : "This target repeatedly refused the same approaches for the same reason. This call was not sent. ") +
        (previousInputMayHaveTakenEffect
          ? "Earlier input may have taken effect: do not replay it or switch to foreground to retry it. "
          : "Do not repeat these refused actions. ") +
        "Inspect existing evidence and correct the target or use a genuinely different approach; otherwise stop and report the blocker. A fresh screenshot alone does not establish progress.",
    };
  }

  record(action: ComputerProgressAction, outcome: ComputerProgressOutcome): void {
    if (outcome.effect === "verified") {
      this.recordVerifiedProgress(action.scope, action.targetKey);
      return;
    }
    const refused = outcome.effect === "refused" || outcome.effect === "not-dispatched";
    // Neither a no-op nor a transient admission failure arms this guard or
    // erases earlier uncertainty. The admission boundary still enforces them.
    if (refused && (!outcome.code || TRANSIENT_ADMISSION_CODES.has(outcome.code))) return;

    const key = scopeKey(action.scope);
    const targets = this.scopes.get(key) ?? new Map<string, TargetHistory>();
    this.scopes.delete(key);
    this.scopes.set(key, targets);
    while (this.scopes.size > this.maximumScopes) {
      this.scopes.delete(this.scopes.keys().next().value!);
    }

    const target = digest(action.targetKey);
    const history = targets.get(target) ?? { uncertainActions: [], refusals: [] };
    targets.delete(target);
    targets.set(target, history);
    while (targets.size > this.maximumTargetsPerScope) {
      targets.delete(targets.keys().next().value!);
    }

    const actionKey = digest(action.actionKey);
    if (refused) {
      appendBounded(history.refusals, { action: actionKey, reason: digest(outcome.code!) });
    } else {
      // An unclassified error may follow dispatch. Do not treat it as proof
      // that the previous input was harmless or safe to repeat.
      appendBounded(history.uncertainActions, actionKey);
    }
  }

  /** Only an actual observed effect or a successful explicit verification qualifies. */
  recordVerifiedProgress(scope: ComputerProgressScope, targetKey: string): void {
    const key = scopeKey(scope);
    const targets = this.scopes.get(key);
    targets?.delete(digest(targetKey));
    if (targets?.size === 0) this.scopes.delete(key);
  }
}
