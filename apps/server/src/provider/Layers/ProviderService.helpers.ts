/**
 * Purpose: Pure helpers, schemas, and constants for ProviderServiceLive — input
 *   validation, session/event status mapping, runtime-payload shaping, and
 *   persisted-payload readers. No factory-closure state.
 * Layer: module-scope pure functions; no Effect services captured.
 * Exports: PROVIDER_RUNTIME_IDLE_STOP_MS, ProviderRollbackConversationInput,
 *   toValidationError, decodeInputOrValidationError, toRuntimeStatus,
 *   toRuntimePayloadFromSession, readPersistedModelSelection,
 *   readPersistedProviderOptions, readPersistedCwd, runtimePayloadRecord,
 *   runtimeStatusForEvent, runtimeLastErrorForEvent.
 *
 * @module ProviderServiceHelpers
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderStartOptions,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Schema, SchemaIssue } from "effect";

import { ProviderValidationError } from "../Errors.ts";
import { type ProviderRuntimeBinding } from "../Services/ProviderSessionDirectory.ts";

const DEFAULT_PROVIDER_RUNTIME_IDLE_STOP_MS = 10 * 60 * 1000;
const configuredProviderRuntimeIdleStopMs =
  process.env.SYNARA_PROVIDER_RUNTIME_IDLE_STOP_MS ??
  process.env.DPCODE_PROVIDER_RUNTIME_IDLE_STOP_MS;
export const PROVIDER_RUNTIME_IDLE_STOP_MS = Number.isFinite(
  Number(configuredProviderRuntimeIdleStopMs),
)
  ? Math.max(0, Number(configuredProviderRuntimeIdleStopMs))
  : DEFAULT_PROVIDER_RUNTIME_IDLE_STOP_MS;

export const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

export function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

export function toRuntimeStatus(
  session: ProviderSession,
): "starting" | "ready" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "ready":
      return "ready";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "running":
    default:
      return "running";
  }
}

export function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly providerOptions?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.providerOptions !== undefined ? { providerOptions: extra.providerOptions } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

export function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

export function readPersistedProviderOptions(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ProviderStartOptions | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "providerOptions" in runtimePayload ? runtimePayload.providerOptions : undefined;
  return Schema.is(ProviderStartOptions)(raw) ? raw : undefined;
}

export function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function runtimePayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function runtimeStatusForEvent(
  event: ProviderRuntimeEvent,
): "ready" | "running" | "stopped" | "error" {
  switch (event.type) {
    case "session.state.changed":
      switch (event.payload.state) {
        case "ready":
          return "ready";
        case "stopped":
          return "stopped";
        case "error":
          return "error";
        default:
          return "running";
      }
    case "session.exited":
    case "turn.completed":
    case "turn.aborted":
      // A completed turn can still carry a resume cursor, but it must not keep
      // the desktop app treating the provider process as active after restart.
      return "stopped";
    case "runtime.error":
      return "error";
    default:
      return "running";
  }
}

export function runtimeLastErrorForEvent(event: ProviderRuntimeEvent): string | null | undefined {
  switch (event.type) {
    case "runtime.error":
      return event.payload.message;
    case "session.state.changed":
      return event.payload.state === "error" ? (event.payload.reason ?? "Session error") : null;
    case "turn.started":
    case "turn.completed":
    case "turn.aborted":
    case "session.exited":
      return null;
    default:
      return undefined;
  }
}
