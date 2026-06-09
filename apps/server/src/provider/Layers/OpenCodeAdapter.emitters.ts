// Purpose: Runtime-event emitter helpers for the OpenCode/Kilo adapter (compaction progress, unexpected exit, assistant-text deltas, recovered-text replay).
// Layer: dependency-parameterized Effect helpers; built once per session-runtime via makeOpenCodeEmitters(deps).
// Exports: OpenCodeEmitters, makeOpenCodeEmitters.

import { type TurnId } from "@t3tools/contracts";
import { Effect, Exit, Ref, Scope } from "effect";
import type { Part } from "@opencode-ai/sdk/v2";

import { runOpenCodeSdk } from "../opencodeRuntime.ts";
import { extractProposedPlanMarkdown } from "../planMode.ts";
import {
  isoFromEpochMs,
  mergeOpenCodeAssistantText,
  resolveTextStreamKind,
  textFromPart,
} from "./OpenCodeAdapter.events.ts";
import {
  markOpenCodeTurnCompletionActivity,
  openCodeNextTextItemId,
  type OpenCodeEmitDeps,
  type OpenCodeSessionContext,
  updateProviderSession,
} from "./OpenCodeAdapter.runtime.ts";

export interface OpenCodeEmitters {
  readonly emitContextCompactionProgress: (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId?: TurnId | undefined;
      readonly detail?: string | undefined;
      readonly raw?: unknown;
      readonly data?: unknown;
    },
  ) => Effect.Effect<void>;
  readonly emitContextCompacted: (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId?: TurnId | undefined;
      readonly raw?: unknown;
    },
  ) => Effect.Effect<void>;
  readonly emitUnexpectedExit: (
    context: OpenCodeSessionContext,
    message: string,
  ) => Effect.Effect<void>;
  readonly emitAssistantTextDelta: (
    context: OpenCodeSessionContext,
    part: Part,
    turnId: TurnId | undefined,
    raw: unknown,
  ) => Effect.Effect<void>;
  readonly emitRecoveredAssistantTextDelta: (
    context: OpenCodeSessionContext,
    part: Part,
    turnId: TurnId,
    raw: unknown,
  ) => Effect.Effect<void>;
}

export function makeOpenCodeEmitters(deps: OpenCodeEmitDeps): OpenCodeEmitters {
  const { provider, emit, buildEventBase, sessions } = deps;

  const emitContextCompactionProgress = Effect.fn("emitContextCompactionProgress")(function* (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId?: TurnId | undefined;
      readonly detail?: string | undefined;
      readonly raw?: unknown;
      readonly data?: unknown;
    },
  ) {
    yield* emit({
      ...buildEventBase({
        threadId: context.session.threadId,
        turnId: input.turnId,
        raw: input.raw,
      }),
      type: "item.updated",
      payload: {
        itemType: "context_compaction",
        status: "inProgress",
        detail: input.detail ?? "Compacting context",
        ...(input.data !== undefined ? { data: input.data } : {}),
      },
    });
  });

  const emitContextCompacted = Effect.fn("emitContextCompacted")(function* (
    context: OpenCodeSessionContext,
    input: {
      readonly turnId?: TurnId | undefined;
      readonly raw?: unknown;
    },
  ) {
    updateProviderSession(
      context,
      {
        status: context.activeTurnId ? "running" : "ready",
      },
      { clearLastError: true },
    );
    yield* emit({
      ...buildEventBase({
        threadId: context.session.threadId,
        turnId: input.turnId,
        raw: input.raw,
      }),
      type: "thread.state.changed",
      payload: {
        state: "compacted",
        detail: { source: provider },
      },
    });
  });

  const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
    context: OpenCodeSessionContext,
    message: string,
  ) {
    if (yield* Ref.getAndSet(context.stopped, true)) {
      return;
    }
    const turnId = context.activeTurnId;
    sessions.delete(context.session.threadId);
    yield* emit({
      ...buildEventBase({ threadId: context.session.threadId, turnId }),
      type: "runtime.error",
      payload: {
        message,
        class: "transport_error",
      },
    }).pipe(Effect.ignore);
    yield* emit({
      ...buildEventBase({ threadId: context.session.threadId, turnId }),
      type: "session.exited",
      payload: {
        reason: message,
        recoverable: false,
        exitKind: "error",
      },
    }).pipe(Effect.ignore);
    yield* runOpenCodeSdk("session.abort", () =>
      context.client.session.abort({
        sessionID: context.openCodeSessionId,
      }),
    ).pipe(Effect.ignore({ log: true }));
    yield* Scope.close(context.sessionScope, Exit.void);
  });

  const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
    context: OpenCodeSessionContext,
    part: Part,
    turnId: TurnId | undefined,
    raw: unknown,
  ) {
    const text = textFromPart(part);
    if (text === undefined) {
      return;
    }
    const nextTextItemId =
      turnId && part.type === "text" ? openCodeNextTextItemId(turnId) : undefined;
    const itemId =
      nextTextItemId && context.emittedTextByPartId.has(nextTextItemId) ? nextTextItemId : part.id;
    const previousText = context.emittedTextByPartId.get(itemId);
    const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
    context.emittedTextByPartId.set(itemId, latestText);
    if (itemId !== part.id) {
      context.emittedTextByPartId.set(part.id, latestText);
    }
    if (latestText !== text) {
      context.partById.set(
        part.id,
        (part.type === "text" || part.type === "reasoning"
          ? { ...part, text: latestText }
          : part) satisfies Part,
      );
    }
    if (deltaToEmit.length > 0) {
      markOpenCodeTurnCompletionActivity(context, turnId);
      yield* emit({
        ...buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId,
          createdAt:
            part.type === "text" || part.type === "reasoning"
              ? isoFromEpochMs(part.time?.start)
              : undefined,
          raw,
        }),
        type: "content.delta",
        payload: {
          streamKind: resolveTextStreamKind(part),
          delta: deltaToEmit,
        },
      });
    }

    if (
      part.type === "text" &&
      part.time?.end !== undefined &&
      !context.completedAssistantPartIds.has(itemId)
    ) {
      context.completedAssistantPartIds.add(itemId);
      if (itemId !== part.id) {
        context.completedAssistantPartIds.add(part.id);
      }
      const proposedPlanMarkdown =
        context.activeInteractionMode === "plan"
          ? extractProposedPlanMarkdown(latestText)
          : undefined;
      if (proposedPlanMarkdown && turnId) {
        yield* emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          }),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        });
      }
      yield* emit({
        ...buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId,
          createdAt: isoFromEpochMs(part.time.end),
          raw,
        }),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(latestText.length > 0 ? { detail: latestText } : {}),
        },
      });
    }
  });

  const emitRecoveredAssistantTextDelta = Effect.fn("emitRecoveredAssistantTextDelta")(function* (
    context: OpenCodeSessionContext,
    part: Part,
    turnId: TurnId,
    raw: unknown,
  ) {
    const text = textFromPart(part);
    const nextTextItemId = openCodeNextTextItemId(turnId);
    if (
      text === undefined ||
      part.type !== "text" ||
      !context.emittedTextByPartId.has(nextTextItemId)
    ) {
      yield* emitAssistantTextDelta(context, part, turnId, raw);
      return;
    }

    const previousText = context.emittedTextByPartId.get(nextTextItemId);
    const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
    context.emittedTextByPartId.set(nextTextItemId, latestText);
    context.emittedTextByPartId.set(part.id, latestText);
    context.partById.set(part.id, { ...part, text: latestText });
    if (deltaToEmit.length > 0) {
      markOpenCodeTurnCompletionActivity(context, turnId);
      yield* emit({
        ...buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: nextTextItemId,
          createdAt: isoFromEpochMs(part.time?.start),
          raw,
        }),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: deltaToEmit,
        },
      });
    }

    if (part.time?.end !== undefined) {
      if (context.completedAssistantPartIds.has(nextTextItemId)) {
        context.completedAssistantPartIds.add(part.id);
        return;
      }
      context.completedAssistantPartIds.add(nextTextItemId);
      context.completedAssistantPartIds.add(part.id);
      const proposedPlanMarkdown =
        context.activeInteractionMode === "plan"
          ? extractProposedPlanMarkdown(latestText)
          : undefined;
      if (proposedPlanMarkdown) {
        yield* emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: nextTextItemId,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          }),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        });
      }
      yield* emit({
        ...buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: nextTextItemId,
          createdAt: isoFromEpochMs(part.time.end),
          raw,
        }),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(latestText.length > 0 ? { detail: latestText } : {}),
        },
      });
    }
  });

  return {
    emitContextCompactionProgress,
    emitContextCompacted,
    emitUnexpectedExit,
    emitAssistantTextDelta,
    emitRecoveredAssistantTextDelta,
  };
}
