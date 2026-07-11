// FILE: providerOptionsSecurity.ts
// Purpose: Prevent provider launch credentials from entering durable orchestration events.
// Layer: Server orchestration security boundary.
// Exports: persistence patches and event-level defensive sanitization.

import type { ProviderStartOptions } from "@synara/contracts";

const PROVIDER_OPTION_KEYS = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
] as const;

const PROVIDER_OPTIONS_EVENT_TYPES = new Set([
  "thread.turn-queued",
  "thread.turn-start-requested",
  "thread.message-edit-resend-requested",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeProviderOptionsUnknown(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  let sanitized: Record<string, unknown> | undefined;
  const mutable = () => (sanitized ??= { ...value });
  for (const provider of PROVIDER_OPTION_KEYS) {
    const rawOptions = value[provider];
    if (!isRecord(rawOptions)) {
      continue;
    }

    let sanitizedOptions: Record<string, unknown> | undefined;
    const mutableOptions = () => (sanitizedOptions ??= { ...rawOptions });
    if (Object.prototype.hasOwnProperty.call(rawOptions, "environment")) {
      delete mutableOptions().environment;
    }
    if (
      (provider === "kilo" || provider === "opencode") &&
      Object.prototype.hasOwnProperty.call(rawOptions, "serverPassword")
    ) {
      delete mutableOptions().serverPassword;
    }
    if (sanitizedOptions !== undefined) {
      mutable()[provider] = sanitizedOptions;
    }
  }

  return sanitized ?? value;
}

/**
 * Provider environments and server passwords are runtime-only credentials.
 * Keep non-secret routing fields so legacy queued turns still decode and replay.
 */
export function sanitizeProviderStartOptionsForPersistence(
  providerOptions: ProviderStartOptions | undefined,
): ProviderStartOptions | undefined {
  return sanitizeProviderOptionsUnknown(providerOptions) as ProviderStartOptions | undefined;
}

/**
 * Defense-in-depth for events loaded from pre-migration databases or returned
 * by replay APIs. The generic shape also accepts append inputs without sequence.
 */
export function sanitizeOrchestrationEventProviderOptions<
  Event extends { readonly type: string; readonly payload: unknown },
>(event: Event): Event {
  if (!PROVIDER_OPTIONS_EVENT_TYPES.has(event.type) || !isRecord(event.payload)) {
    return event;
  }
  if (!Object.prototype.hasOwnProperty.call(event.payload, "providerOptions")) {
    return event;
  }

  const sanitized = sanitizeProviderOptionsUnknown(event.payload.providerOptions);
  if (sanitized === event.payload.providerOptions) {
    return event;
  }
  const payload = { ...event.payload, providerOptions: sanitized };
  return { ...event, payload } as Event;
}

/**
 * Reattaches launch options only to the just-committed in-memory event. All
 * other fields come from the decoded durable row so schema defaults survive.
 */
export function restoreTransientOrchestrationEventProviderOptions<
  Event extends { readonly type: string; readonly payload: unknown },
  OriginalEvent extends { readonly type: string; readonly payload: unknown },
>(savedEvent: Event, originalEvent: OriginalEvent): Event {
  if (
    !PROVIDER_OPTIONS_EVENT_TYPES.has(savedEvent.type) ||
    !isRecord(savedEvent.payload) ||
    !isRecord(originalEvent.payload) ||
    !Object.prototype.hasOwnProperty.call(originalEvent.payload, "providerOptions")
  ) {
    return savedEvent;
  }
  return {
    ...savedEvent,
    payload: {
      ...savedEvent.payload,
      providerOptions: originalEvent.payload.providerOptions,
    },
  } as Event;
}
