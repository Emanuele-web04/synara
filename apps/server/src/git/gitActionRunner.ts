import { createHash } from "node:crypto";

import {
  AuthSessionId,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  WsRpcError,
} from "@synara/contracts";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import { Cause, Effect, Exit, Option, Queue, Stream } from "effect";

import { CurrentManagedAttachmentPrincipal } from "../managedAttachmentPrincipal";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";

type Observer = Queue.Queue<GitActionProgressEvent, WsRpcError | Cause.Done>;
interface Action {
  readonly fingerprint: string;
  readonly observers: Set<Observer>;
  structural: GitActionProgressEvent[];
  latest?: GitActionProgressEvent;
  outcome?: Exit.Exit<void, WsRpcError>;
}

// Receipts are bounded independently of operation size and duration. Missing
// receipts on resume (including after a server restart) must never rerun Git.
const COMPLETED_ACTIONS_TO_KEEP = 256;

export const makeGitActionRunner = (
  run: (
    input: GitRunStackedActionInput,
    publish: (event: GitActionProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<unknown, WsRpcError>,
) =>
  Effect.gen(function* () {
    const serverScope = yield* Effect.scope;
    const sessions = yield* Effect.serviceOption(SessionCredentialService);
    const actions = new Map<string, Action>();
    const completed: string[] = [];

    const finishObserver = (queue: Observer, outcome: Exit.Exit<void, WsRpcError>) => {
      if (Exit.isFailure(outcome)) Queue.failCauseUnsafe(queue, outcome.cause);
      else Queue.endUnsafe(queue);
    };

    return (input: GitRunStackedActionInput) => {
      // Older clients cannot resume an interrupted request. Preserve their
      // request-owned cancellation instead of silently detaching mutations.
      if (!input.recoverable && !input.resume) {
        return Stream.callback<GitActionProgressEvent, WsRpcError>(
          (queue) =>
            run(input, (event) => Queue.offer(queue, event).pipe(Effect.asVoid)).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Queue.failCause(queue, cause),
                onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
              }),
            ),
          { bufferSize: 128, strategy: "sliding" },
        );
      }
      return Stream.callback<GitActionProgressEvent, WsRpcError>(
        (queue) =>
          Effect.gen(function* () {
            const principal = yield* CurrentManagedAttachmentPrincipal;
            const key = JSON.stringify([principal.ownerKind, principal.ownerId, input.actionId]);
            const { resume, recoverable: _, ...command } = input;
            const fingerprint = createHash("sha256")
              .update(stableJsonStringify(JSON.parse(JSON.stringify(command))))
              .digest("hex");
            let action = actions.get(key);
            const isNew = !action;
            if (!action) {
              if (resume)
                return yield* Effect.fail(
                  new WsRpcError({
                    message:
                      "The Git action result is unavailable. The server may have restarted or the request may not have arrived. Check the repository status before trying again.",
                  }),
                );
              action = { fingerprint, observers: new Set(), structural: [] };
              actions.set(key, action);
            } else if (action.fingerprint !== fingerprint) {
              return yield* Effect.fail(
                new WsRpcError({ message: "Git action ID was reused with different inputs." }),
              );
            }
            const current = action;
            for (const event of current.structural) Queue.offerUnsafe(queue, event);
            if (current.latest && !current.structural.includes(current.latest))
              Queue.offerUnsafe(queue, current.latest);
            if (current.outcome) {
              finishObserver(queue, current.outcome);
              return;
            }
            current.observers.add(queue);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                current.observers.delete(queue);
              }),
            );
            if (isNew) {
              const work = Effect.suspend(() =>
                run(command, (event) =>
                  Effect.sync(() => {
                    switch (event.kind) {
                      case "action_started":
                        current.structural = [event];
                        break;
                      case "phase_started":
                        current.structural = [
                          ...current.structural.filter((item) => item.kind === "action_started"),
                          event,
                        ];
                        break;
                      case "hook_started":
                      case "hook_finished":
                        current.structural = [
                          ...current.structural.filter(
                            (item) =>
                              item.kind === "action_started" || item.kind === "phase_started",
                          ),
                          event,
                        ];
                        break;
                      case "action_finished":
                      case "action_failed":
                        current.structural = [];
                        break;
                    }
                    current.latest = event;
                    for (const observer of current.observers) Queue.offerUnsafe(observer, event);
                  }),
                ),
              );
              const ownedWork =
                principal.ownerKind === "session"
                  ? Option.isSome(sessions)
                    ? sessions.value
                        .runAuthenticatedWork(AuthSessionId.makeUnsafe(principal.ownerId), work)
                        .pipe(
                          Effect.mapError((error) =>
                            error instanceof WsRpcError
                              ? error
                              : new WsRpcError({ message: error.message }),
                          ),
                          Effect.catchCause((cause) =>
                            Cause.hasInterruptsOnly(cause)
                              ? Effect.fail(
                                  new WsRpcError({ message: "Git action authorization ended." }),
                                )
                              : Effect.failCause(cause),
                          ),
                        )
                    : Effect.fail(
                        new WsRpcError({
                          message: "Git action session authorization is unavailable.",
                        }),
                      )
                  : work;
              yield* ownedWork.pipe(
                Effect.asVoid,
                Effect.onExit((outcome) =>
                  Effect.sync(() => {
                    current.outcome = outcome;
                    for (const observer of current.observers) finishObserver(observer, outcome);
                    current.observers.clear();
                    completed.push(key);
                    while (completed.length > COMPLETED_ACTIONS_TO_KEEP)
                      actions.delete(completed.shift()!);
                  }),
                ),
                Effect.forkIn(serverScope, { uninterruptible: false }),
              );
            }
          }).pipe(
            Effect.uninterruptible,
            Effect.catchCause((cause) => Queue.failCause(queue, cause)),
          ),
        { bufferSize: 128, strategy: "sliding" },
      );
    };
  });
