// ProviderRuntimeIngestion settles the session before flushing buffered assistant finals; a session-set-sequence snapshot can look terminal before the reply projects — retiring the fence there leaves a spinner until reload (#548)

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

  if (input.snapshotSequence < input.fenceSequence) return false;

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

  // the global sequence can advance via other threads while this turn's final is still buffered — the expected assistant row, not sequence advancement, proves the reply is visible; only genuinely empty turns may retire after the hold
  if (latestTurn.assistantMessageId !== null) return false;
  return input.nowMs - input.armedAtMs >= TERMINAL_FENCE_EMPTY_TURN_HOLD_MS;
}
