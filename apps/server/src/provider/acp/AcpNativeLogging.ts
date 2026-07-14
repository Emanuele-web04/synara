import type { ProviderKind, ThreadId } from "@synara/contracts";
import { Cause, Effect } from "effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { AcpSessionRequestLogEvent, AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";

const SENSITIVE_LOG_FIELD = /(?:token|secret|password|authorization|api[-_]?key)/i;

export function redactAcpLogPayload(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => redactAcpLogPayload(entry, seen));

    const record = value as Record<string, unknown>;
    const sensitiveEnvEntry =
      typeof record.name === "string" && SENSITIVE_LOG_FIELD.test(record.name);
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        SENSITIVE_LOG_FIELD.test(key) || (sensitiveEnvEntry && key === "value")
          ? "[REDACTED]"
          : redactAcpLogPayload(entry, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

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
          payload: redactAcpLogPayload(input.payload),
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
            logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
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
