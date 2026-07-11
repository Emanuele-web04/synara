/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import { createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  defaultInstanceIdForDriver,
  ProviderCompactThreadInput,
  ProviderForkThreadInput,
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderStartReviewInput,
  ProviderSteerTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderStartOptions,
  type ProviderInstanceId,
  ProviderKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@synara/contracts";
import {
  mergeProviderStartOptions,
  providerStartOptionsFromInstance,
  type ResolvedProviderInstance,
  resolveModelSelectionInstanceId,
  resolveProviderInstance,
} from "@synara/shared/providerInstances";
import { Cause, Effect, Exit, Layer, Option, PubSub, Schema, SchemaIssue, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ProviderUnsupportedError, ProviderValidationError } from "../Errors.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryWriteError,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  prepareProviderContinuationIdentity,
  providerContinuationIdentity,
} from "../continuationIdentity.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
  readonly runtimeIdleStopMs?: number;
}

const DEFAULT_PROVIDER_RUNTIME_IDLE_STOP_MS = 10 * 60 * 1000;
const configuredProviderRuntimeIdleStopMs =
  process.env.SYNARA_PROVIDER_RUNTIME_IDLE_STOP_MS ??
  process.env.SYNARA_PROVIDER_RUNTIME_IDLE_STOP_MS;
const PROVIDER_RUNTIME_IDLE_STOP_MS = Number.isFinite(Number(configuredProviderRuntimeIdleStopMs))
  ? Math.max(0, Number(configuredProviderRuntimeIdleStopMs))
  : DEFAULT_PROVIDER_RUNTIME_IDLE_STOP_MS;
const PROVIDER_OPTIONS_FINGERPRINT_HMAC_SECRET = "provider-options-fingerprint-hmac-key";

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

type StopRuntimeSession = NonNullable<ProviderServiceShape["stopRuntimeSession"]>;
type StopRuntimeSessionInput = Parameters<StopRuntimeSession>[0];
type StopRuntimeSessionEffect = ReturnType<StopRuntimeSession>;

function toValidationError(
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

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
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

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  credentialsFingerprintKey: Uint8Array,
  extra?: {
    readonly modelSelection?: unknown;
    readonly providerOptions?: unknown;
    readonly providerInstanceId?: string;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
    /**
     * Launch paths own the persisted launch options: when they carry no
     * providerOptions, the previous binding's options must be cleared instead
     * of surviving the runtime-payload merge, or recovery keeps starting the
     * thread with a home/credentials override the user already removed.
     */
    readonly launchOptionsAuthoritative?: boolean;
  },
): Record<string, unknown> {
  const persistedProviderOptions =
    extra?.providerOptions !== undefined
      ? redactProviderOptionsForPersistence(extra.providerOptions)
      : undefined;
  const credentialsFingerprint =
    Schema.is(ProviderKind)(session.provider) &&
    Schema.is(ProviderStartOptions)(extra?.providerOptions)
      ? credentialsFingerprintForProvider(
          session.provider,
          extra.providerOptions,
          credentialsFingerprintKey,
        )
      : undefined;
  const providerInstanceId = session.providerInstanceId ?? extra?.providerInstanceId;
  const continuationIdentity =
    Schema.is(ProviderKind)(session.provider) &&
    (extra?.launchOptionsAuthoritative === true || extra?.providerOptions !== undefined)
      ? providerContinuationIdentity(
          session.provider,
          Schema.is(ProviderStartOptions)(extra?.providerOptions)
            ? extra.providerOptions
            : undefined,
        )
      : undefined;
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    ...(providerInstanceId ? { providerInstanceId } : {}),
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(persistedProviderOptions !== undefined
      ? { providerOptions: persistedProviderOptions }
      : extra?.launchOptionsAuthoritative
        ? { providerOptions: null }
        : {}),
    ...(credentialsFingerprint !== undefined
      ? { providerOptionsCredentialsFingerprint: credentialsFingerprint }
      : extra?.launchOptionsAuthoritative
        ? { providerOptionsCredentialsFingerprint: null }
        : {}),
    ...(continuationIdentity !== undefined
      ? { continuationIdentity }
      : extra?.launchOptionsAuthoritative
        ? { continuationIdentity: null }
        : {}),
    ...(extra?.launchOptionsAuthoritative ? { continuationResetRequested: null } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function redactProviderOptionsForPersistence(value: unknown): unknown {
  if (!Schema.is(ProviderStartOptions)(value)) {
    return value;
  }
  return {
    ...value,
    ...(value.codex ? { codex: withoutRuntimeEnvironment(value.codex) } : {}),
    ...(value.claudeAgent ? { claudeAgent: withoutRuntimeEnvironment(value.claudeAgent) } : {}),
    ...(value.cursor ? { cursor: withoutRuntimeEnvironment(value.cursor) } : {}),
    ...(value.gemini ? { gemini: withoutRuntimeEnvironment(value.gemini) } : {}),
    ...(value.grok ? { grok: withoutRuntimeEnvironment(value.grok) } : {}),
    ...(value.opencode
      ? { opencode: withoutServerPassword(withoutRuntimeEnvironment(value.opencode)) }
      : {}),
    ...(value.kilo ? { kilo: withoutServerPassword(withoutRuntimeEnvironment(value.kilo)) } : {}),
    ...(value.pi ? { pi: withoutRuntimeEnvironment(value.pi) } : {}),
  } satisfies ProviderStartOptions;
}

function withoutRuntimeEnvironment<T extends { readonly environment?: unknown }>(
  value: T,
): Omit<T, "environment"> {
  const { environment: _environment, ...rest } = value;
  return rest;
}

function withoutServerPassword<T extends { readonly serverPassword?: string | undefined }>(
  value: T,
): Omit<T, "serverPassword"> {
  const { serverPassword: _serverPassword, ...rest } = value;
  return rest;
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

function readPersistedProviderOptions(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ProviderStartOptions | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "providerOptions" in runtimePayload ? runtimePayload.providerOptions : undefined;
  return Schema.is(ProviderStartOptions)(raw) ? raw : undefined;
}

function redactedProviderOptionsForComparison(
  value: ProviderStartOptions | undefined,
): ProviderStartOptions | undefined {
  if (!value) {
    return undefined;
  }
  const redacted = redactProviderOptionsForPersistence(value);
  return Schema.is(ProviderStartOptions)(redacted) ? redacted : undefined;
}

// Fingerprints the credential inputs that persistence strips (environment,
// server passwords) so resume decisions can notice account/credential changes
// without ever persisting the secrets themselves.
function credentialsFingerprintForProvider(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
  key: Uint8Array,
): string | undefined {
  const providerOptions = options?.[provider];
  if (!providerOptions || typeof providerOptions !== "object") {
    return undefined;
  }
  const environment = "environment" in providerOptions ? providerOptions.environment : undefined;
  const serverPassword =
    "serverPassword" in providerOptions ? providerOptions.serverPassword : undefined;
  const environmentEntries =
    environment && typeof environment === "object" && !Array.isArray(environment)
      ? Object.entries(environment as Record<string, unknown>).toSorted(([left], [right]) =>
          left.localeCompare(right),
        )
      : [];
  const password = typeof serverPassword === "string" && serverPassword ? serverPassword : null;
  if (environmentEntries.length === 0 && password === null) {
    return undefined;
  }
  return createHmac("sha256", key)
    .update(JSON.stringify({ environment: environmentEntries, serverPassword: password }))
    .digest("hex");
}

function readPersistedCredentialsFingerprint(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "providerOptionsCredentialsFingerprint" in runtimePayload
      ? runtimePayload.providerOptionsCredentialsFingerprint
      : undefined;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function readPersistedContinuationIdentity(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "continuationIdentity" in runtimePayload ? runtimePayload.continuationIdentity : null;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function readPersistedContinuationResetRequested(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): boolean {
  return Boolean(
    runtimePayload &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    "continuationResetRequested" in runtimePayload &&
    runtimePayload.continuationResetRequested === true,
  );
}

function providerStartOptionsEqualForProvider(
  provider: ProviderKind,
  credentialsFingerprintKey: Uint8Array,
  persisted: {
    readonly options: ProviderStartOptions | undefined;
    readonly credentialsFingerprint: string | undefined;
  },
  current: ProviderStartOptions | undefined,
): boolean {
  return (
    isDeepStrictEqual(
      redactedProviderOptionsForComparison(persisted.options)?.[provider],
      redactedProviderOptionsForComparison(current)?.[provider],
    ) &&
    persisted.credentialsFingerprint ===
      credentialsFingerprintForProvider(provider, current, credentialsFingerprintKey)
  );
}

function providerUsesProtectedNativeContinuation(provider: string): boolean {
  return provider === "codex" || provider === "claudeAgent";
}

function persistedLaunchMatchesExactly(input: {
  readonly binding: ProviderRuntimeBinding;
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerOptions: ProviderStartOptions | undefined;
  readonly credentialsFingerprintKey: Uint8Array;
}): boolean {
  return (
    input.binding.provider === input.provider &&
    providerInstanceIdFromBinding(input.binding) === input.providerInstanceId &&
    providerStartOptionsEqualForProvider(
      input.provider,
      input.credentialsFingerprintKey,
      {
        options: readPersistedProviderOptions(input.binding.runtimePayload),
        credentialsFingerprint: readPersistedCredentialsFingerprint(input.binding.runtimePayload),
      },
      input.providerOptions,
    )
  );
}

function persistedContinuationMatchesLaunch(input: {
  readonly binding: ProviderRuntimeBinding;
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerOptions: ProviderStartOptions | undefined;
  readonly credentialsFingerprintKey: Uint8Array;
  readonly currentIdentity: string | undefined;
}): boolean {
  if (input.binding.provider !== input.provider) {
    return false;
  }
  const persistedIdentity = readPersistedContinuationIdentity(input.binding.runtimePayload);
  if (persistedIdentity !== undefined) {
    if (persistedIdentity === input.currentIdentity) {
      return true;
    }
    // Identity formats can be upgraded after the selected overlay has been
    // verified as shared. Never use exact launch equivalence to downgrade from
    // a persisted shared identity to an unprepared/broken overlay identity.
    if (input.provider === "codex" && input.currentIdentity?.startsWith("codex:shared-v1:")) {
      return persistedLaunchMatchesExactly(input);
    }
    return false;
  }

  // Legacy bindings predate continuation identities. Only exact launch
  // equivalence is safe until one successful resume persists the new identity.
  return persistedLaunchMatchesExactly(input);
}

function prepareContinuationIdentityForCompatibility(input: {
  readonly operation: string;
  readonly provider: ProviderKind;
  readonly providerOptions: ProviderStartOptions | undefined;
  readonly persistedIdentity: string | undefined;
}) {
  return Effect.try({
    try: () =>
      prepareProviderContinuationIdentity(
        input.provider,
        input.providerOptions,
        input.persistedIdentity,
      ),
    catch: (cause) =>
      toValidationError(
        input.operation,
        cause instanceof Error
          ? cause.message
          : "Provider continuation storage could not be prepared safely.",
        cause,
      ),
  });
}

function incompatibleContinuationMessage(input: {
  readonly threadId: ThreadId;
  readonly previousProvider: string;
  readonly previousInstanceId: string;
  readonly nextProvider: ProviderKind;
  readonly nextInstanceId: string;
}): string {
  return `Cannot continue thread '${input.threadId}' from provider instance '${input.previousInstanceId}' (${input.previousProvider}) with '${input.nextInstanceId}' (${input.nextProvider}) because their native session storage is incompatible. Start a new thread or restore the original provider home.`;
}

function readPersistedProviderInstanceId(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    "providerInstanceId" in runtimePayload ? runtimePayload.providerInstanceId : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// getBinding materializes the driver-default instance id onto legacy rows, and
// default-instance sessions persist the default id in their payload. Only a
// NON-default id (or an instance-routed model selection) proves an explicit
// instance binding; everything else must keep seeding launches with the
// binding's persisted provider options.
function bindingHasExplicitProviderInstance(input: {
  readonly binding: ProviderRuntimeBinding;
  readonly persistedPayloadProviderInstanceId: string | undefined;
  readonly persistedModelSelection: ModelSelection | undefined;
}): boolean {
  const defaultId = defaultInstanceIdForDriver(input.binding.provider);
  return (
    (input.binding.providerInstanceId !== undefined &&
      input.binding.providerInstanceId !== defaultId) ||
    (input.persistedPayloadProviderInstanceId !== undefined &&
      input.persistedPayloadProviderInstanceId !== defaultId) ||
    (input.persistedModelSelection !== undefined &&
      resolveModelSelectionInstanceId(input.persistedModelSelection) !== input.binding.provider)
  );
}

function providerInstanceIdFromBinding(binding: ProviderRuntimeBinding): string {
  const persistedModelSelection = readPersistedModelSelection(binding.runtimePayload);
  return (
    binding.providerInstanceId ??
    readPersistedProviderInstanceId(binding.runtimePayload) ??
    (persistedModelSelection
      ? resolveModelSelectionInstanceId(persistedModelSelection)
      : binding.provider)
  );
}

function readPersistedCwd(
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

function modelSelectionForInstance(
  modelSelection: ModelSelection | undefined,
  instance: ResolvedProviderInstance,
): ModelSelection | undefined {
  return modelSelectionForRoute(modelSelection, instance.instanceId);
}

function modelSelectionForRoute(
  modelSelection: ModelSelection | undefined,
  providerInstanceId: string,
): ModelSelection | undefined {
  if (modelSelection === undefined) {
    return undefined;
  }
  return {
    ...modelSelection,
    instanceId: providerInstanceId,
  } as ModelSelection;
}

function sessionMatchesProviderInstance(
  session: ProviderSession,
  providerInstanceId: string,
  persistedProviderInstanceId?: string | undefined,
): boolean {
  const sessionProviderInstanceId = session.providerInstanceId ?? persistedProviderInstanceId;
  return (
    sessionProviderInstanceId === providerInstanceId ||
    (sessionProviderInstanceId === undefined && providerInstanceId === session.provider)
  );
}

function validateModelSelectionMatchesRoute(input: {
  readonly operation: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly provider: ProviderKind;
  readonly providerInstanceId: string;
}): ProviderValidationError | undefined {
  const selection = input.modelSelection;
  if (!selection) {
    return undefined;
  }
  if (selection.instanceId !== undefined) {
    if (selection.instanceId !== input.providerInstanceId) {
      return toValidationError(
        input.operation,
        `Model selection instance '${selection.instanceId}' does not match routed provider instance '${input.providerInstanceId}'.`,
      );
    }
    return undefined;
  }
  return undefined;
}

function runtimePayloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasResumeCursor(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function providerKindConstraint(provider: string): {
  readonly provider?: ProviderKind | undefined;
} {
  return Schema.is(ProviderKind)(provider) ? { provider } : {};
}

function runtimeStatusForEvent(
  event: ProviderRuntimeEvent,
  activeTurnId?: unknown,
): "running" | "stopped" | "error" {
  switch (event.type) {
    case "session.state.changed":
      switch (event.payload.state) {
        case "stopped":
          return "stopped";
        case "error":
          return "error";
        default:
          return "running";
      }
    case "thread.state.changed":
      switch (event.payload.state) {
        case "error":
          return "error";
        case "archived":
        case "closed":
          return "stopped";
        case "compacted":
          return event.turnId === undefined && activeTurnId == null ? "stopped" : "running";
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

function shouldRefreshResumeCursorForEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "thread.started" ||
    event.type === "model.rerouted" ||
    (event.type === "thread.state.changed" &&
      event.payload.state === "compacted" &&
      event.turnId === undefined) ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted"
  );
}

function runtimeLastErrorForEvent(event: ProviderRuntimeEvent): string | null | undefined {
  switch (event.type) {
    case "runtime.error":
      return event.payload.message;
    case "session.state.changed":
      return event.payload.state === "error" ? (event.payload.reason ?? "Session error") : null;
    case "thread.state.changed":
      return event.payload.state === "error" ? "Thread error" : null;
    case "turn.started":
    case "turn.completed":
    case "turn.aborted":
    case "session.exited":
      return null;
    default:
      return undefined;
  }
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const analytics = yield* Effect.service(AnalyticsService);
    const canonicalEventLogger =
      options?.canonicalEventLogger ??
      (options?.canonicalEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
            stream: "canonical",
          })
        : undefined);

    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    const serverSettings = yield* ServerSettingsService;
    const secretStore = yield* ServerSecretStore;
    const credentialsFingerprintKey = yield* secretStore.getOrCreateRandom(
      PROVIDER_OPTIONS_FINGERPRINT_HMAC_SECRET,
      32,
    );
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const runtimeIdleTimers = new Map<ThreadId, ReturnType<typeof setTimeout>>();
    // Fired idle callbacks outlive their timer map entry, so use generations to
    // invalidate async stop work when new user work starts in that gap.
    const runtimeIdleGenerations = new Map<ThreadId, symbol>();
    const runtimeIdleStopsInFlight = new Map<ThreadId, Promise<void>>();
    const runtimeIdleStopMs = Math.max(
      0,
      options?.runtimeIdleStopMs ?? PROVIDER_RUNTIME_IDLE_STOP_MS,
    );
    let stopIdleRuntimeSession: ((threadId: ThreadId, generation: symbol) => void) | null = null;

    const getAdapterForInstance = (
      instance: ResolvedProviderInstance,
      options?: { readonly allowDisabled?: boolean },
    ) =>
      registry.getByInstance
        ? registry.getByInstance(instance.instanceId, options)
        : registry.getByProvider(instance.driver);

    const getAdapterForBinding = (binding: ProviderRuntimeBinding) => {
      const instanceId = providerInstanceIdFromBinding(binding);
      const provider = Schema.is(ProviderKind)(binding.provider) ? binding.provider : null;
      if (instanceId && registry.getByInstance) {
        return registry
          .getByInstance(instanceId as ProviderInstanceId)
          .pipe(
            Effect.flatMap((adapter) =>
              provider && adapter.provider !== provider
                ? registry.getByProvider(provider)
                : Effect.succeed(adapter),
            ),
          )
          .pipe(
            Effect.catch(() =>
              provider
                ? registry.getByProvider(provider)
                : Effect.fail(new ProviderUnsupportedError({ provider: binding.provider })),
            ),
          );
      }
      return provider
        ? registry.getByProvider(provider)
        : Effect.fail(new ProviderUnsupportedError({ provider: binding.provider }));
    };

    const sessionWithPersistedProviderInstance = (
      session: ProviderSession,
    ): Effect.Effect<ProviderSession> =>
      Effect.gen(function* () {
        if (session.providerInstanceId !== undefined) {
          return session;
        }
        const binding = Option.getOrUndefined(
          yield* directory
            .getBinding(session.threadId)
            .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
        );
        const persistedInstanceId =
          binding?.provider === session.provider
            ? providerInstanceIdFromBinding(binding)
            : undefined;
        return {
          ...session,
          providerInstanceId: (persistedInstanceId ?? session.provider) as ProviderInstanceId,
        };
      });

    const invalidateRuntimeIdleGeneration = (threadId: ThreadId): symbol => {
      const generation = Symbol(String(threadId));
      runtimeIdleGenerations.set(threadId, generation);
      return generation;
    };

    const isRuntimeIdleGenerationCurrent = (threadId: ThreadId, generation: symbol): boolean =>
      runtimeIdleGenerations.get(threadId) === generation;

    const retireRuntimeIdleGeneration = (threadId: ThreadId, generation?: symbol): void => {
      if (generation === undefined || isRuntimeIdleGenerationCurrent(threadId, generation)) {
        runtimeIdleGenerations.delete(threadId);
      }
    };

    const clearRuntimeIdleTimer = (threadId: ThreadId) => {
      invalidateRuntimeIdleGeneration(threadId);
      const timer = runtimeIdleTimers.get(threadId);
      if (!timer) {
        return;
      }
      clearTimeout(timer);
      runtimeIdleTimers.delete(threadId);
    };

    const scheduleRuntimeIdleStop = (threadId: ThreadId) => {
      clearRuntimeIdleTimer(threadId);
      if (runtimeIdleStopMs <= 0) {
        retireRuntimeIdleGeneration(threadId);
        return;
      }

      const generation = invalidateRuntimeIdleGeneration(threadId);
      const timer = setTimeout(() => {
        runtimeIdleTimers.delete(threadId);
        stopIdleRuntimeSession?.(threadId, generation);
      }, runtimeIdleStopMs);
      timer.unref();
      runtimeIdleTimers.set(threadId, timer);
    };

    const waitForRuntimeIdleStop = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.promise(() => runtimeIdleStopsInFlight.get(threadId) ?? Promise.resolve());

    const resolveLaunchProviderInstance = (input: {
      readonly operation: string;
      readonly provider?: ProviderSessionStartInput["provider"];
      readonly providerInstanceId?: string | undefined;
      readonly modelSelection?: ModelSelection | undefined;
      readonly providerOptions?: ProviderStartOptions | undefined;
      /**
       * "instance" (default) lets settings-derived instance options override the
       * caller's options (browser-supplied options must not beat the server).
       * "caller" preserves persisted legacy launch options during recovery/fork,
       * where the session's recorded options are the source of truth.
       */
      readonly providerOptionsPrecedence?: "instance" | "caller";
      /**
       * Disabled instances must not start new sessions, but stop/cleanup paths
       * still need to resolve them to tear down runtimes and bindings that were
       * created before the instance was disabled.
       */
      readonly allowDisabled?: boolean;
    }) =>
      Effect.gen(function* () {
        const explicitProvider = input.provider !== undefined;
        const provider = input.provider ?? "codex";
        const requestedInstanceId =
          input.providerInstanceId ??
          (input.modelSelection ? resolveModelSelectionInstanceId(input.modelSelection) : provider);
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((cause) =>
            toValidationError(input.operation, "Failed to load provider instance settings.", cause),
          ),
        );
        const instance = resolveProviderInstance(settings, {
          instanceId: requestedInstanceId,
          ...providerKindConstraint(explicitProvider ? provider : ""),
        });
        if (!instance) {
          return yield* toValidationError(
            input.operation,
            `Unknown provider instance '${requestedInstanceId}'.`,
          );
        }
        if (explicitProvider && provider !== instance.driver) {
          return yield* toValidationError(
            input.operation,
            `Requested provider '${provider}' does not match provider instance '${instance.instanceId}' driver '${instance.driver}'.`,
          );
        }
        if (!instance.enabled && input.allowDisabled !== true) {
          return yield* toValidationError(
            input.operation,
            `Provider instance '${instance.instanceId}' is disabled.`,
          );
        }
        return {
          instance,
          modelSelection: modelSelectionForInstance(input.modelSelection, instance),
          providerOptions:
            input.providerOptionsPrecedence === "caller"
              ? mergeProviderStartOptions(
                  providerStartOptionsFromInstance(instance),
                  input.providerOptions,
                )
              : mergeProviderStartOptions(
                  input.providerOptions,
                  providerStartOptionsFromInstance(instance),
                ),
        } as const;
      });

    const runIdleSensitiveProviderWork = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
      options?: { readonly scheduleIdleStopOnSuccess?: boolean },
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const existingIdleStop = runtimeIdleStopsInFlight.get(threadId);
        const displacedIdleStop = existingIdleStop !== undefined || runtimeIdleTimers.has(threadId);
        const waitForExistingIdleStop =
          existingIdleStop !== undefined ? Effect.promise(() => existingIdleStop) : Effect.void;
        return waitForExistingIdleStop.pipe(
          Effect.tap(() => Effect.sync(() => clearRuntimeIdleTimer(threadId))),
          Effect.flatMap(() => waitForRuntimeIdleStop(threadId)),
          Effect.flatMap(() => effect),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? options?.scheduleIdleStopOnSuccess === true
                ? Effect.sync(() => scheduleRuntimeIdleStop(threadId))
                : Effect.void
              : displacedIdleStop
                ? Effect.sync(() => scheduleRuntimeIdleStop(threadId))
                : Effect.sync(() => retireRuntimeIdleGeneration(threadId)),
          ),
        );
      });

    const reconcileRuntimeIdleTimer = (event: ProviderRuntimeEvent) => {
      switch (event.type) {
        case "turn.started":
          clearRuntimeIdleTimer(event.threadId);
          return;
        case "session.started":
        case "thread.started":
        case "turn.completed":
        case "turn.aborted":
          scheduleRuntimeIdleStop(event.threadId);
          return;
        case "thread.state.changed":
          if (
            event.payload.state === "compacted" ||
            event.payload.state === "archived" ||
            event.payload.state === "closed"
          ) {
            scheduleRuntimeIdleStop(event.threadId);
          }
          return;
        case "session.exited":
          clearRuntimeIdleTimer(event.threadId);
          retireRuntimeIdleGeneration(event.threadId);
          return;
      }
    };

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (canonicalEventLogger) {
          yield* canonicalEventLogger.write(event, null);
        }
        yield* PubSub.publish(runtimeEventPubSub, event);
      });

    const correlateRuntimeEvent = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<ProviderRuntimeEvent | null> =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(
          yield* directory.getBinding(event.threadId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to read provider runtime binding for event correlation", {
                threadId: event.threadId,
                provider: event.provider,
                error,
              }).pipe(Effect.as(Option.none<ProviderRuntimeBinding>())),
            ),
          ),
        );
        if (!binding) {
          return event;
        }
        if (binding.provider !== event.provider) {
          yield* Effect.logWarning("dropping provider event from stale provider binding", {
            threadId: event.threadId,
            eventProvider: event.provider,
            bindingProvider: binding.provider,
            eventType: event.type,
          });
          return null;
        }
        const bindingInstanceId =
          binding.providerInstanceId ?? readPersistedProviderInstanceId(binding.runtimePayload);
        if (
          event.providerInstanceId !== undefined &&
          bindingInstanceId !== undefined &&
          event.providerInstanceId !== bindingInstanceId
        ) {
          yield* Effect.logWarning("dropping provider event from stale provider instance", {
            threadId: event.threadId,
            provider: event.provider,
            eventInstanceId: event.providerInstanceId,
            bindingInstanceId,
            eventType: event.type,
          });
          return null;
        }
        if (event.providerInstanceId === undefined && bindingInstanceId !== undefined) {
          if (event.provider === "codex" && bindingInstanceId !== event.provider) {
            yield* Effect.logWarning("dropping untagged Codex event for non-default binding", {
              threadId: event.threadId,
              bindingInstanceId,
              eventType: event.type,
            });
            return null;
          }
          return { ...event, providerInstanceId: bindingInstanceId };
        }
        return event;
      });

    const upsertSessionBinding = (
      session: ProviderSession,
      threadId: ThreadId,
      extra?: {
        readonly modelSelection?: unknown;
        readonly providerOptions?: unknown;
        readonly providerInstanceId?: string;
        readonly lastRuntimeEvent?: string;
        readonly lastRuntimeEventAt?: string;
        readonly launchOptionsAuthoritative?: boolean;
      },
    ) =>
      directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId:
          session.providerInstanceId ?? extra?.providerInstanceId ?? session.provider,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, credentialsFingerprintKey, extra),
      });

    const upsertStoppedSessionBinding = (
      session: ProviderSession,
      stoppedAt: string,
    ): Effect.Effect<void, ProviderSessionDirectoryWriteError> =>
      directory.upsert({
        threadId: session.threadId,
        provider: session.provider,
        providerInstanceId: session.providerInstanceId ?? session.provider,
        runtimeMode: session.runtimeMode,
        status: "stopped",
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: {
          ...toRuntimePayloadFromSession(session, credentialsFingerprintKey, {
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: stoppedAt,
          }),
          activeTurnId: null,
        },
      });

    const markPersistedThreadStopped = (
      threadId: ThreadId,
      stoppedAt: string,
    ): Effect.Effect<void, ProviderSessionDirectoryWriteError> =>
      directory.getBinding(threadId).pipe(
        Effect.flatMap((bindingOption) =>
          Option.match(bindingOption, {
            onNone: () =>
              Effect.fail(
                new ProviderValidationError({
                  operation: "ProviderService.markPersistedThreadStopped",
                  issue: `No persisted provider binding found for thread '${threadId}'.`,
                }),
              ),
            onSome: (binding) =>
              directory.upsert({
                threadId,
                provider: binding.provider,
                providerInstanceId: binding.providerInstanceId,
                ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
                ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: stoppedAt,
                },
              }),
          }),
        ),
      );

    // Runtime events are where adapters surface provider-native ids; refresh
    // from the live session before idle stop/recovery freezes an old cursor.
    const refreshResumeCursorFromActiveSession = (
      event: ProviderRuntimeEvent,
      binding: ProviderRuntimeBinding,
    ): Effect.Effect<unknown | null | undefined> => {
      if (!shouldRefreshResumeCursorForEvent(event)) {
        return Effect.succeed(binding.resumeCursor);
      }

      return Effect.gen(function* () {
        const adapter = yield* getAdapterForBinding(binding);
        const sessions = yield* adapter.listSessions();
        const activeSession = sessions.find(
          (session) =>
            session.threadId === event.threadId &&
            session.providerInstanceId === binding.providerInstanceId,
        );
        return activeSession?.resumeCursor ?? binding.resumeCursor;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.resume_cursor_refresh_failed", {
            threadId: event.threadId,
            provider: binding.provider,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(binding.resumeCursor)),
        ),
      );
    };

    // Turn ids whose terminal runtime event has already been observed, keyed by
    // thread. sendTurn consults this immediately before its post-dispatch
    // "running" upsert: a turn that settles before that write lands (e.g. a
    // pre-start cancellation) must not be re-marked as running afterwards.
    // A single slot per thread is not enough — sendTurn is not serialized per
    // thread, so overlapping sends can both settle pre-write and the second
    // completion would evict the first turn's marker before its send checked
    // it. Each thread keeps a small FIFO of recent completions instead, and
    // each sendTurn consumes its own marker; the cap bounds markers for turns
    // that never flow through this path.
    const RECENTLY_COMPLETED_TURNS_PER_THREAD = 8;
    const recentlyCompletedTurnsByThread = new Map<ThreadId, Set<string>>();
    const recordRecentlyCompletedTurn = (threadId: ThreadId, turnId: string): void => {
      let turns = recentlyCompletedTurnsByThread.get(threadId);
      if (turns === undefined) {
        turns = new Set();
        recentlyCompletedTurnsByThread.set(threadId, turns);
      }
      turns.delete(turnId);
      turns.add(turnId);
      while (turns.size > RECENTLY_COMPLETED_TURNS_PER_THREAD) {
        const oldest = turns.values().next().value;
        if (oldest === undefined) {
          break;
        }
        turns.delete(oldest);
      }
    };
    const consumeRecentlyCompletedTurn = (threadId: ThreadId, turnId: string): boolean => {
      const turns = recentlyCompletedTurnsByThread.get(threadId);
      if (turns === undefined || !turns.has(turnId)) {
        return false;
      }
      turns.delete(turnId);
      if (turns.size === 0) {
        recentlyCompletedTurnsByThread.delete(threadId);
      }
      return true;
    };

    // Serializes binding writes for a thread between the runtime-event handler
    // and sendTurn's post-dispatch write. Without it a terminal event could
    // land between sendTurn's settled-turn check and its "running" upsert and
    // still be overwritten. Lifecycle events are low-frequency, so a per-thread
    // mutex adds no meaningful contention. Creation is synchronous
    // (Semaphore.makeUnsafe), so concurrent callers cannot mint two locks.
    const bindingWriteLocks = new Map<ThreadId, Semaphore.Semaphore>();
    const withBindingWriteLock = <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      let lock = bindingWriteLocks.get(threadId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        bindingWriteLocks.set(threadId, lock);
      }
      return lock.withPermits(1)(effect);
    };

    const updateSessionBindingFromRuntimeEvent = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void> => {
      switch (event.type) {
        case "session.started":
        case "session.state.changed":
        case "thread.started":
        case "thread.state.changed":
        case "turn.started":
        case "model.rerouted":
        case "turn.completed":
        case "turn.aborted":
        case "session.exited":
        case "runtime.error":
          break;
        default:
          return Effect.void;
      }

      return withBindingWriteLock(
        event.threadId,
        Effect.gen(function* () {
          if (
            (event.type === "turn.completed" || event.type === "turn.aborted") &&
            event.turnId !== undefined
          ) {
            recordRecentlyCompletedTurn(event.threadId, String(event.turnId));
          }
          const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
          if (!binding) {
            return;
          }

          const currentActiveTurnId =
            runtimePayloadRecord(binding.runtimePayload).activeTurnId ?? null;
          const activeTurnId =
            event.type === "turn.started"
              ? (event.turnId ?? null)
              : event.type === "thread.state.changed" && event.payload.state === "compacted"
                ? (event.turnId ?? currentActiveTurnId)
                : event.type === "turn.completed" ||
                    event.type === "turn.aborted" ||
                    (event.type === "thread.state.changed" &&
                      (event.payload.state === "archived" ||
                        event.payload.state === "closed" ||
                        event.payload.state === "error")) ||
                    event.type === "session.exited" ||
                    event.type === "runtime.error" ||
                    (event.type === "session.state.changed" &&
                      (event.payload.state === "ready" ||
                        event.payload.state === "stopped" ||
                        event.payload.state === "error"))
                  ? null
                  : currentActiveTurnId;
          const lastError = runtimeLastErrorForEvent(event);
          const resumeCursor = yield* refreshResumeCursorFromActiveSession(event, binding);

          yield* directory.upsert({
            threadId: event.threadId,
            provider: binding.provider,
            providerInstanceId: binding.providerInstanceId,
            ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
            ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
            status: runtimeStatusForEvent(event, activeTurnId),
            ...(resumeCursor !== undefined ? { resumeCursor } : {}),
            runtimePayload: {
              activeTurnId,
              lastRuntimeEvent: event.type,
              lastRuntimeEventAt: event.createdAt,
              ...(lastError !== undefined ? { lastError } : {}),
            },
          });
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.runtime_binding_update_failed", {
            threadId: event.threadId,
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    };

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) =>
      registry.getByProvider(provider),
    );
    const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const correlatedEvent = yield* correlateRuntimeEvent(event);
        if (correlatedEvent === null) {
          return;
        }
        if (correlatedEvent.type === "turn.started") {
          reconcileRuntimeIdleTimer(correlatedEvent);
        }
        yield* updateSessionBindingFromRuntimeEvent(correlatedEvent);
        if (correlatedEvent.type !== "turn.started") {
          reconcileRuntimeIdleTimer(correlatedEvent);
        }
        yield* publishRuntimeEvent(correlatedEvent);
      });

    // Fan provider events straight into the pubsub so Claude's high-volume
    // streams do not pay for an extra queue hop in the hot path.
    yield* Effect.forEach(adapters, (adapter) =>
      Stream.runForEach(adapter.streamEvents, processRuntimeEvent).pipe(Effect.forkScoped),
    ).pipe(Effect.asVoid);

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
    }) =>
      Effect.gen(function* () {
        const hasPersistedResumeCursor = hasResumeCursor(input.binding.resumeCursor);
        const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);
        const persistedProviderOptions = readPersistedProviderOptions(input.binding.runtimePayload);
        const persistedPayloadProviderInstanceId = readPersistedProviderInstanceId(
          input.binding.runtimePayload,
        );
        const persistedProviderInstanceId = providerInstanceIdFromBinding(input.binding);
        const hasProviderInstanceBinding = bindingHasExplicitProviderInstance({
          binding: input.binding,
          persistedPayloadProviderInstanceId,
          persistedModelSelection,
        });
        const resolved = yield* resolveLaunchProviderInstance({
          operation: input.operation,
          ...providerKindConstraint(input.binding.provider),
          providerInstanceId: persistedProviderInstanceId,
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(!hasProviderInstanceBinding && persistedProviderOptions
            ? {
                providerOptions: persistedProviderOptions,
                providerOptionsPrecedence: "caller" as const,
              }
            : {}),
        });
        const currentContinuationIdentity =
          hasPersistedResumeCursor && input.binding.provider === resolved.instance.driver
            ? yield* prepareContinuationIdentityForCompatibility({
                operation: input.operation,
                provider: resolved.instance.driver,
                providerOptions: resolved.providerOptions,
                persistedIdentity: readPersistedContinuationIdentity(input.binding.runtimePayload),
              })
            : undefined;
        const canReusePersistedResumeCursor =
          hasPersistedResumeCursor &&
          persistedContinuationMatchesLaunch({
            binding: input.binding,
            provider: resolved.instance.driver,
            providerInstanceId: resolved.instance.instanceId,
            providerOptions: resolved.providerOptions,
            credentialsFingerprintKey,
            currentIdentity: currentContinuationIdentity,
          });
        if (
          hasPersistedResumeCursor &&
          providerUsesProtectedNativeContinuation(resolved.instance.driver) &&
          !canReusePersistedResumeCursor
        ) {
          return yield* toValidationError(
            input.operation,
            incompatibleContinuationMessage({
              threadId: input.binding.threadId,
              previousProvider: input.binding.provider,
              previousInstanceId: providerInstanceIdFromBinding(input.binding),
              nextProvider: resolved.instance.driver,
              nextInstanceId: resolved.instance.instanceId,
            }),
          );
        }
        const adapter = yield* getAdapterForInstance(resolved.instance);
        const providerAdapter = yield* registry.getByProvider(resolved.instance.driver);
        const activeSessions = yield* providerAdapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          if (
            sessionMatchesProviderInstance(
              existing,
              resolved.instance.instanceId,
              persistedProviderInstanceId,
            )
          ) {
            const existingWithInstance: ProviderSession = {
              ...existing,
              providerInstanceId: existing.providerInstanceId ?? resolved.instance.instanceId,
            };
            yield* upsertSessionBinding(existingWithInstance, input.binding.threadId);
            yield* analytics.record("provider.session.recovered", {
              provider: existing.provider,
              providerInstanceId: resolved.instance.instanceId,
              strategy: "adopt-existing",
              hasResumeCursor: hasResumeCursor(existing.resumeCursor),
            });
            return { adapter, session: existingWithInstance } as const;
          }

          yield* providerAdapter.stopSession(input.binding.threadId).pipe(
            Effect.tap(() =>
              analytics.record("provider.session.stopped", {
                provider: providerAdapter.provider,
                providerInstanceId: existing.providerInstanceId,
                reason: "stale-provider-instance",
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.stop-stale-failed", {
                threadId: input.binding.threadId,
                provider: providerAdapter.provider,
                providerInstanceId: existing.providerInstanceId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }

        if (!hasPersistedResumeCursor) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
          );
        }

        const persistedCwd = readPersistedCwd(input.binding.runtimePayload);

        const resumed = yield* adapter.startSession({
          threadId: input.binding.threadId,
          provider: resolved.instance.driver,
          providerInstanceId: resolved.instance.instanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(resolved.modelSelection ? { modelSelection: resolved.modelSelection } : {}),
          ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
          ...(canReusePersistedResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        });
        if (resumed.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
          );
        }

        const resumedWithInstance: ProviderSession = {
          ...resumed,
          providerInstanceId: resolved.instance.instanceId,
        };
        yield* upsertSessionBinding(resumedWithInstance, input.binding.threadId, {
          ...(resolved.modelSelection ? { modelSelection: resolved.modelSelection } : {}),
          ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
          launchOptionsAuthoritative: true,
        });
        yield* analytics.record("provider.session.recovered", {
          provider: resumed.provider,
          providerInstanceId: resolved.instance.instanceId,
          strategy: "resume-thread",
          hasResumeCursor: hasResumeCursor(resumed.resumeCursor),
        });
        return { adapter, session: resumedWithInstance } as const;
      });

    const findLiveSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const matches = yield* Effect.forEach(
          adapters,
          (adapter) =>
            adapter.listSessions().pipe(
              Effect.map((sessions) => {
                const session = sessions.find((candidate) => candidate.threadId === threadId);
                return session ? { adapter, session } : null;
              }),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: "unbounded" },
        );
        const listedMatch = matches.find((match) => match !== null);
        if (listedMatch) {
          return listedMatch;
        }
        const adapterMatches = yield* Effect.forEach(
          adapters,
          (adapter) =>
            adapter.hasSession(threadId).pipe(
              Effect.map((hasSession) =>
                hasSession ? { adapter, session: null as ProviderSession | null } : null,
              ),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: "unbounded" },
        );
        return adapterMatches.find((match) => match !== null) ?? null;
      });

    const stopStaleSessionsForThread = (input: {
      readonly threadId: ThreadId;
      readonly provider: ProviderKind;
      readonly providerInstanceId: string;
    }): Effect.Effect<void> =>
      Effect.forEach(
        adapters,
        (adapter) =>
          Effect.gen(function* () {
            const binding = Option.getOrUndefined(
              yield* directory
                .getBinding(input.threadId)
                .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
            );
            const bindingProviderInstanceId =
              binding?.provider === adapter.provider
                ? providerInstanceIdFromBinding(binding)
                : undefined;
            const activeSessions = yield* adapter.listSessions();
            const staleSession = activeSessions.find((session) => {
              if (session.threadId !== input.threadId) {
                return false;
              }
              if (adapter.provider !== input.provider) {
                return true;
              }
              return !sessionMatchesProviderInstance(
                session,
                input.providerInstanceId,
                bindingProviderInstanceId,
              );
            });
            if (!staleSession) {
              return;
            }
            yield* adapter.stopSession(input.threadId).pipe(
              Effect.tap(() =>
                analytics.record("provider.session.stopped", {
                  provider: adapter.provider,
                  providerInstanceId: staleSession.providerInstanceId,
                  reason: "stale-provider-instance",
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.session.stop-stale-failed", {
                  threadId: input.threadId,
                  provider: adapter.provider,
                  providerInstanceId: staleSession.providerInstanceId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }),
        { discard: true, concurrency: "unbounded" },
      ).pipe(Effect.asVoid);

    const providerInstanceExists = (input: {
      readonly operation: string;
      readonly instanceId: string;
      readonly provider: string;
    }) =>
      serverSettings.getSettings.pipe(
        Effect.mapError((cause) =>
          toValidationError(input.operation, "Failed to load provider instance settings.", cause),
        ),
        Effect.map((settings) =>
          Boolean(
            resolveProviderInstance(settings, {
              instanceId: input.instanceId,
              ...providerKindConstraint(input.provider),
            }),
          ),
        ),
      );

    const resolveRoutableSession = (input: {
      readonly threadId: ThreadId;
      readonly operation: string;
      readonly allowRecovery: boolean;
      /** Stop/cleanup paths must still route sessions of disabled instances. */
      readonly allowDisabled?: boolean;
      /**
       * Stop/cleanup paths must also tear down runtimes whose provider
       * instance was deleted from settings; those route by the persisted
       * binding (or live session) instead of failing instance resolution.
       */
      readonly allowDeleted?: boolean;
    }) =>
      Effect.gen(function* () {
        const bindingOption = yield* directory.getBinding(input.threadId);
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding) {
          // Startup extension prompts can fire before startSession has persisted
          // the provider binding, but the adapter already owns a live session.
          const live = yield* findLiveSession(input.threadId);
          if (live) {
            const liveProvider = live.session?.provider ?? live.adapter.provider;
            const liveProviderInstanceId = live.session?.providerInstanceId ?? liveProvider;
            if (input.allowDeleted === true) {
              const exists = yield* providerInstanceExists({
                operation: input.operation,
                instanceId: liveProviderInstanceId,
                provider: liveProvider,
              });
              if (!exists) {
                return {
                  adapter: live.adapter,
                  threadId: input.threadId,
                  providerInstanceId: liveProviderInstanceId,
                  isActive: true,
                } as const;
              }
            }
            const resolved = yield* resolveLaunchProviderInstance({
              operation: input.operation,
              provider: liveProvider,
              providerInstanceId: liveProviderInstanceId,
              ...(input.allowDisabled !== undefined ? { allowDisabled: input.allowDisabled } : {}),
            });
            return {
              adapter: live.adapter,
              threadId: input.threadId,
              providerInstanceId: resolved.instance.instanceId,
              isActive: true,
            } as const;
          }
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
          );
        }
        const bindingProviderInstanceId = providerInstanceIdFromBinding(binding);
        if (input.allowDeleted === true) {
          const exists = yield* providerInstanceExists({
            operation: input.operation,
            instanceId: bindingProviderInstanceId,
            provider: binding.provider,
          });
          if (!exists) {
            const adapter = yield* getAdapterForBinding(binding);
            const isActive = yield* adapter.hasSession(input.threadId);
            return {
              adapter,
              threadId: input.threadId,
              providerInstanceId: bindingProviderInstanceId,
              isActive,
            } as const;
          }
        }
        const resolved = yield* resolveLaunchProviderInstance({
          operation: input.operation,
          ...providerKindConstraint(binding.provider),
          providerInstanceId: bindingProviderInstanceId,
          ...(input.allowDisabled !== undefined ? { allowDisabled: input.allowDisabled } : {}),
        });
        const adapter = yield* getAdapterForInstance(
          resolved.instance,
          input.allowDisabled !== undefined ? { allowDisabled: input.allowDisabled } : undefined,
        );
        const providerAdapter = yield* registry.getByProvider(resolved.instance.driver);
        const activeSessions = yield* providerAdapter.listSessions();
        const activeSession = activeSessions.find((session) => session.threadId === input.threadId);
        if (
          activeSession &&
          sessionMatchesProviderInstance(
            activeSession,
            resolved.instance.instanceId,
            bindingProviderInstanceId,
          )
        ) {
          return {
            adapter,
            threadId: input.threadId,
            providerInstanceId: resolved.instance.instanceId,
            isActive: true,
          } as const;
        }
        if (activeSession) {
          yield* stopStaleSessionsForThread({
            threadId: input.threadId,
            provider: resolved.instance.driver,
            providerInstanceId: resolved.instance.instanceId,
          });
        }

        if (!input.allowRecovery) {
          return {
            adapter,
            threadId: input.threadId,
            providerInstanceId: resolved.instance.instanceId,
            isActive: false,
          } as const;
        }

        const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
        return {
          adapter: recovered.adapter,
          threadId: input.threadId,
          providerInstanceId: recovered.session.providerInstanceId ?? recovered.adapter.provider,
          isActive: true,
        } as const;
      });

    // Lets the command reactor seed its in-memory option cache from the durable
    // binding without exposing persisted credential fingerprints or secrets.
    const sessionBindingMatchesLaunchOptions: NonNullable<
      ProviderServiceShape["sessionBindingMatchesLaunchOptions"]
    > = (input) =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        if (
          !binding ||
          binding.provider !== input.provider ||
          providerInstanceIdFromBinding(binding) !== input.providerInstanceId
        ) {
          return false;
        }

        const resolved = yield* resolveLaunchProviderInstance({
          operation: "ProviderService.sessionBindingMatchesLaunchOptions",
          provider: input.provider,
          providerInstanceId: input.providerInstanceId,
          ...(input.providerOptions !== undefined
            ? { providerOptions: input.providerOptions }
            : {}),
        });
        return providerStartOptionsEqualForProvider(
          resolved.instance.driver,
          credentialsFingerprintKey,
          {
            options: readPersistedProviderOptions(binding.runtimePayload),
            credentialsFingerprint: readPersistedCredentialsFingerprint(binding.runtimePayload),
          },
          resolved.providerOptions,
        );
      });

    const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.startSession",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          threadId,
          provider: parsed.provider ?? "codex",
        };
        clearRuntimeIdleTimer(threadId);
        yield* waitForRuntimeIdleStop(threadId);
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const resolved = yield* resolveLaunchProviderInstance({
          operation: "ProviderService.startSession",
          provider: parsed.provider,
          providerInstanceId:
            input.providerInstanceId ??
            input.modelSelection?.instanceId ??
            (persistedBinding?.provider === input.provider
              ? persistedBinding.providerInstanceId
              : undefined),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        });
        const effectiveProviderOptions = resolved.providerOptions;
        const currentContinuationIdentity =
          persistedBinding !== undefined && persistedBinding.provider === resolved.instance.driver
            ? yield* prepareContinuationIdentityForCompatibility({
                operation: "ProviderService.startSession",
                provider: resolved.instance.driver,
                providerOptions: effectiveProviderOptions,
                persistedIdentity: readPersistedContinuationIdentity(
                  persistedBinding.runtimePayload,
                ),
              })
            : undefined;
        const exactPersistedLaunchMatch =
          persistedBinding !== undefined &&
          persistedLaunchMatchesExactly({
            binding: persistedBinding,
            provider: resolved.instance.driver,
            providerInstanceId: resolved.instance.instanceId,
            providerOptions: effectiveProviderOptions,
            credentialsFingerprintKey,
          });
        const continuationCompatible =
          persistedBinding !== undefined &&
          persistedContinuationMatchesLaunch({
            binding: persistedBinding,
            provider: resolved.instance.driver,
            providerInstanceId: resolved.instance.instanceId,
            providerOptions: effectiveProviderOptions,
            credentialsFingerprintKey,
            currentIdentity: currentContinuationIdentity,
          });
        const hasAvailableResumeCursor =
          input.resumeCursor !== undefined || hasResumeCursor(persistedBinding?.resumeCursor);
        const continuationResetRequested =
          persistedBinding !== undefined &&
          readPersistedContinuationResetRequested(persistedBinding.runtimePayload);
        const canReusePersistedResumeCursor =
          persistedBinding !== undefined &&
          hasResumeCursor(persistedBinding.resumeCursor) &&
          continuationCompatible;
        if (
          persistedBinding !== undefined &&
          !continuationResetRequested &&
          ((!hasAvailableResumeCursor && !exactPersistedLaunchMatch) ||
            (hasAvailableResumeCursor && !continuationCompatible)) &&
          (providerUsesProtectedNativeContinuation(persistedBinding.provider) ||
            providerUsesProtectedNativeContinuation(resolved.instance.driver))
        ) {
          yield* Effect.sync(() => scheduleRuntimeIdleStop(threadId));
          return yield* toValidationError(
            "ProviderService.startSession",
            incompatibleContinuationMessage({
              threadId,
              previousProvider: persistedBinding.provider,
              previousInstanceId: providerInstanceIdFromBinding(persistedBinding),
              nextProvider: resolved.instance.driver,
              nextInstanceId: resolved.instance.instanceId,
            }),
          );
        }
        const effectiveResumeCursor =
          input.resumeCursor ??
          (canReusePersistedResumeCursor ? persistedBinding?.resumeCursor : undefined);
        const adapter = yield* getAdapterForInstance(resolved.instance);
        yield* stopStaleSessionsForThread({
          threadId,
          provider: resolved.instance.driver,
          providerInstanceId: resolved.instance.instanceId,
        });
        const session = yield* adapter.startSession({
          ...input,
          provider: resolved.instance.driver,
          providerInstanceId: resolved.instance.instanceId,
          ...(resolved.modelSelection !== undefined
            ? { modelSelection: resolved.modelSelection }
            : {}),
          ...(effectiveProviderOptions !== undefined
            ? { providerOptions: effectiveProviderOptions }
            : {}),
          ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        });

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        const sessionWithInstance: ProviderSession = {
          ...session,
          providerInstanceId: resolved.instance.instanceId,
        };
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: resolved.modelSelection,
          providerOptions: effectiveProviderOptions,
          providerInstanceId: resolved.instance.instanceId,
          launchOptionsAuthoritative: true,
        });
        yield* analytics.record("provider.session.started", {
          provider: session.provider,
          providerInstanceId: resolved.instance.instanceId,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: hasResumeCursor(session.resumeCursor),
          hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
          hasModel:
            typeof resolved.modelSelection?.model === "string" &&
            resolved.modelSelection.model.trim().length > 0,
        });

        return sessionWithInstance;
      });

    const forkThread: NonNullable<ProviderServiceShape["forkThread"]> = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.forkThread",
          schema: ProviderForkThreadInput,
          payload: rawInput,
        });

        const sourceBinding = Option.getOrUndefined(
          yield* directory.getBinding(input.sourceThreadId),
        );
        if (!sourceBinding) {
          return null;
        }

        const existingTargetBinding = Option.getOrUndefined(
          yield* directory.getBinding(input.threadId),
        );
        if (existingTargetBinding) {
          return null;
        }

        const sourcePayloadProviderInstanceId = readPersistedProviderInstanceId(
          sourceBinding.runtimePayload,
        );
        const sourceBoundProviderInstanceId =
          sourceBinding.providerInstanceId ??
          sourcePayloadProviderInstanceId ??
          sourceBinding.provider;
        const requestedProviderInstanceId = input.modelSelection
          ? resolveModelSelectionInstanceId(input.modelSelection)
          : undefined;
        const sourceProviderInstanceId =
          requestedProviderInstanceId ?? sourceBoundProviderInstanceId;
        const hasSourceProviderInstanceBinding = bindingHasExplicitProviderInstance({
          binding: sourceBinding,
          persistedPayloadProviderInstanceId: sourcePayloadProviderInstanceId,
          persistedModelSelection: input.modelSelection,
        });
        const sourcePersistedProviderOptions = readPersistedProviderOptions(
          sourceBinding.runtimePayload,
        );
        const usesPersistedSourceOptions =
          input.providerOptions === undefined &&
          !hasSourceProviderInstanceBinding &&
          sourcePersistedProviderOptions !== undefined;
        const resolvedSource = yield* resolveLaunchProviderInstance({
          operation: "ProviderService.forkThread",
          providerInstanceId: sourceProviderInstanceId,
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          providerOptions:
            input.providerOptions ??
            (hasSourceProviderInstanceBinding ? undefined : sourcePersistedProviderOptions),
          ...(usesPersistedSourceOptions ? { providerOptionsPrecedence: "caller" as const } : {}),
        });
        if (resolvedSource.instance.driver !== sourceBinding.provider) {
          yield* Effect.logInfo(
            "provider native fork skipped because requested instance uses another provider",
            {
              sourceThreadId: input.sourceThreadId,
              threadId: input.threadId,
              sourceProvider: sourceBinding.provider,
              sourceProviderInstanceId: sourceBoundProviderInstanceId,
              requestedProvider: resolvedSource.instance.driver,
              requestedProviderInstanceId: resolvedSource.instance.instanceId,
            },
          );
          return null;
        }
        const effectiveProviderOptions = resolvedSource.providerOptions;
        const hasSourceResumeCursor = hasResumeCursor(sourceBinding.resumeCursor);
        const currentContinuationIdentity = hasSourceResumeCursor
          ? yield* prepareContinuationIdentityForCompatibility({
              operation: "ProviderService.forkThread",
              provider: resolvedSource.instance.driver,
              providerOptions: effectiveProviderOptions,
              persistedIdentity: readPersistedContinuationIdentity(sourceBinding.runtimePayload),
            })
          : undefined;
        const canReuseSourceResumeCursor =
          hasSourceResumeCursor &&
          persistedContinuationMatchesLaunch({
            binding: sourceBinding,
            provider: resolvedSource.instance.driver,
            providerInstanceId: resolvedSource.instance.instanceId,
            providerOptions: effectiveProviderOptions,
            credentialsFingerprintKey,
            currentIdentity: currentContinuationIdentity,
          });
        if (
          resolvedSource.instance.instanceId !== sourceBoundProviderInstanceId &&
          !canReuseSourceResumeCursor
        ) {
          yield* Effect.logInfo(
            "provider native fork skipped because requested instance cannot reuse source continuation",
            {
              sourceThreadId: input.sourceThreadId,
              threadId: input.threadId,
              sourceProviderInstanceId: sourceBoundProviderInstanceId,
              requestedProviderInstanceId: resolvedSource.instance.instanceId,
            },
          );
          return null;
        }
        if (
          hasSourceResumeCursor &&
          providerUsesProtectedNativeContinuation(resolvedSource.instance.driver) &&
          !canReuseSourceResumeCursor
        ) {
          yield* Effect.logInfo(
            "provider native fork skipped because source continuation storage is incompatible",
            {
              sourceThreadId: input.sourceThreadId,
              threadId: input.threadId,
              sourceProviderInstanceId: sourceBoundProviderInstanceId,
              requestedProviderInstanceId: resolvedSource.instance.instanceId,
            },
          );
          return null;
        }
        const sourceCwd = readPersistedCwd(sourceBinding.runtimePayload);

        const adapter = yield* getAdapterForInstance(resolvedSource.instance);
        if (!adapter.forkThread) {
          return null;
        }

        const forked = yield* adapter
          .forkThread({
            ...input,
            threadId: input.threadId,
            sourceThreadId: input.sourceThreadId,
            ...(resolvedSource.modelSelection !== undefined
              ? { modelSelection: resolvedSource.modelSelection }
              : {}),
            ...(effectiveProviderOptions !== undefined
              ? { providerOptions: effectiveProviderOptions }
              : {}),
            ...(canReuseSourceResumeCursor
              ? { sourceResumeCursor: sourceBinding.resumeCursor }
              : {}),
            ...(sourceCwd ? { sourceCwd } : {}),
            runtimeMode: input.runtimeMode,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("provider native fork failed; falling back", {
                sourceThreadId: input.sourceThreadId,
                targetThreadId: input.threadId,
                cause: error instanceof Error ? error.message : String(error),
              }).pipe(Effect.as(null)),
            ),
          );
        if (!forked) {
          return null;
        }

        const forkedSession = (yield* adapter.listSessions()).find(
          (session) => session.threadId === input.threadId,
        );
        if (forkedSession) {
          const forkedSessionWithInstance: ProviderSession = {
            ...forkedSession,
            providerInstanceId: resolvedSource.instance.instanceId,
          };
          yield* upsertSessionBinding(forkedSessionWithInstance, input.threadId, {
            ...(resolvedSource.modelSelection !== undefined
              ? { modelSelection: resolvedSource.modelSelection }
              : {}),
            ...(effectiveProviderOptions !== undefined
              ? { providerOptions: effectiveProviderOptions }
              : {}),
            providerInstanceId: resolvedSource.instance.instanceId,
            lastRuntimeEvent: "provider.thread.forked",
            lastRuntimeEventAt: new Date().toISOString(),
            launchOptionsAuthoritative: true,
          });
        } else {
          const forkedAt = new Date().toISOString();
          const stoppedForkSession: ProviderSession = {
            provider: adapter.provider,
            providerInstanceId: resolvedSource.instance.instanceId,
            runtimeMode: input.runtimeMode,
            status: "closed",
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(resolvedSource.modelSelection?.model
              ? { model: resolvedSource.modelSelection.model }
              : {}),
            threadId: input.threadId,
            ...(forked.resumeCursor !== undefined ? { resumeCursor: forked.resumeCursor } : {}),
            createdAt: forkedAt,
            updatedAt: forkedAt,
          };
          yield* upsertSessionBinding(stoppedForkSession, input.threadId, {
            ...(resolvedSource.modelSelection !== undefined
              ? { modelSelection: resolvedSource.modelSelection }
              : {}),
            ...(effectiveProviderOptions !== undefined
              ? { providerOptions: effectiveProviderOptions }
              : {}),
            providerInstanceId: resolvedSource.instance.instanceId,
            lastRuntimeEvent: "provider.thread.forked",
            lastRuntimeEventAt: forkedAt,
            launchOptionsAuthoritative: true,
          });
        }
        yield* analytics.record("provider.thread.forked", {
          provider: adapter.provider,
          providerInstanceId: resolvedSource.instance.instanceId,
        });
        return forked;
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.sendTurn",
          schema: ProviderSendTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: parsed.attachments ?? [],
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        return yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.sendTurn",
              allowRecovery: true,
            });
            const routeValidationError = validateModelSelectionMatchesRoute({
              operation: "ProviderService.sendTurn",
              modelSelection: input.modelSelection,
              provider: routed.adapter.provider,
              providerInstanceId: routed.providerInstanceId,
            });
            if (routeValidationError) {
              return yield* routeValidationError;
            }
            const routedModelSelection = modelSelectionForRoute(
              input.modelSelection,
              routed.providerInstanceId,
            );
            const turn = yield* routed.adapter.sendTurn({
              ...input,
              ...(routedModelSelection !== undefined
                ? { modelSelection: routedModelSelection }
                : {}),
            });
            // A turn can settle before this write lands (e.g. a pre-start
            // cancellation completes inside the adapter fork); re-marking the
            // thread as running then would strand it with a stale active turn.
            // Durable metadata (model selection, resume cursor) is still
            // persisted — status stays untouched (upsert keeps the existing
            // value when omitted) and runtimePayload merges per key. The
            // binding-write lock makes the check and the write atomic with the
            // runtime-event handler, so a terminal event cannot slip between
            // them and then be overwritten.
            yield* withBindingWriteLock(
              input.threadId,
              Effect.gen(function* () {
                if (consumeRecentlyCompletedTurn(input.threadId, String(turn.turnId))) {
                  // On the live-fallback path the terminal event can arrive
                  // before any directory row exists (the runtime-event handler
                  // skips threads without a binding), and upsert defaults a
                  // NEW row's omitted status to "running" — so a settled turn
                  // must write an explicit terminal status when it creates the
                  // first row. Existing rows keep their handler-written status.
                  const existingBinding = Option.getOrUndefined(
                    yield* directory.getBinding(input.threadId),
                  );
                  yield* directory.upsert({
                    threadId: input.threadId,
                    provider: routed.adapter.provider,
                    providerInstanceId: routed.providerInstanceId,
                    ...(existingBinding === undefined ? { status: "stopped" as const } : {}),
                    ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
                    ...(routedModelSelection !== undefined
                      ? { runtimePayload: { modelSelection: routedModelSelection } }
                      : {}),
                  });
                } else {
                  yield* directory.upsert({
                    threadId: input.threadId,
                    provider: routed.adapter.provider,
                    providerInstanceId: routed.providerInstanceId,
                    status: "running",
                    ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
                    runtimePayload: {
                      ...(routedModelSelection !== undefined
                        ? { modelSelection: routedModelSelection }
                        : {}),
                      activeTurnId: turn.turnId,
                      lastRuntimeEvent: "provider.sendTurn",
                      lastRuntimeEventAt: new Date().toISOString(),
                    },
                  });
                }
              }),
            );
            yield* analytics.record("provider.turn.sent", {
              provider: routed.adapter.provider,
              model: routedModelSelection?.model,
              interactionMode: input.interactionMode,
              attachmentCount: input.attachments.length,
              hasInput: typeof input.input === "string" && input.input.trim().length > 0,
            });
            return turn;
          }),
        );
      });

    const steerTurn: ProviderServiceShape["steerTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.steerTurn",
          schema: ProviderSteerTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: parsed.attachments ?? [],
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.steerTurn",
            "Either input text or at least one attachment is required",
          );
        }
        return yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.steerTurn",
              allowRecovery: true,
            });
            if (
              !routed.adapter.steerTurn ||
              routed.adapter.capabilities.supportsTurnSteering !== true
            ) {
              return yield* toValidationError(
                "ProviderService.steerTurn",
                `Provider '${routed.adapter.provider}' does not support steering an active turn.`,
              );
            }
            const routeValidationError = validateModelSelectionMatchesRoute({
              operation: "ProviderService.steerTurn",
              modelSelection: input.modelSelection,
              provider: routed.adapter.provider,
              providerInstanceId: routed.providerInstanceId,
            });
            if (routeValidationError) {
              return yield* routeValidationError;
            }
            const routedModelSelection = modelSelectionForRoute(
              input.modelSelection,
              routed.providerInstanceId,
            );
            const turn = yield* routed.adapter.steerTurn({
              ...input,
              ...(routedModelSelection !== undefined
                ? { modelSelection: routedModelSelection }
                : {}),
            });
            yield* directory.upsert({
              threadId: input.threadId,
              provider: routed.adapter.provider,
              providerInstanceId: routed.providerInstanceId,
              status: "running",
              ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
              runtimePayload: {
                ...(routedModelSelection !== undefined
                  ? { modelSelection: routedModelSelection }
                  : {}),
                activeTurnId: turn.turnId,
                lastRuntimeEvent: "provider.steerTurn",
                lastRuntimeEventAt: new Date().toISOString(),
              },
            });
            yield* analytics.record("provider.turn.steered", {
              provider: routed.adapter.provider,
              model: routedModelSelection?.model,
              interactionMode: input.interactionMode,
              attachmentCount: input.attachments.length,
              hasInput: typeof input.input === "string" && input.input.trim().length > 0,
            });
            return turn;
          }),
        );
      });

    const startReview: ProviderServiceShape["startReview"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.startReview",
          schema: ProviderStartReviewInput,
          payload: rawInput,
        });

        return yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.startReview",
              allowRecovery: true,
            });
            if (!routed.adapter.startReview) {
              return yield* toValidationError(
                "ProviderService.startReview",
                `Provider '${routed.adapter.provider}' does not support native review.`,
              );
            }

            const turn = yield* routed.adapter.startReview(input);
            yield* directory.upsert({
              threadId: input.threadId,
              provider: routed.adapter.provider,
              providerInstanceId: routed.providerInstanceId,
              status: "running",
              ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
              runtimePayload: {
                activeTurnId: turn.turnId,
                lastRuntimeEvent: "provider.startReview",
                lastRuntimeEventAt: new Date().toISOString(),
              },
            });
            yield* analytics.record("provider.review.started", {
              provider: routed.adapter.provider,
              target: input.target.type,
            });
            return turn;
          }),
        );
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.interruptTurn",
          schema: ProviderInterruptTurnInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId, input.providerThreadId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      });

    const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToRequest",
          schema: ProviderRespondToRequestInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      });

    const respondToUserInput: ProviderServiceShape["respondToUserInput"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToUserInput",
          schema: ProviderRespondToUserInputInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToUserInput",
          allowRecovery: true,
        });
        yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
      });

    const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        yield* waitForRuntimeIdleStop(input.threadId);
        clearRuntimeIdleTimer(input.threadId);
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
          allowDisabled: true,
          allowDeleted: true,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* waitForRuntimeIdleStop(input.threadId);
        yield* directory.remove(input.threadId);
        retireRuntimeIdleGeneration(input.threadId);
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      });

    const stopRuntimeSessionInternal = (
      rawInput: StopRuntimeSessionInput,
      expectedIdleGeneration?: symbol,
    ): StopRuntimeSessionEffect =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopRuntimeSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        const isExpectedIdleStopCurrent = () =>
          expectedIdleGeneration === undefined ||
          isRuntimeIdleGenerationCurrent(input.threadId, expectedIdleGeneration);
        if (expectedIdleGeneration === undefined) {
          yield* waitForRuntimeIdleStop(input.threadId);
          clearRuntimeIdleTimer(input.threadId);
        } else if (!isExpectedIdleStopCurrent()) {
          return;
        }
        const bindingOption = yield* directory.getBinding(input.threadId);
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding || !isExpectedIdleStopCurrent()) {
          return;
        }
        const adapter = yield* getAdapterForBinding(binding);
        const hasActiveSession = yield* adapter.hasSession(input.threadId);
        if (!isExpectedIdleStopCurrent()) {
          return;
        }
        if (hasActiveSession) {
          yield* adapter.stopSession(input.threadId);
        }
        if (!isExpectedIdleStopCurrent()) {
          return;
        }
        yield* directory.upsert({
          threadId: input.threadId,
          provider: binding.provider,
          providerInstanceId: binding.providerInstanceId,
          ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
          ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
          status: "stopped",
          resumeCursor: binding.resumeCursor,
          runtimePayload: {
            ...(binding.runtimePayload &&
            typeof binding.runtimePayload === "object" &&
            !Array.isArray(binding.runtimePayload)
              ? binding.runtimePayload
              : {}),
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopRuntimeSession",
            lastRuntimeEventAt: new Date().toISOString(),
          },
        });
        yield* analytics.record("provider.session.runtime_stopped", {
          provider: binding.provider,
        });
        retireRuntimeIdleGeneration(input.threadId, expectedIdleGeneration);
      });

    const stopRuntimeSession: StopRuntimeSession = (rawInput) =>
      stopRuntimeSessionInternal(rawInput);

    stopIdleRuntimeSession = (threadId, generation) => {
      const stopEffect = Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        if (!binding) {
          retireRuntimeIdleGeneration(threadId, generation);
          return;
        }

        const adapter = yield* getAdapterForBinding(binding);
        const sessions = yield* adapter.listSessions();
        const session = sessions.find((entry) => entry.threadId === threadId);
        const bindingRuntimePayload = runtimePayloadRecord(binding.runtimePayload);
        const isIdleReadySession =
          session?.status === "ready" ||
          (session?.status === "running" &&
            session.activeTurnId === undefined &&
            binding.status === "stopped" &&
            (bindingRuntimePayload.lastRuntimeEvent === "thread.state.changed" ||
              bindingRuntimePayload.lastRuntimeEvent === "provider.compactThread"));
        if (!session || !isIdleReadySession || session.activeTurnId !== undefined) {
          retireRuntimeIdleGeneration(threadId, generation);
          return;
        }
        // Live adapter snapshots can temporarily omit cursors even though the
        // directory already persisted one from an earlier runtime event.
        if (!hasResumeCursor(session.resumeCursor) && !hasResumeCursor(binding.resumeCursor)) {
          retireRuntimeIdleGeneration(threadId, generation);
          return;
        }
        if (!isRuntimeIdleGenerationCurrent(threadId, generation)) {
          return;
        }

        yield* stopRuntimeSessionInternal({ threadId }, generation);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.idle_stop_failed", {
            threadId,
            cause,
          }),
        ),
      );
      const stopPromise = Effect.runPromise(stopEffect).finally(() => {
        if (runtimeIdleStopsInFlight.get(threadId) === stopPromise) {
          runtimeIdleStopsInFlight.delete(threadId);
        }
      });
      runtimeIdleStopsInFlight.set(threadId, stopPromise);
    };

    const clearSessionResumeCursor: NonNullable<
      ProviderServiceShape["clearSessionResumeCursor"]
    > = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.clearSessionResumeCursor",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        yield* waitForRuntimeIdleStop(input.threadId);
        clearRuntimeIdleTimer(input.threadId);
        const bindingOption = yield* directory.getBinding(input.threadId);
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding) {
          return;
        }
        const adapter = yield* getAdapterForBinding(binding);
        const hasActiveSession = yield* adapter.hasSession(input.threadId);
        if (hasActiveSession) {
          yield* adapter.stopSession(input.threadId);
        }
        yield* waitForRuntimeIdleStop(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: binding.provider,
          providerInstanceId: binding.providerInstanceId,
          ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
          ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
          status: "stopped",
          resumeCursor: null,
          runtimePayload: {
            ...runtimePayloadRecord(binding.runtimePayload),
            continuationResetRequested: true,
          },
        });
        yield* analytics.record("provider.session.resume_cursor_cleared", {
          provider: binding.provider,
        });
        retireRuntimeIdleGeneration(input.threadId);
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.gen(function* () {
        const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) =>
          adapter.listSessions(),
        );
        const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
        const persistedBindings = yield* directory.listThreadIds().pipe(
          Effect.flatMap((threadIds) =>
            Effect.forEach(
              threadIds,
              (threadId) =>
                directory
                  .getBinding(threadId)
                  .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
        );
        const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
        for (const bindingOption of persistedBindings) {
          const binding = Option.getOrUndefined(bindingOption);
          if (binding) {
            bindingsByThreadId.set(binding.threadId, binding);
          }
        }

        return activeSessions.map((session) => {
          const binding = bindingsByThreadId.get(session.threadId);
          if (!binding || binding.provider !== session.provider) {
            return session;
          }
          const bindingProviderInstanceId =
            binding.providerInstanceId ?? readPersistedProviderInstanceId(binding.runtimePayload);
          if (
            session.providerInstanceId !== undefined &&
            bindingProviderInstanceId !== undefined &&
            session.providerInstanceId !== bindingProviderInstanceId
          ) {
            return session;
          }

          const overrides: {
            resumeCursor?: ProviderSession["resumeCursor"];
            runtimeMode?: ProviderSession["runtimeMode"];
            providerInstanceId?: ProviderSession["providerInstanceId"];
          } = {};
          if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
            overrides.resumeCursor = binding.resumeCursor;
          }
          if (binding.runtimeMode !== undefined) {
            overrides.runtimeMode = binding.runtimeMode;
          }
          if (bindingProviderInstanceId !== undefined) {
            overrides.providerInstanceId = bindingProviderInstanceId;
          }
          return Object.assign({}, session, overrides);
        });
      });

    const getCapabilities: ProviderServiceShape["getCapabilities"] = (instanceId) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((cause) =>
            toValidationError(
              "ProviderService.getCapabilities",
              "Failed to load provider instance settings.",
              cause,
            ),
          ),
        );
        const instance = resolveProviderInstance(settings, { instanceId });
        if (!instance) {
          return yield* toValidationError(
            "ProviderService.getCapabilities",
            `Provider instance '${instanceId}' is not configured.`,
          );
        }
        if (!instance.enabled) {
          return yield* toValidationError(
            "ProviderService.getCapabilities",
            `Provider instance '${instanceId}' is disabled.`,
          );
        }
        const adapter = yield* getAdapterForInstance(instance);
        return adapter.capabilities;
      });

    const rollbackConversation: ProviderServiceShape["rollbackConversation"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.rollbackConversation",
          schema: ProviderRollbackConversationInput,
          payload: rawInput,
        });
        if (input.numTurns === 0) {
          return;
        }
        yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.rollbackConversation",
              allowRecovery: true,
            });
            yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
            yield* analytics.record("provider.conversation.rolled_back", {
              provider: routed.adapter.provider,
              turns: input.numTurns,
            });
          }),
          { scheduleIdleStopOnSuccess: true },
        );
      });

    const compactThread: ProviderServiceShape["compactThread"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.compactThread",
          schema: ProviderCompactThreadInput,
          payload: rawInput,
        });
        yield* runIdleSensitiveProviderWork(
          input.threadId,
          Effect.gen(function* () {
            const routed = yield* resolveRoutableSession({
              threadId: input.threadId,
              operation: "ProviderService.compactThread",
              allowRecovery: true,
            });
            if (!routed.adapter.compactThread) {
              return yield* toValidationError(
                "ProviderService.compactThread",
                `Context compaction is unavailable for provider '${routed.adapter.provider}'.`,
              );
            }
            yield* routed.adapter.compactThread(routed.threadId);
            const binding = Option.getOrUndefined(yield* directory.getBinding(routed.threadId));
            if (binding) {
              yield* directory.upsert({
                threadId: routed.threadId,
                provider: binding.provider,
                providerInstanceId: binding.providerInstanceId,
                ...(binding.adapterKey !== undefined ? { adapterKey: binding.adapterKey } : {}),
                ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
                status: "stopped",
                resumeCursor: binding.resumeCursor,
                runtimePayload: {
                  ...runtimePayloadRecord(binding.runtimePayload),
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.compactThread",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              });
            }
            yield* analytics.record("provider.thread.compacted", {
              provider: routed.adapter.provider,
            });
          }),
          { scheduleIdleStopOnSuccess: true },
        );
      });

    const runStopAll = () =>
      Effect.gen(function* () {
        const stoppedAt = new Date().toISOString();
        const threadIds = yield* directory.listThreadIds();
        const activeSessions = yield* Effect.forEach(adapters, (adapter) =>
          adapter.listSessions(),
        ).pipe(
          Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)),
        );
        const hydratedActiveSessions = yield* Effect.forEach(activeSessions, (session) =>
          sessionWithPersistedProviderInstance(session),
        );
        yield* Effect.forEach(hydratedActiveSessions, (session) =>
          upsertStoppedSessionBinding(session, stoppedAt),
        ).pipe(Effect.asVoid);
        yield* Effect.forEach(threadIds, (threadId) =>
          markPersistedThreadStopped(threadId, stoppedAt),
        ).pipe(Effect.asVoid);
        yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
        yield* analytics.record("provider.sessions.stopped_all", {
          sessionCount: threadIds.length,
        });
        yield* analytics.flush;
      });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const timer of runtimeIdleTimers.values()) {
          clearTimeout(timer);
        }
        runtimeIdleTimers.clear();
        runtimeIdleGenerations.clear();
        runtimeIdleStopsInFlight.clear();
        stopIdleRuntimeSession = null;
      }).pipe(
        Effect.andThen(runStopAll()),
        Effect.catch((cause) => Effect.logWarning("failed to stop provider service", { cause })),
      ),
    );

    return {
      startSession,
      forkThread,
      sendTurn,
      steerTurn,
      startReview,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopRuntimeSession,
      clearSessionResumeCursor,
      sessionBindingMatchesLaunchOptions,
      listSessions,
      getCapabilities,
      rollbackConversation,
      compactThread,
      // Each access creates a fresh PubSub subscription so that multiple
      // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
      // independently receive all runtime events.
      get streamEvents(): ProviderServiceShape["streamEvents"] {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
