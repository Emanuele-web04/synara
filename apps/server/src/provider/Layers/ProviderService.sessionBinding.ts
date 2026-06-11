/**
 * Purpose: Session-binding writer cluster for ProviderServiceLive — persists
 *   provider session state into the directory on start/stop/stop-all and from
 *   runtime events.
 * Layer: dependency-parameterized Effect helpers; built once per service via
 *   makeSessionBindingWriters(deps).
 * Exports: SessionBindingDeps, SessionBindingWriters, makeSessionBindingWriters.
 *
 * @module ProviderServiceSessionBinding
 */
import { ThreadId, type ProviderRuntimeEvent, type ProviderSession } from "@t3tools/contracts";
import { Cause, Effect, Option } from "effect";

import {
  type ProviderSessionDirectoryShape,
  type ProviderSessionDirectoryWriteError,
} from "../Services/ProviderSessionDirectory.ts";
import {
  runtimeLastErrorForEvent,
  runtimePayloadRecord,
  runtimeStatusForEvent,
  toRuntimePayloadFromSession,
  toRuntimeStatus,
} from "./ProviderService.helpers.ts";

export interface SessionBindingDeps {
  readonly directory: ProviderSessionDirectoryShape;
}

export interface SessionBindingWriters {
  readonly upsertSessionBinding: (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly providerOptions?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;
  readonly upsertStoppedSessionBinding: (
    session: ProviderSession,
    stoppedAt: string,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;
  readonly markPersistedThreadStopped: (
    threadId: ThreadId,
    stoppedAt: string,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;
  readonly updateSessionBindingFromRuntimeEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void>;
}

export const makeSessionBindingWriters = (deps: SessionBindingDeps): SessionBindingWriters => {
  const { directory } = deps;

  const upsertSessionBinding: SessionBindingWriters["upsertSessionBinding"] = (
    session,
    threadId,
    extra,
  ) =>
    directory.upsert({
      threadId,
      provider: session.provider,
      runtimeMode: session.runtimeMode,
      status: toRuntimeStatus(session),
      ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
      runtimePayload: toRuntimePayloadFromSession(session, extra),
    });

  const upsertStoppedSessionBinding: SessionBindingWriters["upsertStoppedSessionBinding"] = (
    session,
    stoppedAt,
  ) =>
    directory.upsert({
      threadId: session.threadId,
      provider: session.provider,
      runtimeMode: session.runtimeMode,
      status: "stopped",
      ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
      runtimePayload: {
        ...toRuntimePayloadFromSession(session, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt: stoppedAt,
        }),
        activeTurnId: null,
      },
    });

  const markPersistedThreadStopped: SessionBindingWriters["markPersistedThreadStopped"] = (
    threadId,
    stoppedAt,
  ) =>
    directory.getProvider(threadId).pipe(
      Effect.flatMap((provider) =>
        directory.upsert({
          threadId,
          provider,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: stoppedAt,
          },
        }),
      ),
    );

  const updateSessionBindingFromRuntimeEvent: SessionBindingWriters["updateSessionBindingFromRuntimeEvent"] =
    (event) => {
      switch (event.type) {
        case "session.started":
        case "session.state.changed":
        case "thread.started":
        case "turn.started":
        case "turn.completed":
        case "turn.aborted":
        case "session.exited":
        case "runtime.error":
          break;
        default:
          return Effect.void;
      }

      return Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
        if (!binding) {
          return;
        }

        const activeTurnId =
          event.type === "turn.started"
            ? (event.turnId ?? null)
            : event.type === "turn.completed" ||
                event.type === "turn.aborted" ||
                event.type === "session.exited" ||
                event.type === "runtime.error" ||
                (event.type === "session.state.changed" &&
                  (event.payload.state === "ready" ||
                    event.payload.state === "stopped" ||
                    event.payload.state === "error"))
              ? null
              : (runtimePayloadRecord(binding.runtimePayload).activeTurnId ?? null);
        const lastError = runtimeLastErrorForEvent(event);

        yield* directory.upsert({
          threadId: event.threadId,
          provider: binding.provider,
          ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
          ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
          status: runtimeStatusForEvent(event),
          ...(binding.resumeCursor !== undefined ? { resumeCursor: binding.resumeCursor } : {}),
          runtimePayload: {
            activeTurnId,
            lastRuntimeEvent: event.type,
            lastRuntimeEventAt: event.createdAt,
            ...(lastError !== undefined ? { lastError } : {}),
          },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.runtime_binding_update_failed", {
            threadId: event.threadId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    };

  return {
    upsertSessionBinding,
    upsertStoppedSessionBinding,
    markPersistedThreadStopped,
    updateSessionBindingFromRuntimeEvent,
  };
};
