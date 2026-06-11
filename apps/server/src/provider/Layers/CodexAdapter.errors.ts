// Purpose: Pure error/value helpers for the Codex provider adapter — message sanitization and ProviderAdapterError mapping.
// Layer: pure functions — no Effect, no session-context mutation.
// Exports: PROVIDER const, message/error mappers (toMessage, toRequestError), and primitive value coercers (asObject/asString/asArray/asNumber).

import { type ThreadId } from "@t3tools/contracts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";

export const PROVIDER = "codex" as const;

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return sanitizeUserFacingErrorMessage(cause.message, fallback);
  }
  return fallback;
}

function sanitizeUserFacingErrorMessage(message: string, fallback: string): string {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return fallback;
  }

  const firstLine = normalized.split("\n")[0]?.trim() ?? "";
  const withoutInlineStack = firstLine.replace(/\s+at file:\/\/.*$/s, "").trim();
  return withoutInlineStack.length > 0 ? withoutInlineStack : fallback;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
