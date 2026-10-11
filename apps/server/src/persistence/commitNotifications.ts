import { Effect, Option, ServiceMap } from "effect";

class CommitNotifications extends ServiceMap.Service<
  CommitNotifications,
  { readonly enqueue: (notification: Effect.Effect<void>) => void }
>()("synara/persistence/CommitNotifications") {}

/** Run normally, or defer a notification until the enclosing transaction commits. */
export const notifyAfterCommit = (notification: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pending = yield* Effect.serviceOption(CommitNotifications);
    if (Option.isSome(pending)) {
      pending.value.enqueue(notification);
    } else {
      yield* notification;
    }
  });

/** The supplied effect must own the transaction boundary. Failed transactions
 * discard notifications; successful ones flush outside the SQL connection
 * context, so background work cannot inherit a released transaction. Once
 * committed, notification defects must never turn success into compensation. */
export const withCommitNotifications = <A, E, R>(transaction: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const pending: Array<Effect.Effect<void>> = [];
    const result = yield* transaction.pipe(
      Effect.provideService(CommitNotifications, {
        enqueue: (notification) => pending.push(notification),
      }),
    );
    yield* Effect.forEach(
      pending,
      (notification) =>
        notification.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Post-commit notification failed", cause)),
        ),
      { discard: true },
    ).pipe(Effect.uninterruptible);
    return result;
  });
