export type TerminalTurnApplicability =
  | {
      readonly applicable: false;
      readonly resolvedTurnId: string | undefined;
      readonly reason: "conflicts-with-active-turn" | "ambiguous-missing-turn-id";
    }
  | {
      readonly applicable: true;
      readonly resolvedTurnId: string | undefined;
      readonly reason: "matches-active-turn" | "implicit-active-turn" | "no-active-turn";
    };

// A started event may confirm the current turn, but it must never transfer
// lifecycle ownership from one active turn to another. Missing identity stays
// applicable for providers that do not expose a turn id on every event.
export function isStartedTurnApplicable(input: {
  readonly activeTurnId: string | null | undefined;
  readonly eventTurnId: string | null | undefined;
}): boolean {
  const activeTurnId = input.activeTurnId ?? undefined;
  const eventTurnId = input.eventTurnId ?? undefined;
  return activeTurnId === undefined || eventTurnId === undefined || activeTurnId === eventTurnId;
}

// Terminal events can arrive after a newer turn has become active. Keep the
// event's own turn id for per-turn cleanup, but only let the current turn (or
// an intentionally unscoped terminal event) mutate thread lifecycle state.
export function classifyTerminalTurnApplicability(input: {
  readonly activeTurnId: string | null | undefined;
  readonly eventTurnId: string | null | undefined;
  readonly hasAmbiguousTurns?: boolean;
}): TerminalTurnApplicability {
  const activeTurnId = input.activeTurnId ?? undefined;
  const eventTurnId = input.eventTurnId ?? undefined;

  if (activeTurnId !== undefined && eventTurnId !== undefined) {
    return eventTurnId === activeTurnId
      ? {
          applicable: true,
          resolvedTurnId: eventTurnId,
          reason: "matches-active-turn",
        }
      : {
          applicable: false,
          resolvedTurnId: eventTurnId,
          reason: "conflicts-with-active-turn",
        };
  }

  if (activeTurnId !== undefined) {
    if (input.hasAmbiguousTurns === true) {
      return {
        applicable: false,
        resolvedTurnId: undefined,
        reason: "ambiguous-missing-turn-id",
      };
    }
    return {
      applicable: true,
      resolvedTurnId: activeTurnId,
      reason: "implicit-active-turn",
    };
  }

  return {
    applicable: true,
    resolvedTurnId: eventTurnId,
    reason: "no-active-turn",
  };
}
