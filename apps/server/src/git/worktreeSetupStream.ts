import type {
  GitCreateDetachedWorktreeResult,
  GitWorktreeSetupPhase,
  GitWorktreeSetupProgressEvent,
  WsRpcError,
} from "@synara/contracts";
import { type Cause, Effect, Queue, Stream } from "effect";

/**
 * Streams one detached worktree creation: each setup phase as it begins, then
 * `completed` as soon as the creation succeeds.
 *
 * The first send links its thread to the new worktree only once `completed`
 * arrives, so the follow-up status refresh (`git status` plus a pull-request
 * lookup through the shared GitHub read gate) must not delay it. The refresh
 * starts only after a successful creation, before `completed` is queued so that
 * ending the stream cannot interrupt it; `refreshStatusInBackground` must fork
 * detached so the refresh outlives the stream and a disconnecting client. A
 * failed or interrupted creation fails the stream and refreshes nothing.
 */
export const makeDetachedWorktreeSetupStream = <E, R>(input: {
  readonly progressId: string | null;
  readonly create: (
    onPhase: (phase: GitWorktreeSetupPhase) => Effect.Effect<void>,
  ) => Effect.Effect<GitCreateDetachedWorktreeResult, E, R>;
  readonly refreshStatusInBackground: Effect.Effect<void>;
  readonly toError: (cause: Cause.Cause<E>) => WsRpcError;
}): Stream.Stream<GitWorktreeSetupProgressEvent, WsRpcError, R> =>
  Stream.callback<GitWorktreeSetupProgressEvent, WsRpcError, R>((queue) => {
    const { progressId } = input;
    return input
      .create((phase) =>
        Queue.offer(queue, { kind: "phase_started", progressId, phase }).pipe(Effect.asVoid),
      )
      .pipe(
        Effect.tap(() => input.refreshStatusInBackground),
        Effect.matchCauseEffect({
          onFailure: (cause) => Queue.fail(queue, input.toError(cause)),
          onSuccess: (result) =>
            Queue.offer(queue, { kind: "completed", progressId, result }).pipe(
              Effect.andThen(Queue.end(queue)),
              Effect.asVoid,
            ),
        }),
      );
  });
