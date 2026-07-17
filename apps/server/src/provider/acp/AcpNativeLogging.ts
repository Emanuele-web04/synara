import type { ProviderKind, ThreadId } from "@synara/contracts";
import { Cause, Effect } from "effect";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type {
  AcpProtocolLogEvent,
  AcpSessionRequestLogEvent,
  AcpSessionRuntimeOptions,
} from "./AcpSessionRuntime.ts";

function writeNativeAcpLog(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly kind: "request" | "protocol";
  readonly payload: unknown;
}): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!input.nativeEventLogger) return;
    const observedAt = new Date().toISOString();
    yield* input.nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: crypto.randomUUID(),
          kind: input.kind,
          provider: input.provider,
          createdAt: observedAt,
          threadId: input.threadId,
          payload: input.payload,
        },
      },
      input.threadId,
    );
  });
}

function formatRequestLogPayload(event: AcpSessionRequestLogEvent) {
  return {
    method: event.method,
    status: event.status,
    request: event.payload,
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.cause !== undefined ? { cause: Cause.pretty(event.cause) } : {}),
  };
}

function stringifyAcpLogPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function summarizeAcpLogPayload(payload: unknown, limit: number): string {
  const text = stringifyAcpLogPayload(payload);
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

export function makeAcpDebugLoggers(input: {
  readonly base: Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">;
  readonly enabled: boolean;
  readonly provider: ProviderKind;
  readonly marker: string;
  readonly payloadLimit: number;
  readonly shouldMirrorIncomingRaw: (payload: string) => boolean;
}): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  const summarize = (payload: unknown) => summarizeAcpLogPayload(payload, input.payloadLimit);
  const requestLogger: AcpSessionRuntimeOptions["requestLogger"] =
    input.base.requestLogger || input.enabled
      ? (event) =>
          Effect.gen(function* () {
            if (input.base.requestLogger) yield* input.base.requestLogger(event);
            if (input.enabled && event.status === "failed") {
              yield* Effect.logWarning(`${input.provider}.acp.request_failed`, {
                marker: input.marker,
                method: event.method,
                payload:
                  event.method === "session/prompt"
                    ? "[redacted session/prompt payload]"
                    : summarize(event.payload),
                cause: event.cause ? Cause.pretty(event.cause) : undefined,
              });
            }
          })
      : undefined;
  const protocolLogging: AcpSessionRuntimeOptions["protocolLogging"] =
    input.base.protocolLogging || input.enabled
      ? {
          logIncoming: input.base.protocolLogging?.logIncoming ?? input.enabled,
          logOutgoing: input.base.protocolLogging?.logOutgoing ?? false,
          logger: (event) =>
            Effect.gen(function* () {
              if (input.base.protocolLogging?.logger) {
                yield* input.base.protocolLogging.logger(event);
              }
              const payload = summarize(event.payload);
              if (
                !input.enabled ||
                event.direction !== "incoming" ||
                event.stage !== "raw" ||
                !input.shouldMirrorIncomingRaw(payload)
              ) {
                return;
              }
              yield* Effect.logWarning(`${input.provider}.acp.protocol`, {
                marker: input.marker,
                direction: event.direction,
                stage: event.stage,
                payload,
              });
            }),
        }
      : undefined;

  return {
    ...(requestLogger ? { requestLogger } : {}),
    ...(protocolLogging ? { protocolLogging } : {}),
  };
}

export function makeAcpNativeLoggers(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
}): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  return {
    requestLogger: (event) =>
      writeNativeAcpLog({
        nativeEventLogger: input.nativeEventLogger,
        provider: input.provider,
        threadId: input.threadId,
        kind: "request",
        payload: formatRequestLogPayload(event),
      }),
    ...(input.nativeEventLogger
      ? {
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event: AcpProtocolLogEvent) =>
              writeNativeAcpLog({
                nativeEventLogger: input.nativeEventLogger,
                provider: input.provider,
                threadId: input.threadId,
                kind: "protocol",
                payload: event,
              }),
          } satisfies NonNullable<AcpSessionRuntimeOptions["protocolLogging"]>,
        }
      : {}),
  };
}
