// Purpose: Turn lifecycle helpers for the OpenCode/Kilo adapter (completion, premature-idle deferral, recovery from assistant messages / message lists, recovery baseline capture).
// Layer: dependency-parameterized Effect helpers; built once per session-runtime via makeOpenCodeTurn(deps).
// Exports: OpenCodeTurnDeps, OpenCodeTurnHelpers, makeOpenCodeTurn.

import { type TurnId } from "@t3tools/contracts";
import { Effect, Ref } from "effect";
import type { AssistantMessage, OpencodeClient } from "@opencode-ai/sdk/v2";

import { runOpenCodeSdk } from "../opencodeRuntime.ts";
import { asFiniteNonNegativeNumber, normalizeOpenCodeTokenUsage } from "./OpenCodeAdapter.token.ts";
import type { OpenCodeMessageSnapshot } from "./OpenCodeAdapter.types.ts";
import type { OpenCodeEmitters } from "./OpenCodeAdapter.emitters.ts";
import {
  clearActiveTurnState,
  isOpenCodeCompletedAssistantMessage,
  type OpenCodeEmitDeps,
  type OpenCodeSessionContext,
  trackActiveTurnAssistantFinish,
  updateProviderSession,
} from "./OpenCodeAdapter.runtime.ts";

export interface OpenCodeTurnDeps extends OpenCodeEmitDeps {
  readonly emitters: OpenCodeEmitters;
}

export interface OpenCodeTurnHelpers {
  readonly completeOpenCodeTurn: (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly raw: unknown;
      readonly totalCostUsd?: number | undefined;
      readonly errorMessage?: string | undefined;
    },
  ) => Effect.Effect<void>;
  readonly deferPrematureIdleCompletion: (
    context: OpenCodeSessionContext,
    turnId: TurnId,
    raw: unknown,
  ) => Effect.Effect<boolean>;
  readonly recoverOpenCodeTurnFromAssistantMessage: (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly assistantEntry: OpenCodeMessageSnapshot & {
        readonly info: Record<string, unknown>;
      };
      readonly raw: unknown;
    },
  ) => Effect.Effect<boolean>;
  readonly recoverOpenCodeTurnFromMessages: (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly excludedMessageIds: ReadonlySet<string>;
    },
  ) => Effect.Effect<boolean>;
  readonly captureOpenCodeRecoveryBaseline: (
    context: OpenCodeSessionContext,
  ) => Effect.Effect<Set<string>>;
}

export function makeOpenCodeTurn(deps: OpenCodeTurnDeps): OpenCodeTurnHelpers {
  const { adapterConfig, emit, buildEventBase, emitters } = deps;

  const completeOpenCodeTurn = Effect.fn("completeOpenCodeTurn")(function* (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly raw: unknown;
      readonly totalCostUsd?: number | undefined;
      readonly errorMessage?: string | undefined;
    },
  ) {
    clearActiveTurnState(context);
    updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
    yield* emit({
      ...buildEventBase({
        threadId: context.session.threadId,
        turnId: input.turnId,
        raw: input.raw,
      }),
      type: "turn.completed",
      payload: input.errorMessage
        ? {
            state: "failed",
            errorMessage: input.errorMessage,
          }
        : {
            state: "completed",
            ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
          },
    });
  });

  const deferPrematureIdleCompletion = Effect.fn("deferPrematureIdleCompletion")(function* (
    context: OpenCodeSessionContext,
    turnId: TurnId,
    raw: unknown,
  ) {
    const idleBeforeAssistantActivity = context.activeTurnCompletionActivitySerial === 0;
    const idleAfterToolCalls =
      context.activeTurnSawToolCallFinish && !context.activeTurnSawFinalAssistant;
    if (!idleBeforeAssistantActivity && !idleAfterToolCalls) {
      return false;
    }
    if (!context.activeTurnToolCallIdleWatchdogStarted) {
      context.activeTurnToolCallIdleWatchdogStarted = true;
      yield* Effect.gen(function* () {
        yield* Effect.sleep(10_000);
        if (
          (yield* Ref.get(context.stopped)) ||
          context.activeTurnId !== turnId ||
          context.activeTurnSawFinalAssistant
        ) {
          return;
        }

        const message = idleAfterToolCalls
          ? `${adapterConfig.displayName} became idle after tool calls without producing a final assistant response.`
          : `${adapterConfig.displayName} became idle before producing an assistant response.`;
        yield* completeOpenCodeTurn(context, {
          turnId,
          raw: {
            source: "dpcode.opencode.idle-after-tool-calls",
            event: raw,
          },
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
            turnId,
            raw: {
              source: "dpcode.opencode.idle-after-tool-calls",
              event: raw,
            },
          }),
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
          },
        });
      }).pipe(Effect.forkIn(context.sessionScope), Effect.asVoid);
    }
    return true;
  });

  const recoverOpenCodeTurnFromAssistantMessage = Effect.fn(
    "recoverOpenCodeTurnFromAssistantMessage",
  )(function* (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly assistantEntry: OpenCodeMessageSnapshot & {
        readonly info: Record<string, unknown>;
      };
      readonly raw: unknown;
    },
  ) {
    context.messageRoleById.set(input.assistantEntry.info.id, "assistant");
    trackActiveTurnAssistantFinish(context, input.turnId, input.assistantEntry);
    for (const part of input.assistantEntry.parts) {
      context.partById.set(part.id, part);
      yield* emitters.emitRecoveredAssistantTextDelta(context, part, input.turnId, input.raw);
    }

    const selectedModel = context.session.model;
    const maxTokens =
      selectedModel !== undefined ? context.modelContextLimitBySlug.get(selectedModel) : undefined;
    const normalizedUsage = normalizeOpenCodeTokenUsage(
      (input.assistantEntry.info as Partial<AssistantMessage>).tokens,
      maxTokens,
    );
    if (normalizedUsage !== undefined) {
      context.lastKnownTokenUsage = normalizedUsage;
      yield* emit({
        ...buildEventBase({
          threadId: context.session.threadId,
          turnId: input.turnId,
          raw: input.raw,
        }),
        type: "thread.token-usage.updated",
        payload: {
          usage: normalizedUsage,
        },
      });
    }
    const cost = asFiniteNonNegativeNumber(
      (input.assistantEntry.info as Partial<AssistantMessage>).cost,
    );
    context.latestTurnCostUsd = cost;
    yield* completeOpenCodeTurn(context, {
      turnId: input.turnId,
      raw: input.raw,
      totalCostUsd: cost,
    });
    return true;
  });

  const recoverOpenCodeTurnFromMessages = Effect.fn("recoverOpenCodeTurnFromMessages")(function* (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId: TurnId;
      readonly excludedMessageIds: ReadonlySet<string>;
    },
  ) {
    const messagesResponse = yield* runOpenCodeSdk("session.messages", () =>
      context.client.session.messages({
        sessionID: context.openCodeSessionId,
      }),
    ).pipe(
      Effect.catchCause(() =>
        Effect.succeed(null as Awaited<ReturnType<OpencodeClient["session"]["messages"]>> | null),
      ),
    );
    if (!messagesResponse) {
      return false;
    }

    const assistantEntry = (messagesResponse.data ?? [])
      .flatMap((entry) =>
        entry.info.role === "assistant" && !input.excludedMessageIds.has(entry.info.id)
          ? [
              {
                info: entry.info,
                parts: entry.parts,
              } satisfies OpenCodeMessageSnapshot & {
                readonly info: Record<string, unknown>;
              },
            ]
          : [],
      )
      .findLast(isOpenCodeCompletedAssistantMessage);
    if (!assistantEntry) {
      return false;
    }

    return yield* recoverOpenCodeTurnFromAssistantMessage(context, {
      turnId: input.turnId,
      assistantEntry,
      raw: {
        source: "dpcode.opencode.prompt.recovery",
        message: assistantEntry,
      },
    });
  });

  const captureOpenCodeRecoveryBaseline = Effect.fn("captureOpenCodeRecoveryBaseline")(function* (
    context: OpenCodeSessionContext,
  ) {
    const messagesResponse = yield* runOpenCodeSdk("session.messages", () =>
      context.client.session.messages({
        sessionID: context.openCodeSessionId,
      }),
    ).pipe(
      Effect.catchCause(() =>
        Effect.succeed(null as Awaited<ReturnType<OpencodeClient["session"]["messages"]>> | null),
      ),
    );
    const baselineIds = new Set<string>();
    for (const id of context.messageRoleById.keys()) {
      baselineIds.add(id);
    }
    for (const entry of messagesResponse?.data ?? []) {
      if (typeof entry.info.id === "string") {
        baselineIds.add(entry.info.id);
      }
    }
    return baselineIds;
  });

  return {
    completeOpenCodeTurn,
    deferPrematureIdleCompletion,
    recoverOpenCodeTurnFromAssistantMessage,
    recoverOpenCodeTurnFromMessages,
    captureOpenCodeRecoveryBaseline,
  };
}
