// FILE: expensiveReadRetry.ts
// Purpose: Shared retry policy for WebSocket RPC capacity backpressure.
// Layer: Web data-fetching helpers
// The transport queues unary calls against the server's per-class budgets
// (rpcRequestQueue.ts) and reports a retryable capacity error when no slot frees
// in time. The server still rejects saturated calls before the handler runs
// (retryable: true, retryAfterMs: 250), for example right after a cancelled
// request; the transport retries those in place. Callers must honor that
// contract instead of treating capacity as a hard failure.

import {
  WS_REQUEST_CAPACITY_EXCEEDED_CODES,
  WS_REQUEST_CAPACITY_RETRY_AFTER_MS,
} from "@synara/shared/wsRequestClass";

const RPC_CAPACITY_EXCEEDED_CODES = new Set<string>(WS_REQUEST_CAPACITY_EXCEEDED_CODES);

export const RPC_CAPACITY_RETRY_LIMIT = 12;
export const MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS = RPC_CAPACITY_RETRY_LIMIT;
export const DEFAULT_RPC_CAPACITY_RETRY_MS = WS_REQUEST_CAPACITY_RETRY_AFTER_MS;
/**
 * Longest wait for a client-side request slot: the time budget the in-place
 * retry loop had before requests were queued, so capacity errors still surface
 * when they used to.
 */
export const UNARY_RPC_CAPACITY_QUEUE_WAIT_MS =
  MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS * DEFAULT_RPC_CAPACITY_RETRY_MS;
const DEFAULT_GENERIC_RETRY_LIMIT = 3;

export function isRpcCapacityExceededError(error: unknown): error is {
  readonly code: string;
  readonly retryAfterMs?: unknown;
  readonly retryable?: unknown;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    RPC_CAPACITY_EXCEEDED_CODES.has(error.code)
  );
}

function isRetryableRpcCapacityExceededError(error: unknown): boolean {
  return isRpcCapacityExceededError(error) && error.retryable !== false;
}

export function getRpcCapacityRetryAfterMs(error: unknown): number {
  if (!isRpcCapacityExceededError(error)) return DEFAULT_RPC_CAPACITY_RETRY_MS;
  const retryAfterMs = error.retryAfterMs;
  return typeof retryAfterMs === "number" && retryAfterMs > 0
    ? retryAfterMs
    : DEFAULT_RPC_CAPACITY_RETRY_MS;
}

/**
 * Delay for a bounded in-place unary retry. Returns null when the error is not
 * a retryable capacity rejection or the attempt budget is exhausted.
 */
export function getUnaryRpcCapacityRetryDelayMs(
  error: unknown,
  previousAttempts: number,
): number | null {
  if (previousAttempts >= MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS) return null;
  if (!isRetryableRpcCapacityExceededError(error)) return null;
  return getRpcCapacityRetryAfterMs(error);
}

export function shouldRetryExpensiveRead(failureCount: number, error: unknown): boolean {
  // Capacity rejections are already retried in-place by wsTransport.request().
  // A second query-level budget would multiply into 13×13 admission probes.
  if (isRetryableRpcCapacityExceededError(error)) return false;
  return failureCount < DEFAULT_GENERIC_RETRY_LIMIT;
}

export function expensiveReadRetryDelay(attemptIndex: number, error: unknown): number {
  if (isRetryableRpcCapacityExceededError(error)) {
    return getRpcCapacityRetryAfterMs(error);
  }
  return Math.min(1_000 * 2 ** attemptIndex, 30_000);
}

type ExpensiveReadRetryFns = {
  readonly retry: (failureCount: number, error: Error) => boolean;
  readonly retryDelay: (attemptIndex: number, error: Error) => number;
};

export const EXPENSIVE_READ_RETRY_OPTIONS: ExpensiveReadRetryFns = {
  retry: shouldRetryExpensiveRead as ExpensiveReadRetryFns["retry"],
  retryDelay: expensiveReadRetryDelay as ExpensiveReadRetryFns["retryDelay"],
};

export const MAX_EXPENSIVE_READ_ERROR_REFETCH_INTERVAL_MS = 10_000;

/**
 * Error-only refetch so a saturated read recovers without waiting for another
 * file-change, window focus, or reconnect. Successful queries stay event-driven.
 * Back off from retryAfterMs so each tick does not immediately re-arm a full
 * unary capacity-retry loop.
 */
export function expensiveReadErrorRefetchInterval(query: {
  readonly state: { readonly error: unknown; readonly errorUpdateCount?: number };
}): number | false {
  if (!isRetryableRpcCapacityExceededError(query.state.error)) return false;
  const base = getRpcCapacityRetryAfterMs(query.state.error);
  const failures = Math.max(1, query.state.errorUpdateCount ?? 1);
  const exponent = Math.min(failures - 1, 16);
  return Math.min(base * 2 ** exponent, MAX_EXPENSIVE_READ_ERROR_REFETCH_INTERVAL_MS);
}
