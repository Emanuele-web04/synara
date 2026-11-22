// FILE: delegationSettle.ts
// Purpose: Decides where a delegation stands from the target bot's turns and Hub work: still
//          sent, working, waiting on the user, or settled (completed / failed). Pure, so the
//          reactor can re-run it on every event and after restarts without bookkeeping.
// Layer: Pure domain logic (no I/O)
// Exports: evaluateDelegationSettlement, DELEGATION_SETTLE_GRACE_MS

import type { HubWorkState } from "@synara/contracts";

/**
 * After the target bot's tasks finish, its Hub wakes it once to roll them up. Waiting this long
 * after the last activity lets that wake start before the delegation is reported.
 */
export const DELEGATION_SETTLE_GRACE_MS = 60_000;

export interface SettleTurn {
  readonly turnId: string | null;
  readonly pendingMessageId: string | null;
  readonly state: "pending" | "running" | "interrupted" | "completed" | "error";
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly assistantMessageId: string | null;
}

export interface SettleItem {
  readonly id: string;
  readonly state: HubWorkState;
  readonly delegationTurnId: string | null;
  readonly updatedAt: string;
}

/** A delegation the target bot handed on from its own thread. */
export interface SettleOnward {
  /** The target's turn that handed it on. */
  readonly fromTurnId: string | null;
  /** The report message that wakes the target with its result, once one was sent. */
  readonly reportMessageId: string | null;
  /** When it was reported back, or stopped by the user (then without a report message). */
  readonly reportedAt: string | null;
}

export interface SettleResult {
  readonly state: "sent" | "working" | "waiting" | "settled";
  readonly outcome: "completed" | "failed" | null;
  readonly turnIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly lastAssistantMessageId: string | null;
}

const ACTIVE_ITEM_STATES: ReadonlySet<HubWorkState> = new Set(["queued", "starting", "working"]);
const FAILED_ITEM_STATES: ReadonlySet<HubWorkState> = new Set(["failed", "cancelled"]);

const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

export function evaluateDelegationSettlement(input: {
  /** The delegation's own message in the target bot's thread. */
  readonly messageId: string;
  readonly turns: readonly SettleTurn[];
  /** Pending messages of later turns that belong to the delegation (the Hub's own wakes). */
  readonly attributableMessageIds: ReadonlySet<string>;
  readonly items: readonly SettleItem[];
  /**
   * Delegations the target handed on from its thread. Work handed on during the delegation is
   * part of it: the delegation stays open until each such hand-off is reported back and the
   * turn its report wakes has answered, so the asker hears the end of the chain, not its middle.
   */
  readonly onward?: readonly SettleOnward[];
  readonly sessionActiveTurnId: string | null;
  readonly nowMs: number;
  readonly graceMs?: number;
}): SettleResult {
  const graceMs = input.graceMs ?? DELEGATION_SETTLE_GRACE_MS;
  const own = input.turns
    .filter((turn) => turn.pendingMessageId === input.messageId)
    .toSorted((left, right) => time(left.requestedAt) - time(right.requestedAt));
  if (own.length === 0) {
    return { state: "sent", outcome: null, turnIds: [], itemIds: [], lastAssistantMessageId: null };
  }
  const startedAt = time(own[0]!.requestedAt);
  const reportIds = new Set<string>();
  const belongs = (turn: SettleTurn) =>
    turn.pendingMessageId === input.messageId ||
    (turn.pendingMessageId !== null &&
      (input.attributableMessageIds.has(turn.pendingMessageId) ||
        reportIds.has(turn.pendingMessageId)) &&
      time(turn.requestedAt) >= startedAt);
  let delegated = input.turns.filter(belongs);
  let turnIdSet = new Set(delegated.flatMap((turn) => (turn.turnId ? [turn.turnId] : [])));
  let onward: readonly SettleOnward[] = [];
  // A hand-off's report wakes the target in a turn of its own, which may hand work on again:
  // follow the reports until no new turn joins.
  for (;;) {
    onward = (input.onward ?? []).filter(
      (child) => child.fromTurnId !== null && turnIdSet.has(child.fromTurnId),
    );
    const before = reportIds.size;
    for (const child of onward) {
      if (child.reportMessageId !== null) reportIds.add(child.reportMessageId);
    }
    if (reportIds.size === before) break;
    delegated = input.turns.filter(belongs);
    turnIdSet = new Set(delegated.flatMap((turn) => (turn.turnId ? [turn.turnId] : [])));
  }
  const turnIds = [...turnIdSet];
  const woken = new Set(delegated.map((turn) => turn.pendingMessageId));
  // Still owed: not reported yet, or reported while the turn its report wakes has not shown up
  // (a report queued behind another active turn keeps holding until that turn finishes; once
  // idle, a report that never wakes anyone stops holding the delegation after the grace window).
  const onwardOpen = onward.some(
    (child) =>
      child.reportedAt === null ||
      (child.reportMessageId !== null &&
        !woken.has(child.reportMessageId) &&
        (input.sessionActiveTurnId !== null || input.nowMs - time(child.reportedAt) < graceMs)),
  );
  const items = input.items.filter(
    (item) => item.delegationTurnId !== null && turnIdSet.has(item.delegationTurnId),
  );
  const itemIds = items.map((item) => item.id);
  const running =
    delegated.some((turn) => turn.state === "pending" || turn.state === "running") ||
    (input.sessionActiveTurnId !== null && turnIdSet.has(input.sessionActiveTurnId));
  const lastAssistantMessageId =
    delegated
      .filter((turn) => turn.assistantMessageId !== null)
      .toSorted((left, right) => time(left.completedAt) - time(right.completedAt))
      .at(-1)?.assistantMessageId ?? null;
  const base = { turnIds, itemIds, lastAssistantMessageId };
  if (running || onwardOpen || items.some((item) => ACTIVE_ITEM_STATES.has(item.state))) {
    return { state: "working", outcome: null, ...base };
  }
  if (items.some((item) => item.state === "waiting")) {
    return { state: "waiting", outcome: null, ...base };
  }
  if (items.length > 0) {
    const lastItemUpdatedAt = Math.max(...items.map((item) => time(item.updatedAt)));
    // Once a Hub wake turn has already rolled up the finished tasks, settle without waiting
    // out the full 60s grace window.
    const rolledUpAfterTasks = delegated.some(
      (turn) =>
        turn.pendingMessageId !== input.messageId &&
        turn.state === "completed" &&
        time(turn.completedAt) >= lastItemUpdatedAt,
    );
    if (!rolledUpAfterTasks) {
      const lastActivity = Math.max(
        lastItemUpdatedAt,
        ...delegated.map((turn) => time(turn.completedAt)),
      );
      if (input.nowMs - lastActivity < graceMs) {
        return { state: "working", outcome: null, ...base };
      }
    }
  }
  const latestOnwardWake = delegated
    .filter((turn) => turn.pendingMessageId !== null && reportIds.has(turn.pendingMessageId))
    .toSorted((left, right) => time(left.requestedAt) - time(right.requestedAt))
    .at(-1);
  const onwardWakeFailed =
    latestOnwardWake !== undefined &&
    (latestOnwardWake.state === "error" || latestOnwardWake.state === "interrupted");
  const turnsFailed =
    (delegated.every((turn) => turn.state === "error" || turn.state === "interrupted") &&
      items.length === 0) ||
    onwardWakeFailed;
  const itemsFailed = items.length > 0 && items.every((item) => FAILED_ITEM_STATES.has(item.state));
  return {
    state: "settled",
    outcome: turnsFailed || itemsFailed ? "failed" : "completed",
    ...base,
  };
}
