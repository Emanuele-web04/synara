// Purpose: Prompt-submission helpers for the OpenCode/Kilo adapter (accepted-prompt recovery watchdog, inline-then-async sync/async prompt submission).
// Layer: dependency-parameterized Effect helpers; built once per session-runtime via makeOpenCodePrompt(deps).
// Exports: OpenCodePromptDeps, OpenCodePromptHelpers, makeOpenCodePrompt.

import { type TurnId } from "@t3tools/contracts";
import { Deferred, Effect, Ref } from "effect";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { type OpenCodeRuntimeError, runOpenCodeSdk } from "../opencodeRuntime.ts";
import type { OpenCodeMessageSnapshot } from "./OpenCodeAdapter.types.ts";
import type { OpenCodeTurnHelpers } from "./OpenCodeAdapter.turn.ts";
import {
  clearActiveTurnState,
  isOpenCodeCompletedAssistantMessage,
  type OpenCodeEmitDeps,
  type OpenCodeSessionContext,
  updateProviderSession,
} from "./OpenCodeAdapter.runtime.ts";

export interface OpenCodePromptDeps extends OpenCodeEmitDeps {
  readonly turn: OpenCodeTurnHelpers;
  readonly toAdapterRequestError: (cause: OpenCodeRuntimeError) => ProviderAdapterRequestError;
  readonly promptAcceptedActivityTimeoutMs: number;
  readonly promptAcceptedRecoveryDelaysMs: ReadonlyArray<number>;
  readonly promptSubmissionInlineWaitMs: number;
}

export interface OpenCodePromptHelpers {
  readonly schedulePromptAcceptedWatchdog: (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly providerActivitySerial: number;
      readonly excludedMessageIds: ReadonlySet<string>;
    },
  ) => Effect.Effect<void>;
  readonly submitOpenCodePrompt: (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly promptInput: Parameters<OpencodeClient["session"]["prompt"]>[0];
    },
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
  readonly submitOpenCodePromptAsync: (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly promptInput: Parameters<OpencodeClient["session"]["promptAsync"]>[0];
    },
  ) => Effect.Effect<void, ProviderAdapterRequestError>;
}

export function makeOpenCodePrompt(deps: OpenCodePromptDeps): OpenCodePromptHelpers {
  const {
    emit,
    buildEventBase,
    turn,
    toAdapterRequestError,
    promptAcceptedActivityTimeoutMs,
    promptAcceptedRecoveryDelaysMs,
    promptSubmissionInlineWaitMs,
  } = deps;

  const schedulePromptAcceptedWatchdog = Effect.fn("schedulePromptAcceptedWatchdog")(function* (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly providerActivitySerial: number;
      readonly excludedMessageIds: ReadonlySet<string>;
    },
  ) {
    yield* Effect.gen(function* () {
      for (const delayMs of promptAcceptedRecoveryDelaysMs) {
        yield* Effect.sleep(delayMs);
        if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== input.turnId) {
          break;
        }
        const recovered = yield* turn.recoverOpenCodeTurnFromMessages(context, {
          turnId: input.turnId,
          excludedMessageIds: input.excludedMessageIds,
        });
        if (recovered) {
          break;
        }
      }
    }).pipe(
      Effect.flatMap(() => Effect.sleep(promptAcceptedActivityTimeoutMs)),
      Effect.flatMap(() =>
        Effect.gen(function* () {
          if (yield* Ref.get(context.stopped)) {
            return;
          }
          if (
            context.activeTurnId !== input.turnId ||
            context.activeTurnProviderActivitySerial !== input.providerActivitySerial
          ) {
            return;
          }

          const message =
            "OpenCode did not produce any activity for this prompt. The session may be stuck; try sending again or restart OpenCode.";
          yield* turn.completeOpenCodeTurn(context, {
            turnId: input.turnId,
            raw: { source: "dpcode.opencode.prompt.watchdog" },
            errorMessage: message,
          });
          updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          yield* emit({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId: input.turnId,
              raw: { source: "dpcode.opencode.prompt.watchdog" },
            }),
            type: "runtime.error",
            payload: {
              message,
              class: "transport_error",
            },
          });
        }),
      ),
      Effect.forkIn(context.sessionScope),
      Effect.asVoid,
    );
  });

  const submitOpenCodePrompt = Effect.fn("submitOpenCodePrompt")(function* (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly promptInput: Parameters<OpencodeClient["session"]["prompt"]>[0];
    },
  ) {
    const settled = yield* Deferred.make<ProviderAdapterRequestError | null, never>();

    // Keep the documented prompt request off the command path; SSE streams live
    // updates, and the final HTTP response lets us recover if events are missed.
    yield* runOpenCodeSdk("session.prompt", () =>
      context.client.session.prompt(input.promptInput),
    ).pipe(
      Effect.mapError(toAdapterRequestError),
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (yield* Ref.get(context.stopped)) {
            return null;
          }
          if (context.activeTurnId !== input.turnId) {
            return null;
          }
          const assistantEntry =
            response.data && response.data.info.role === "assistant"
              ? ({
                  info: response.data.info,
                  parts: response.data.parts,
                } satisfies OpenCodeMessageSnapshot & {
                  readonly info: Record<string, unknown>;
                })
              : null;
          if (assistantEntry && isOpenCodeCompletedAssistantMessage(assistantEntry)) {
            yield* turn.recoverOpenCodeTurnFromAssistantMessage(context, {
              turnId: input.turnId,
              assistantEntry,
              raw: {
                source: "dpcode.opencode.prompt.response",
                message: assistantEntry,
              },
            });
          }
          return null;
        }),
      ),
      Effect.catch((requestError) =>
        Effect.gen(function* () {
          if (yield* Ref.get(context.stopped)) {
            return requestError;
          }
          if (
            context.activeTurnId !== input.turnId ||
            context.activeTurnProviderActivitySerial > 0
          ) {
            return requestError;
          }
          clearActiveTurnState(context);
          updateProviderSession(
            context,
            {
              status: "ready",
              model: context.session.model,
              lastError: requestError.detail,
            },
            { clearActiveTurnId: true },
          );
          yield* emit({
            ...buildEventBase({ threadId: context.session.threadId, turnId: input.turnId }),
            type: "turn.aborted",
            payload: {
              reason: requestError.detail,
            },
          });
          return requestError;
        }),
      ),
      Effect.flatMap((result) => Deferred.succeed(settled, result)),
      Effect.forkIn(context.sessionScope),
    );

    const quickResult = yield* Deferred.await(settled).pipe(
      Effect.timeoutOption(promptSubmissionInlineWaitMs),
    );
    if (quickResult._tag === "Some" && quickResult.value) {
      return yield* quickResult.value;
    }
  });

  const submitOpenCodePromptAsync = Effect.fn("submitOpenCodePromptAsync")(function* (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly promptInput: Parameters<OpencodeClient["session"]["promptAsync"]>[0];
    },
  ) {
    const settled = yield* Deferred.make<ProviderAdapterRequestError | null, never>();
    yield* runOpenCodeSdk("session.promptAsync", () =>
      context.client.session.promptAsync(input.promptInput),
    ).pipe(
      Effect.mapError(toAdapterRequestError),
      Effect.as(null),
      Effect.catch((requestError) =>
        Effect.gen(function* () {
          if (yield* Ref.get(context.stopped)) {
            return requestError;
          }
          if (context.activeTurnId !== input.turnId) {
            return requestError;
          }
          clearActiveTurnState(context);
          updateProviderSession(
            context,
            {
              status: "ready",
              model: context.session.model,
              lastError: requestError.detail,
            },
            { clearActiveTurnId: true },
          );
          yield* emit({
            ...buildEventBase({ threadId: context.session.threadId, turnId: input.turnId }),
            type: "turn.aborted",
            payload: {
              reason: requestError.detail,
            },
          });
          return requestError;
        }),
      ),
      Effect.flatMap((result) => Deferred.succeed(settled, result)),
      Effect.forkIn(context.sessionScope),
    );

    const quickResult = yield* Deferred.await(settled).pipe(
      Effect.timeoutOption(promptSubmissionInlineWaitMs),
    );
    if (quickResult._tag === "Some" && quickResult.value) {
      return yield* quickResult.value;
    }
  });

  return {
    schedulePromptAcceptedWatchdog,
    submitOpenCodePrompt,
    submitOpenCodePromptAsync,
  };
}
