/**
 * Shared session-lifecycle helpers for ACP provider adapters.
 *
 * @module AcpAdapterSessionSupport
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { Deferred, Effect, Option, Semaphore, SynchronizedRef } from "effect";

export function settlePendingApprovalsAsCancelled(
  pendingApprovals: Map<
    ApprovalRequestId,
    { readonly decision: Deferred.Deferred<ProviderApprovalDecision> }
  >,
): Effect.Effect<void> {
  return Effect.forEach(
    [...pendingApprovals.values()],
    (pending) => Deferred.succeed(pending.decision, "cancel" as const),
    { discard: true },
  ).pipe(Effect.andThen(Effect.sync(() => pendingApprovals.clear())));
}

export function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: Map<
    ApprovalRequestId,
    { readonly answers: Deferred.Deferred<ProviderUserInputAnswers> }
  >,
): Effect.Effect<void> {
  return Effect.forEach(
    [...pendingUserInputs.values()],
    (pending) => Deferred.succeed(pending.answers, {}),
    { discard: true },
  ).pipe(Effect.andThen(Effect.sync(() => pendingUserInputs.clear())));
}

export function makeAcpThreadLock(
  threadLocksRef: SynchronizedRef.SynchronizedRef<Map<string, Semaphore.Semaphore>>,
) {
  const getThreadSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
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

  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  return { withThreadLock };
}
