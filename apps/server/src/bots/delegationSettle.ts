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
  const delegated = input.turns.filter(
    (turn) =>
      turn.pendingMessageId === input.messageId ||
      (turn.pendingMessageId !== null &&
        input.attributableMessageIds.has(turn.pendingMessageId) &&
        time(turn.requestedAt) >= startedAt),
  );
  const turnIds = delegated.flatMap((turn) => (turn.turnId ? [turn.turnId] : []));
  const turnIdSet = new Set(turnIds);
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
  if (running || items.some((item) => ACTIVE_ITEM_STATES.has(item.state))) {
    return { state: "working", outcome: null, ...base };
  }
  if (items.some((item) => item.state === "waiting")) {
    return { state: "waiting", outcome: null, ...base };
  }
  if (items.length > 0) {
    const lastActivity = Math.max(
      ...items.map((item) => time(item.updatedAt)),
      ...delegated.map((turn) => time(turn.completedAt)),
    );
    if (input.nowMs - lastActivity < graceMs) {
      return { state: "working", outcome: null, ...base };
    }
  }
  const turnsFailed =
    delegated.every((turn) => turn.state === "error" || turn.state === "interrupted") &&
    items.length === 0;
  const itemsFailed = items.length > 0 && items.every((item) => FAILED_ITEM_STATES.has(item.state));
  return {
    state: "settled",
    outcome: turnsFailed || itemsFailed ? "failed" : "completed",
    ...base,
  };
}
