// Purpose: JSON-RPC transport for the Gemini ACP stdio channel (notification writes, request/response correlation with timeouts, fire-and-forget notifications).
// Layer: pure standalone Effect functions over GeminiSessionContext; no captured factory state.
// Exports: writeJsonMessage, sendRequest, sendNotification.

import { Effect } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { asRecord, asString } from "../geminiValue.ts";
import { PROVIDER } from "./GeminiAdapter.config.ts";
import { toMessage } from "./GeminiAdapter.events.ts";
import { geminiRequestTimeoutMs } from "./GeminiAdapter.models.ts";
import type { GeminiSessionContext } from "./GeminiAdapter.types.ts";

export const writeJsonMessage = Effect.fn("writeJsonMessage")(function* (
  context: GeminiSessionContext,
  message: unknown,
) {
  const payload = `${JSON.stringify({ jsonrpc: "2.0", ...asRecord(message) })}\n`;
  yield* Effect.try({
    try: () => {
      if (!context.child.stdin.writable) {
        throw new Error("Gemini ACP stdin is not writable.");
      }
      context.child.stdin.write(payload);
    },
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: context.session.threadId,
        detail: toMessage(cause, "Failed to write Gemini ACP message."),
        cause,
      }),
  });
});

export const sendRequest = <T = unknown>(
  context: GeminiSessionContext,
  method: string,
  params: Record<string, unknown>,
): Effect.Effect<T, ProviderAdapterError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<T>((resolve, reject) => {
        const id = context.nextRequestId++;
        const timeoutMs = geminiRequestTimeoutMs(method);
        const timeout = setTimeout(() => {
          context.pending.delete(String(id));
          reject(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: `Gemini ACP request timed out after ${timeoutMs}ms.`,
            }),
          );
        }, timeoutMs);

        context.pending.set(String(id), {
          method,
          timeout,
          resolve: (value) => resolve(value as T),
          reject: (error) => reject(error),
        });

        if (!context.child.stdin.writable) {
          clearTimeout(timeout);
          context.pending.delete(String(id));
          reject(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: "Gemini ACP stdin is not writable.",
            }),
          );
          return;
        }

        context.child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          })}\n`,
        );
      }),
    catch: (cause) =>
      asString(asRecord(cause)?._tag) === "ProviderAdapterRequestError"
        ? (cause as ProviderAdapterRequestError)
        : new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: toMessage(cause, `${method} failed`),
            cause,
          }),
  });

export const sendNotification = (
  context: GeminiSessionContext,
  method: string,
  params: Record<string, unknown>,
) =>
  writeJsonMessage(context, { method, params }).pipe(
    Effect.mapError((cause) =>
      asString(asRecord(cause)?._tag) === "ProviderAdapterProcessError"
        ? (cause as ProviderAdapterProcessError)
        : new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: toMessage(cause, `${method} failed`),
            cause,
          }),
    ),
  );
