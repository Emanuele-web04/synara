// Purpose: ACP debug-logging helpers for the Grok adapter (payload summaries, debug-env gating, runtime loggers).
// Layer: pure functions over env + ACP runtime-logging options — no session context.
// Exports: summarize/debug helpers and makeGrokAcpRuntimeLoggers.

import { Cause, Effect } from "effect";

import type { AcpSessionRuntimeOptions } from "../acp/AcpSessionRuntime.ts";

import {
  DPCODE_GROK_ACP_DEBUG_ENV,
  GROK_ACP_DEBUG_ENV,
  GROK_ACP_LOG_PAYLOAD_LIMIT,
  GROK_ACP_TRANSPORT_DEBUG_MARKER,
  LEGACY_GROK_ACP_DEBUG_ENV,
} from "./GrokAdapter.types.ts";

export function summarizeGrokAcpLogPayload(payload: unknown): unknown {
  const text =
    typeof payload === "string"
      ? payload
      : (() => {
          try {
            return JSON.stringify(payload, null, 2);
          } catch {
            return String(payload);
          }
        })();
  if (text.length <= GROK_ACP_LOG_PAYLOAD_LIMIT) {
    return text;
  }
  return `${text.slice(0, GROK_ACP_LOG_PAYLOAD_LIMIT)}... [truncated ${text.length - GROK_ACP_LOG_PAYLOAD_LIMIT} chars]`;
}

export function summarizeGrokAcpRequestPayload(method: string, payload: unknown): unknown {
  if (method === "session/prompt") {
    return "[redacted session/prompt payload]";
  }
  return summarizeGrokAcpLogPayload(payload);
}

export function isGrokAcpDebugEnabled(): boolean {
  return (
    process.env[GROK_ACP_DEBUG_ENV] === "1" ||
    process.env[DPCODE_GROK_ACP_DEBUG_ENV] === "1" ||
    process.env[LEGACY_GROK_ACP_DEBUG_ENV] === "1"
  );
}

export function shouldMirrorGrokAcpProtocolLog(event: {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed" | "dropped";
  readonly payload: unknown;
}): boolean {
  if (event.stage === "decode_failed") return true;
  if (event.stage === "dropped") return true;
  if (event.direction !== "incoming" || event.stage !== "raw") return false;
  const payload = summarizeGrokAcpLogPayload(event.payload);
  if (typeof payload !== "string") return false;
  return payload.includes("grokShell") || payload.includes("x.ai/fs_notify");
}

export function makeGrokAcpRuntimeLoggers(
  base: Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">,
): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  const debugEnabled = isGrokAcpDebugEnabled();
  const requestLogger: AcpSessionRuntimeOptions["requestLogger"] =
    base.requestLogger || debugEnabled
      ? (event) =>
          Effect.gen(function* () {
            if (base.requestLogger) {
              yield* base.requestLogger(event);
            }
            if (debugEnabled && event.status === "failed") {
              yield* Effect.logWarning("grok.acp.request_failed", {
                marker: GROK_ACP_TRANSPORT_DEBUG_MARKER,
                method: event.method,
                payload: summarizeGrokAcpRequestPayload(event.method, event.payload),
                cause: event.cause ? Cause.pretty(event.cause) : undefined,
              });
            }
          })
      : undefined;
  const protocolLogging: AcpSessionRuntimeOptions["protocolLogging"] =
    base.protocolLogging || debugEnabled
      ? {
          logIncoming: base.protocolLogging?.logIncoming ?? debugEnabled,
          logOutgoing: base.protocolLogging?.logOutgoing ?? false,
          logger: (event) =>
            Effect.gen(function* () {
              if (base.protocolLogging?.logger) {
                yield* base.protocolLogging.logger(event);
              }
              if (!debugEnabled || !shouldMirrorGrokAcpProtocolLog(event)) {
                return;
              }
              yield* Effect.logWarning("grok.acp.protocol", {
                marker: GROK_ACP_TRANSPORT_DEBUG_MARKER,
                direction: event.direction,
                stage: event.stage,
                payload: summarizeGrokAcpLogPayload(event.payload),
              });
            }),
        }
      : undefined;

  return {
    ...(requestLogger ? { requestLogger } : {}),
    ...(protocolLogging ? { protocolLogging } : {}),
  };
}
