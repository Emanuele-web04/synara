// Purpose: Message-snapshot load/remember/replay, Kilo idle watchdog, and SSE event-pump helpers for the OpenCode/Kilo adapter, split out of OpenCodeAdapter.eventHandler.ts to keep each module under the size budget.
// Layer: dependency-parameterized Effect helpers; built once per session-runtime via makeOpenCodeSnapshotHelpers(deps, handleSubscribedEvent).
// Exports: OpenCodeSnapshotHelpers, makeOpenCodeSnapshotHelpers.

import { type TurnId } from "@t3tools/contracts";
import { Cause, Effect, Exit, Ref, Scope, Stream } from "effect";

import {
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  runOpenCodeSdk,
} from "../opencodeRuntime.ts";
import {
  isFinalAssistantMessageSnapshot,
  nowIso,
  openCodeMessageSnapshotsFromResponse,
  openCodeSnapshotKey,
} from "./OpenCodeAdapter.events.ts";
import type { OpenCodeMessageSnapshot } from "./OpenCodeAdapter.types.ts";
import {
  rememberOpenCodeMessageSnapshot,
  type OpenCodeSessionContext,
  type OpenCodeSubscribedEvent,
} from "./OpenCodeAdapter.runtime.ts";
import type { OpenCodeEventHandlerDeps } from "./OpenCodeAdapter.eventHandler.ts";

type HandleSubscribedEvent = (
  context: OpenCodeSessionContext,
  event: OpenCodeSubscribedEvent,
) => Effect.Effect<void>;

export interface OpenCodeSnapshotHelpers {
  readonly loadCurrentMessageSnapshots: (
    context: OpenCodeSessionContext,
  ) => Effect.Effect<ReadonlyArray<OpenCodeMessageSnapshot>, OpenCodeRuntimeError>;
  readonly rememberCurrentMessageSnapshots: (
    context: OpenCodeSessionContext,
  ) => Effect.Effect<Set<string>, OpenCodeRuntimeError>;
  readonly startKiloTurnSnapshotWatchdog: (
    context: OpenCodeSessionContext,
    turnId: TurnId,
    baselineMessageIds: ReadonlySet<string>,
  ) => Effect.Effect<void>;
  readonly startEventPump: (context: OpenCodeSessionContext) => Effect.Effect<void>;
}

export function makeOpenCodeSnapshotHelpers(
  deps: OpenCodeEventHandlerDeps,
  handleSubscribedEvent: HandleSubscribedEvent,
): OpenCodeSnapshotHelpers {
  const { provider, adapterConfig, emitters, writeNativeEventBestEffort } = deps;
  const { emitUnexpectedExit } = emitters;

  const loadCurrentMessageSnapshots = Effect.fn("loadCurrentMessageSnapshots")(function* (
    context: OpenCodeSessionContext,
  ) {
    const messages = yield* runOpenCodeSdk("session.messages", () =>
      context.client.session.messages({
        sessionID: context.openCodeSessionId,
      }),
    );
    return openCodeMessageSnapshotsFromResponse(messages.data ?? []);
  });

  const rememberCurrentMessageSnapshots = Effect.fn("rememberCurrentMessageSnapshots")(function* (
    context: OpenCodeSessionContext,
  ) {
    const snapshots = yield* loadCurrentMessageSnapshots(context);
    for (const snapshot of snapshots) {
      rememberOpenCodeMessageSnapshot(context, snapshot);
    }
    return new Set(snapshots.map((snapshot) => snapshot.info.id));
  });

  const replayOpenCodeMessageSnapshots = Effect.fn("replayOpenCodeMessageSnapshots")(function* (
    context: OpenCodeSessionContext,
    snapshots: ReadonlyArray<OpenCodeMessageSnapshot>,
    turnId: TurnId,
  ) {
    for (const snapshot of snapshots) {
      const messageKey = openCodeSnapshotKey(snapshot.info);
      if (context.messageSnapshotKeyById.get(snapshot.info.id) !== messageKey) {
        yield* handleSubscribedEvent(context, {
          type: "message.updated",
          properties: {
            sessionID: context.openCodeSessionId,
            info: snapshot.info,
          },
        } as OpenCodeSubscribedEvent);
      }

      for (const part of snapshot.parts) {
        const partKey = openCodeSnapshotKey(part);
        if (context.partSnapshotKeyById.get(part.id) === partKey) {
          continue;
        }
        yield* handleSubscribedEvent(context, {
          type: "message.part.updated",
          properties: {
            sessionID: context.openCodeSessionId,
            part,
          },
        } as OpenCodeSubscribedEvent);
      }
    }

    if (context.activeTurnId !== turnId) {
      return;
    }
  });

  const startKiloTurnSnapshotWatchdog = Effect.fn("startKiloTurnSnapshotWatchdog")(function* (
    context: OpenCodeSessionContext,
    turnId: TurnId,
    baselineMessageIds: ReadonlySet<string>,
  ) {
    yield* Effect.gen(function* () {
      let idlePollsWithFinalMessage = 0;

      while (!(yield* Ref.get(context.stopped)) && context.activeTurnId === turnId) {
        yield* Effect.sleep(500);

        const snapshotsExit = yield* Effect.exit(loadCurrentMessageSnapshots(context));
        let hasFinalAssistantMessage = false;
        if (Exit.isSuccess(snapshotsExit)) {
          yield* replayOpenCodeMessageSnapshots(context, snapshotsExit.value, turnId);
          hasFinalAssistantMessage = snapshotsExit.value.some(
            (snapshot) =>
              !baselineMessageIds.has(snapshot.info.id) &&
              isFinalAssistantMessageSnapshot(snapshot),
          );
        }

        const statusExit = yield* Effect.exit(
          runOpenCodeSdk("session.status", () =>
            context.client.session.status({
              directory: context.directory,
            }),
          ),
        );
        if (!Exit.isSuccess(statusExit)) {
          idlePollsWithFinalMessage = 0;
          continue;
        }

        const status = statusExit.value.data?.[context.openCodeSessionId];
        if (status?.type === "busy" || status?.type === "retry") {
          idlePollsWithFinalMessage = 0;
          continue;
        }

        idlePollsWithFinalMessage = hasFinalAssistantMessage ? idlePollsWithFinalMessage + 1 : 0;
        if (idlePollsWithFinalMessage < 1 || context.activeTurnId !== turnId) {
          continue;
        }

        yield* handleSubscribedEvent(context, {
          type: "session.status",
          properties: {
            sessionID: context.openCodeSessionId,
            status: {
              type: "idle",
            },
          },
        } as OpenCodeSubscribedEvent);
        return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        writeNativeEventBestEffort(context.session.threadId, {
          observedAt: nowIso(),
          event: {
            provider,
            threadId: context.session.threadId,
            providerThreadId: context.openCodeSessionId,
            type: "turn.snapshot-watchdog.error",
            turnId,
            detail: openCodeRuntimeErrorDetail(Cause.squash(cause)),
          },
        }),
      ),
      Effect.forkIn(context.sessionScope),
    );
  });

  const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
    const eventsAbortController = new AbortController();
    yield* Scope.addFinalizer(
      context.sessionScope,
      Effect.sync(() => eventsAbortController.abort()),
    );

    yield* Effect.flatMap(
      runOpenCodeSdk("event.subscribe", () =>
        context.client.event.subscribe(undefined, {
          signal: eventsAbortController.signal,
        }),
      ),
      (subscription) =>
        Stream.fromAsyncIterable(
          subscription.stream,
          (cause) =>
            new OpenCodeRuntimeError({
              operation: "event.subscribe",
              detail: openCodeRuntimeErrorDetail(cause),
              cause,
            }),
        ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
    ).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
            return;
          }
          if (Exit.isFailure(exit)) {
            yield* emitUnexpectedExit(
              context,
              openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
            );
          }
        }),
      ),
      Effect.forkIn(context.sessionScope),
    );

    if (!context.server.external && context.server.exitCode !== null) {
      yield* context.server.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            if (yield* Ref.get(context.stopped)) {
              return;
            }
            yield* emitUnexpectedExit(
              context,
              `${adapterConfig.displayName} server exited unexpectedly (${code}).`,
            );
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );
    }
  });

  return {
    loadCurrentMessageSnapshots,
    rememberCurrentMessageSnapshots,
    startKiloTurnSnapshotWatchdog,
    startEventPump,
  };
}
