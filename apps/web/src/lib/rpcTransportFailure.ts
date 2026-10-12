// FILE: rpcTransportFailure.ts
// Purpose: Classifies Effect RPC protocol failures that cross the transport boundary,
//          tracks pre-flight send rejections, and renders the user-facing message.
// Layer: Web transport helpers
// Exports: classifyRpcTransportFailure, markRequestNotSent, formatTransportFailureMessage,
//          describeTransportFailureForDiagnostics, nextTransportFailureRef

import { Schema } from "effect";
import { RpcClientError } from "effect/unstable/rpc";

export type RpcTransportFailureDelivery = "not_sent" | "unknown";

export type RpcTransportFailureReason =
  | { readonly tag: "SocketOpenError"; readonly kind: "Timeout" | "Unknown" }
  | { readonly tag: "SocketCloseError"; readonly code: number }
  | { readonly tag: "SocketReadError" }
  | { readonly tag: "SocketWriteError" }
  | { readonly tag: "RpcClientDefect"; readonly message: string };

export interface RpcTransportFailure {
  readonly reason: RpcTransportFailureReason;
  readonly delivery: RpcTransportFailureDelivery;
  readonly pingTimeout: boolean;
  readonly ref: string;
}

const PING_TIMEOUT_CAUSE_MESSAGE = "ping timeout";

// Session-local tags. The pre-flight wrapper tags the *copy* it fails with so the
// shared `currentError` instance stays untouched: a request that reached the wire
// must never inherit the not-sent proof of a request that was rejected locally.
const notSentFailures = new WeakSet<object>();

let failureRefCounter = 0;

export function nextTransportFailureRef(): string {
  failureRefCounter = (failureRefCounter + 1) % 0x10000;
  return `sock-${failureRefCounter.toString(16).padStart(4, "0")}`;
}

export function markRequestNotSent<T extends object>(error: T): T {
  notSentFailures.add(error);
  return error;
}

export function isRequestNotSent(error: unknown): boolean {
  return typeof error === "object" && error !== null && notSentFailures.has(error);
}

function readCauseMessage(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("message" in cause)) return null;
  const message = (cause as { readonly message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

function classifyReason(reason: unknown): RpcTransportFailureReason | null {
  if (typeof reason !== "object" || reason === null) return null;
  const tag = (reason as { readonly _tag?: unknown })._tag;
  switch (tag) {
    case "SocketOpenError": {
      const kind = (reason as { readonly kind?: unknown }).kind;
      return { tag, kind: kind === "Timeout" ? "Timeout" : "Unknown" };
    }
    case "SocketCloseError": {
      const code = (reason as { readonly code?: unknown }).code;
      return { tag, code: typeof code === "number" ? code : 0 };
    }
    case "SocketReadError":
      return { tag };
    case "SocketWriteError":
      return { tag };
    case "RpcClientDefect": {
      const message = (reason as { readonly message?: unknown }).message;
      return { tag, message: typeof message === "string" ? message : "" };
    }
    default:
      return null;
  }
}

/**
 * Returns null for anything that is not a typed `RpcClientError` crossing the
 * transport boundary, so application errors keep their own handling.
 */
export function classifyRpcTransportFailure(
  error: unknown,
  ref?: string,
): RpcTransportFailure | null {
  if (typeof error !== "object" || error === null) return null;
  if (!Schema.is(RpcClientError.RpcClientError)(error)) return null;
  const reason = classifyReason((error as { readonly reason?: unknown }).reason);
  if (reason === null) return null;
  const pingTimeout =
    reason.tag === "SocketOpenError" &&
    readCauseMessage(
      (error as { readonly reason?: { readonly cause?: unknown } }).reason?.cause,
    ) === PING_TIMEOUT_CAUSE_MESSAGE;
  return {
    reason,
    delivery: isRequestNotSent(error) ? "not_sent" : "unknown",
    pingTimeout,
    ref: ref ?? nextTransportFailureRef(),
  };
}

export function formatTransportFailureMessage(ref: string): string {
  return `Connection interrupted. Check the operation's status. (ref: ${ref})`;
}

/**
 * Allowed diagnostic fields only: no URL, host, port, UUID, payload, stack, raw
 * event or raw cause ever leaves this shape.
 */
export function describeTransportFailureForDiagnostics(
  failure: RpcTransportFailure,
): Record<string, unknown> {
  return {
    ref: failure.ref,
    reason: failure.reason.tag,
    ...(failure.reason.tag === "SocketOpenError" ? { kind: failure.reason.kind } : {}),
    ...(failure.reason.tag === "SocketCloseError" ? { closeCode: failure.reason.code } : {}),
    pingTimeout: failure.pingTimeout,
    delivery: failure.delivery,
  };
}
