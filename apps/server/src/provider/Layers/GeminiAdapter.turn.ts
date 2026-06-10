// Purpose: Turn-finalization cluster for the Gemini adapter (finishTurn plus session-file snapshot resolution/persistence).
// Layer: dependency-parameterized Effect helpers; built once per adapter via makeGeminiTurnFinalizer(deps) with emitters + event base captured.
// Exports: GeminiTurnFinalizer, GeminiTurnFinalizerDeps, makeGeminiTurnFinalizer.

import {
  type EventId,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
  type TurnId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { ProviderAdapterProcessError } from "../Errors.ts";
import { extractProposedPlanMarkdown } from "../planMode.ts";
import { PROVIDER } from "./GeminiAdapter.config.ts";
import {
  buildResumeCursor,
  cloneGeminiSessionFile,
  cloneUnknownArray,
  findGeminiSessionFileById,
  toMessage,
} from "./GeminiAdapter.events.ts";
import { updateGeminiSession, upsertGeminiTurnItem } from "./GeminiAdapter.state.ts";
import { normalizePromptUsage } from "./GeminiAdapter.token.ts";
import type { GeminiSessionContext, GeminiStoredTurn } from "./GeminiAdapter.types.ts";

export interface GeminiTurnFinalizerDeps {
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventBase: (context: GeminiSessionContext) => {
    readonly eventId: EventId;
    readonly provider: typeof PROVIDER;
    readonly threadId: GeminiSessionContext["session"]["threadId"];
    readonly createdAt: string;
  };
  readonly emitUsage: (
    context: GeminiSessionContext,
    usage: ThreadTokenUsageSnapshot,
    turnId?: TurnId,
    rawPayload?: unknown,
  ) => Effect.Effect<void>;
  readonly emitRuntimeWarning: (
    context: GeminiSessionContext,
    message: string,
    raw?: {
      readonly source: "gemini.acp.message" | "gemini.acp.stdout" | "gemini.acp.stderr";
      readonly method?: string;
      readonly payload: unknown;
    },
  ) => Effect.Effect<void>;
  readonly emitSessionState: (
    context: GeminiSessionContext,
    state: "starting" | "ready" | "running" | "stopped" | "error",
    reason?: string,
    detail?: unknown,
  ) => Effect.Effect<void>;
}

export type GeminiTurnFinalizer = ReturnType<typeof makeGeminiTurnFinalizer>;

export function makeGeminiTurnFinalizer(deps: GeminiTurnFinalizerDeps) {
  const { offerRuntimeEvent, makeEventBase, emitUsage, emitRuntimeWarning, emitSessionState } =
    deps;

  const resolveSessionFilePath = Effect.fn("resolveSessionFilePath")(function* (
    context: GeminiSessionContext,
    options?: { readonly retries?: number },
  ) {
    const retries = options?.retries ?? 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const resolvedPath = yield* Effect.tryPromise({
        try: () => findGeminiSessionFileById(context.sessionId, context.sessionFilePath),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: context.session.threadId,
            detail: `Failed to locate Gemini session file: ${toMessage(cause, "lookup failed")}`,
            cause,
          }),
      });
      if (resolvedPath) {
        context.sessionFilePath = resolvedPath;
        return resolvedPath;
      }
      if (attempt < retries) {
        yield* Effect.sleep(100);
      }
    }
    return undefined;
  });

  const persistTurnSnapshot = Effect.fn("persistTurnSnapshot")(function* (
    context: GeminiSessionContext,
    turnId: TurnId,
    items: ReadonlyArray<unknown>,
  ) {
    const storedTurnBase: GeminiStoredTurn = {
      id: turnId,
      items: cloneUnknownArray(items),
    };
    const liveSessionFilePath = yield* resolveSessionFilePath(context, { retries: 5 });
    if (!liveSessionFilePath) {
      return storedTurnBase;
    }

    const snapshotSessionId = crypto.randomUUID();
    const snapshotFilePath = yield* Effect.tryPromise({
      try: () => cloneGeminiSessionFile(liveSessionFilePath, snapshotSessionId),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: `Failed to snapshot Gemini session history: ${toMessage(cause, "snapshot failed")}`,
          cause,
        }),
    });

    return {
      ...storedTurnBase,
      snapshotSessionId,
      snapshotFilePath,
    } satisfies GeminiStoredTurn;
  });

  const finishTurn = Effect.fn("finishTurn")(function* (
    context: GeminiSessionContext,
    result: {
      readonly state: "completed" | "failed" | "cancelled" | "interrupted";
      readonly stopReason?: string | null;
      readonly usage?: unknown;
      readonly errorMessage?: string;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    if (turnState.assistantTextStarted) {
      const proposedPlanMarkdown =
        result.state === "completed" && turnState.interactionMode === "plan"
          ? extractProposedPlanMarkdown(turnState.assistantText)
          : undefined;
      if (proposedPlanMarkdown) {
        yield* offerRuntimeEvent({
          ...makeEventBase(context),
          turnId: turnState.turnId,
          itemId: turnState.assistantItemId,
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
          raw: {
            source: "gemini.acp.message",
            method: "assistant/proposed-plan-block",
            payload: {
              text: turnState.assistantText,
            },
          },
        });
      }

      yield* offerRuntimeEvent({
        ...makeEventBase(context),
        turnId: turnState.turnId,
        itemId: turnState.assistantItemId,
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: result.state === "failed" ? "failed" : "completed",
          title: "Assistant message",
        },
      });
      upsertGeminiTurnItem(turnState, turnState.assistantItemId, "assistant_message", {
        status: result.state === "failed" ? "failed" : "completed",
      });
    }

    if (turnState.reasoningItemId && turnState.reasoningTextStarted) {
      yield* offerRuntimeEvent({
        ...makeEventBase(context),
        turnId: turnState.turnId,
        itemId: turnState.reasoningItemId,
        type: "item.completed",
        payload: {
          itemType: "reasoning",
          status: "completed",
          title: "Reasoning",
        },
      });
      upsertGeminiTurnItem(turnState, turnState.reasoningItemId, "reasoning", {
        status: "completed",
      });
    }

    const normalizedUsage = normalizePromptUsage(result.usage);
    if (normalizedUsage) {
      yield* emitUsage(context, normalizedUsage, turnState.turnId, result.usage);
    }

    yield* offerRuntimeEvent({
      ...makeEventBase(context),
      turnId: turnState.turnId,
      type: "turn.completed",
      payload: {
        state: result.state,
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      },
    });

    const storedTurn = yield* persistTurnSnapshot(context, turnState.turnId, turnState.items).pipe(
      Effect.catch((error) =>
        emitRuntimeWarning(context, error.message, {
          source: "gemini.acp.message",
          method: "session/snapshot",
          payload: {
            message: error.message,
          },
        }).pipe(
          Effect.as({
            id: turnState.turnId,
            items: cloneUnknownArray(turnState.items),
          } satisfies GeminiStoredTurn),
        ),
      ),
    );
    context.turns.push(storedTurn);
    context.turnState = undefined;
    updateGeminiSession(context, {
      status: "ready",
      activeTurnId: undefined,
      resumeCursor: buildResumeCursor(context),
      ...(result.state === "failed" && result.errorMessage
        ? { lastError: result.errorMessage }
        : {}),
    });
    yield* emitSessionState(context, "ready");
  });

  return { finishTurn };
}
