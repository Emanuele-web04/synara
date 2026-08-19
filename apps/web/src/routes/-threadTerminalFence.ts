// FILE: -threadTerminalFence.ts
// Purpose: Decide when a terminal-session fence can be retired after projection reconcile.
// Layer: Web EventRouter helper
// Why: ProviderRuntimeIngestion settles the session before it flushes buffered
//      assistant finals. A snapshot taken at the session-set sequence can look
//      terminal while the reply text has not been projected yet. Clearing the
//      fence there leaves the UI stuck on a spinner until a full reload (#548).

export function isTerminalThreadSessionStatus(status: string): boolean {
  return (
    status === "ready" || status === "interrupted" || status === "stopped" || status === "error"
  );
}

/**
 * Empty completed turns never project a post-settle event, so the fence sequence
 * never advances. After this hold a same-sequence terminal snapshot with no
 * assistant row is allowed to retire the fence. Buffered finals in the same
 * ingestion turn normally advance the sequence long before this elapses.
 */
export const TERMINAL_FENCE_EMPTY_TURN_HOLD_MS = 1_500;

/**
 * A terminal fence armed at `fenceSequence` (the session-set / shell upsert that
 * ended the turn) must keep reconciling until the detail snapshot proves the
 * post-settle assistant finals have been projected — or that none will arrive.
 */
export function doesSnapshotSatisfyTerminalFence(input: {
  readonly snapshotSequence: number;
  readonly fenceSequence: number;
  readonly sessionStatus: string | null | undefined;
  readonly latestTurn: {
    readonly state: string;
    readonly assistantMessageId: string | null;
  } | null;
  readonly messages: ReadonlyArray<{ readonly id: string }>;
  readonly armedAtMs: number;
  readonly nowMs: number;
}): boolean {
  if (
    input.sessionStatus === null ||
    input.sessionStatus === undefined ||
    !isTerminalThreadSessionStatus(input.sessionStatus)
  ) {
    return false;
  }

  // Anything projected after the terminal session-set includes the buffered
  // assistant finalize commands that follow it in the same ingestion turn.
  if (input.snapshotSequence > input.fenceSequence) {
    return true;
  }

  const latestTurn = input.latestTurn;
  if (latestTurn === null) {
    return true;
  }
  if (latestTurn.state === "interrupted" || latestTurn.state === "error") {
    return true;
  }

  if (
    latestTurn.assistantMessageId !== null &&
    input.messages.some((message) => message.id === latestTurn.assistantMessageId)
  ) {
    return true;
  }

  // Still at the session-set sequence without an assistant row. Buffered turns
  // look like this briefly (completed + null assistantMessageId) before finals
  // land; only empty turns stay here permanently, so require the hold window.
  return input.nowMs - input.armedAtMs >= TERMINAL_FENCE_EMPTY_TURN_HOLD_MS;
}
