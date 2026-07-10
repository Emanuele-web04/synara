// FILE: AcpAdapterSessionSupport.ts
// Purpose: Shares ACP adapter bookkeeping that is independent of a provider's transport details.
// Layer: Provider ACP adapter support
// Exports: pending-request cleanup, USD cost parsing, and turn-local item scoping helpers.

import type { ProviderApprovalDecision, ProviderUserInputAnswers, TurnId } from "@synara/contracts";
import { Deferred, Effect, Option, Semaphore, SynchronizedRef } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

export interface AcpThreadLock {
  <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

// Serializes lifecycle mutations per thread while allowing unrelated ACP sessions to proceed.
export function makeAcpThreadLock(): Effect.Effect<AcpThreadLock> {
  return SynchronizedRef.make(new Map<string, Semaphore.Semaphore>()).pipe(
    Effect.map((locksRef) => {
      const get = (threadId: string) =>
        SynchronizedRef.modifyEffect(locksRef, (current) => {
          const existing = Option.fromNullishOr(current.get(threadId));
          return Option.match(existing, {
            onNone: () =>
              Semaphore.make(1).pipe(
                Effect.map((semaphore) => {
                  const next = new Map(current);
                  next.set(threadId, semaphore);
                  return [semaphore, next] as const;
                }),
              ),
            onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
          });
        });
      return (<A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(get(threadId), (semaphore) =>
          semaphore.withPermit(effect),
        )) satisfies AcpThreadLock;
    }),
  );
}

// Resolves outstanding permission requests before an ACP child is closed.
export function settleAcpPendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<
    unknown,
    { readonly decision: Deferred.Deferred<ProviderApprovalDecision> }
  >,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

// Resolves outstanding elicitation requests so shutdown cannot strand their handlers.
export function settleAcpPendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<
    unknown,
    { readonly answers: Deferred.Deferred<ProviderUserInputAnswers> }
  >,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

// Accepts only finite, non-negative USD totals from ACP cost notifications.
export function readAcpUsdCost(cost: EffectAcpSchema.Cost | null | undefined): number | undefined {
  if (!cost || cost.currency.toUpperCase() !== "USD" || !Number.isFinite(cost.amount)) {
    return undefined;
  }
  return cost.amount >= 0 ? cost.amount : undefined;
}

export function scopeAcpRuntimeItemIdForTurn(
  provider: string,
  turnId: TurnId,
  itemId: string,
): string {
  return `${provider}:${turnId}:${itemId}`;
}

// Preserves the provider-native tool id while making the public runtime id turn-local.
export function scopeAcpToolCallStateForTurn(
  provider: string,
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return {
    ...toolCall,
    toolCallId: scopeAcpRuntimeItemIdForTurn(provider, turnId, toolCall.toolCallId),
    data: {
      ...toolCall.data,
      providerToolCallId: toolCall.toolCallId,
    },
  };
}
