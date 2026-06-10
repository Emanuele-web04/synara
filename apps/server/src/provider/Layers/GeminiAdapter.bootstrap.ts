// Purpose: Gemini ACP session bootstrap and runtime mode/model switching (initialize handshake, session/load|new with resume fallback, set_mode/set_model reconciliation).
// Layer: pure standalone Effect functions over GeminiSessionContext; transport sendRequest is the only collaborator.
// Exports: bootstrapSessionContext, setGeminiMode, setGeminiModel.

import { Effect } from "effect";

import { ProviderAdapterProcessError } from "../Errors.ts";
import { asRecord, trimToUndefined } from "../geminiValue.ts";
import { PROVIDER } from "./GeminiAdapter.config.ts";
import { buildResumeCursor, resolveStartedGeminiSessionId } from "./GeminiAdapter.events.ts";
import { updateGeminiSession } from "./GeminiAdapter.state.ts";
import { sendRequest } from "./GeminiAdapter.transport.ts";
import type { GeminiSessionContext } from "./GeminiAdapter.types.ts";

export const setGeminiMode = Effect.fn("setGeminiMode")(function* (
  context: GeminiSessionContext,
  modeId: string,
) {
  if (context.currentModeId === modeId) {
    return;
  }
  yield* sendRequest(context, "session/set_mode", {
    sessionId: context.sessionId,
    modeId,
  });
  context.currentModeId = modeId;
});

export const setGeminiModel = Effect.fn("setGeminiModel")(function* (
  context: GeminiSessionContext,
  input: {
    readonly model: string;
    readonly acpModelId: string;
  },
) {
  if (context.currentModelId === input.acpModelId) {
    return;
  }
  yield* sendRequest(context, "session/set_model", {
    sessionId: context.sessionId,
    modelId: input.acpModelId,
  });
  context.currentModelId = input.acpModelId;
  updateGeminiSession(context, { model: input.model });
});

export const bootstrapSessionContext = Effect.fn("bootstrapSessionContext")(function* (
  context: GeminiSessionContext,
  input: {
    readonly resumeSessionId?: string;
    readonly allowResumeFallback?: boolean;
    readonly model?: string;
    readonly apiModelId?: string;
    readonly sessionFilePath?: string;
  },
) {
  context.suppressSessionUpdates = true;
  return yield* Effect.gen(function* () {
    yield* sendRequest(context, "initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "synara",
        title: "Synara",
        version: "0.1.0",
      },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
      },
    });

    const startResponse = yield* input.resumeSessionId
      ? input.allowResumeFallback !== false
        ? sendRequest<Record<string, unknown>>(context, "session/load", {
            sessionId: input.resumeSessionId,
            cwd: context.session.cwd ?? process.cwd(),
            mcpServers: [],
          }).pipe(
            Effect.catch(() =>
              sendRequest<Record<string, unknown>>(context, "session/new", {
                cwd: context.session.cwd ?? process.cwd(),
                mcpServers: [],
              }),
            ),
          )
        : sendRequest<Record<string, unknown>>(context, "session/load", {
            sessionId: input.resumeSessionId,
            cwd: context.session.cwd ?? process.cwd(),
            mcpServers: [],
          })
      : sendRequest<Record<string, unknown>>(context, "session/new", {
          cwd: context.session.cwd ?? process.cwd(),
          mcpServers: [],
        });

    context.sessionId = resolveStartedGeminiSessionId(input.resumeSessionId, startResponse) ?? "";
    if (!context.sessionId) {
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: context.session.threadId,
        detail: "Gemini ACP did not return a session id.",
      });
    }

    context.currentModeId = trimToUndefined(asRecord(startResponse.modes)?.currentModeId);
    context.currentModelId = trimToUndefined(asRecord(startResponse.models)?.currentModelId);
    yield* setGeminiMode(context, context.runtimeModeId);

    if (input.model) {
      yield* setGeminiModel(context, {
        model: input.model,
        acpModelId: input.apiModelId ?? input.model,
      });
    }

    context.sessionFilePath = input.sessionFilePath ?? context.sessionFilePath;
    updateGeminiSession(context, {
      status: "ready",
      ...(input.model
        ? { model: input.model }
        : context.currentModelId
          ? { model: context.currentModelId }
          : {}),
      resumeCursor: buildResumeCursor(context),
    });

    return {
      currentModelId: context.currentModelId,
    };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        context.suppressSessionUpdates = false;
      }),
    ),
  );
});
