import type {
  EventId,
  MessageId,
  OrchestrationThreadActivityHistoryCursor,
  OrchestrationThreadHistoryCursor,
  OrchestrationThreadMessageWindow,
  TurnId,
} from "@synara/contracts";

export interface ThreadHistoryMessageIdentity {
  messageId: MessageId;
  createdAt: string;
  sequence: number | null;
  turnId: TurnId | null;
  role: string;
}

/** Match SQLite BINARY collation, including supplementary Unicode IDs. */
function compareSqlText(a: string, b: string): number {
  if (a === b) return 0;
  const first = new TextEncoder().encode(a);
  const second = new TextEncoder().encode(b);
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    const order = first[index]! - second[index]!;
    if (order) return order;
  }
  return first.length - second.length;
}

export function compareHistoryMessageOrder(
  a: OrchestrationThreadHistoryCursor,
  b: OrchestrationThreadHistoryCursor,
): number {
  return (
    Number(a.sequence !== null) - Number(b.sequence !== null) ||
    (a.sequence ?? 0) - (b.sequence ?? 0) ||
    compareSqlText(a.createdAt, b.createdAt) ||
    compareSqlText(a.messageId, b.messageId)
  );
}

/** Select identities before reading text; include every member of boundary turns. */
export function selectThreadHistoryWindow(
  rows: readonly ThreadHistoryMessageIdentity[],
  window: OrchestrationThreadMessageWindow,
  activeTurnId: TurnId | null,
) {
  const end = window.before
    ? rows.findIndex((row) => compareHistoryMessageOrder(row, window.before!) >= 0)
    : rows.length;
  const through = end < 0 ? rows.length : end;
  const start = expandTurnWindowStart(
    rows,
    Math.max(0, through - window.limit),
    through,
    window.before ? null : activeTurnId,
  );
  const selected = rows.slice(start, through);
  const oldest = selected[0];
  return {
    messageIds: selected.map((row) => row.messageId),
    history: {
      totalMessageCount: rows.length,
      olderCursor:
        start > 0 && oldest
          ? { messageId: oldest.messageId, createdAt: oldest.createdAt, sequence: oldest.sequence }
          : null,
    },
  };
}

function expandTurnWindowStart(
  rows: readonly { turnId: TurnId | null }[],
  start: number,
  through: number,
  activeTurnId: TurnId | null,
) {
  if (activeTurnId) {
    const activeStart = rows.findIndex((row) => row.turnId === activeTurnId);
    if (activeStart >= 0) start = Math.min(start, activeStart);
  }
  // Queued requests may interleave turns. Expanding repeatedly closes any turn
  // whose later messages overlap the window, including its original request.
  while (start > 0) {
    const turns = new Set(
      rows.slice(start, through).flatMap((row) => (row.turnId ? [row.turnId] : [])),
    );
    let expanded = start;
    for (let index = 0; index < start; index++) {
      if (rows[index]?.turnId && turns.has(rows[index]!.turnId!)) {
        expanded = index;
        break;
      }
    }
    if (expanded === start) break;
    start = expanded;
  }
  return start;
}

/** Activity counters have mixed sources; use stable time/id for this independent page boundary. */
export function selectThreadActivityHistoryWindow(
  rows: readonly { activityId: EventId; createdAt: string; turnId: TurnId | null }[],
  limit: number,
  before: OrchestrationThreadActivityHistoryCursor | undefined,
  activeTurnId: TurnId | null,
) {
  const boundary = before
    ? rows.findIndex(
        (row) =>
          compareSqlText(row.createdAt, before.createdAt) > 0 ||
          (row.createdAt === before.createdAt &&
            compareSqlText(row.activityId, before.activityId) >= 0),
      )
    : rows.length;
  const through = boundary < 0 ? rows.length : boundary;
  const start = expandTurnWindowStart(
    rows,
    Math.max(0, through - limit),
    through,
    before ? null : activeTurnId,
  );
  const selected = rows.slice(start, through);
  const oldest = selected[0];
  return {
    activityIds: selected.map((row) => row.activityId),
    totalActivityCount: rows.length,
    olderActivityCursor:
      start > 0 && oldest ? { activityId: oldest.activityId, createdAt: oldest.createdAt } : null,
  };
}
