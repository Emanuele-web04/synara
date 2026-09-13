/**
 * ProviderAdapterRegistryLive - In-memory provider adapter lookup layer.
 *
 * Binds provider kinds (codex/claudeAgent/...) to concrete adapter services.
 * This layer only performs adapter lookup; it does not route session-scoped
 * calls or own provider lifecycle workflows.
 *
 * @module ProviderAdapterRegistryLive
 */
import type { ProviderInstanceId, ProviderRuntimeEvent, ProviderSession } from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { Effect, Layer, Stream } from "effect";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import {
  assertProviderAdapterConformance,
  providerAdapterRegistrationIssues,
} from "../providerAdapterConformance.ts";
import type {
  ProviderAdapterSessionStartInput,
  ProviderAdapterShape,
} from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { DevinAdapter } from "../Services/DevinAdapter.ts";
import { DroidAdapter } from "../Services/DroidAdapter.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import { AntigravityAdapter } from "../Services/AntigravityAdapter.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

export interface ProviderAdapterRegistryLiveOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
}

function stampSessionForInstance(
  session: ProviderSession,
  instanceId: ProviderInstanceId,
): ProviderSession {
  return session.providerInstanceId === instanceId
    ? session
    : { ...session, providerInstanceId: instanceId };
}

// Some adapters do not persist providerInstanceId on their sessions. The
// registry remembers which instance started each untagged thread so those
// live sessions stay visible to the facade that owns them instead of being
// misattributed to the driver's default instance.
type UntaggedSessionClaims = Map<string, ProviderInstanceId>;

function sessionBelongsToInstance(
  session: ProviderSession,
  instanceId: ProviderInstanceId,
  untaggedClaims: UntaggedSessionClaims,
): boolean {
  if (session.providerInstanceId !== undefined) {
    return session.providerInstanceId === instanceId;
  }
  const claimedBy = untaggedClaims.get(session.threadId);
  if (claimedBy !== undefined) {
    return claimedBy === instanceId;
  }
  return instanceId === session.provider;
}

function eventBelongsToInstance(
  event: ProviderRuntimeEvent,
  instanceId: ProviderInstanceId,
  untaggedClaims: UntaggedSessionClaims,
): boolean {
  if (event.providerInstanceId !== undefined) {
    return event.providerInstanceId === instanceId;
  }
  const claimedBy = untaggedClaims.get(event.threadId);
  if (claimedBy !== undefined) {
    return claimedBy === instanceId;
  }
  return instanceId === event.provider;
}

function adapterFacadeForInstance(
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  instanceId: ProviderInstanceId,
  untaggedClaims: UntaggedSessionClaims,
): ProviderAdapterShape<ProviderAdapterError> {
  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      const previousClaim = untaggedClaims.get(input.threadId);
      untaggedClaims.set(input.threadId, instanceId);
      const session = yield* adapter
        .startSession({
          ...input,
          provider: adapter.provider,
          providerInstanceId: instanceId,
        } satisfies ProviderAdapterSessionStartInput)
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (untaggedClaims.get(input.threadId) !== instanceId) return;
              if (previousClaim === undefined) {
                untaggedClaims.delete(input.threadId);
              } else {
                untaggedClaims.set(input.threadId, previousClaim);
              }
            }),
          ),
        );
      untaggedClaims.set(session.threadId, instanceId);
      return stampSessionForInstance(session, instanceId);
    });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    adapter
      .listSessions()
      .pipe(
        Effect.map((sessions) =>
          sessions
            .filter((session) => sessionBelongsToInstance(session, instanceId, untaggedClaims))
            .map((session) => stampSessionForInstance(session, instanceId)),
        ),
      );

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
    listSessions().pipe(
      Effect.map((sessions) => sessions.some((session) => session.threadId === threadId)),
    );

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
    hasSession(threadId).pipe(
      Effect.flatMap((hasActiveSession) =>
        hasActiveSession ? adapter.stopSession(threadId) : Effect.void,
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          if (untaggedClaims.get(threadId) === instanceId) {
            untaggedClaims.delete(threadId);
          }
        }),
      ),
    );

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    listSessions().pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          sessions,
          (session) =>
            adapter.stopSession(session.threadId).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (untaggedClaims.get(session.threadId) === instanceId) {
                    untaggedClaims.delete(session.threadId);
                  }
                }),
              ),
            ),
          { discard: true },
        ),
      ),
    );

  // Native forks can spawn an untagged runtime session for the new thread;
  // claim it for this instance like startSession does so listSessions keeps
  // seeing it.
  const forkThread: ProviderAdapterShape<ProviderAdapterError>["forkThread"] = adapter.forkThread
    ? (input) =>
        Effect.gen(function* () {
          const previousClaim = untaggedClaims.get(input.threadId);
          untaggedClaims.set(input.threadId, instanceId);
          const result = yield* adapter.forkThread!(input).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                if (untaggedClaims.get(input.threadId) !== instanceId) return;
                if (previousClaim === undefined) {
                  untaggedClaims.delete(input.threadId);
                } else {
                  untaggedClaims.set(input.threadId, previousClaim);
                }
              }),
            ),
          );
          untaggedClaims.set(result.threadId, instanceId);
          return result;
        })
    : undefined;

  return {
    ...adapter,
    startSession,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    ...(forkThread ? { forkThread } : {}),
    streamEvents: adapter.streamEvents.pipe(
      Stream.filter((event) => eventBelongsToInstance(event, instanceId, untaggedClaims)),
    ),
  };
}

const makeProviderAdapterRegistry = (options?: ProviderAdapterRegistryLiveOptions) =>
  Effect.gen(function* () {
    const adapters =
      options?.adapters !== undefined
        ? options.adapters
        : [
            yield* CodexAdapter,
            yield* ClaudeAdapter,
            yield* CursorAdapter,
            yield* DevinAdapter,
            yield* AntigravityAdapter,
            yield* GrokAdapter,
            yield* DroidAdapter,
            yield* OpenCodeAdapter,
            yield* PiAdapter,
          ];

    for (const adapter of adapters) {
      assertProviderAdapterConformance(adapter);
    }
    const registrationIssues = providerAdapterRegistrationIssues(adapters);
    if (registrationIssues.length > 0) {
      const detail = registrationIssues
        .map((issue) => `${issue.provider} at index ${issue.duplicateIndex}`)
        .join(", ");
      throw new Error(`Duplicate provider adapter registrations: ${detail}.`);
    }

    const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    const serverSettings = yield* ServerSettingsService;
    const untaggedSessionClaims: UntaggedSessionClaims = new Map();

    const getByProvider: ProviderAdapterRegistryShape["getByProvider"] = (provider) => {
      const adapter = byProvider.get(provider);
      if (!adapter) {
        return Effect.fail(new ProviderUnsupportedError({ provider }));
      }
      return Effect.succeed(adapter);
    };

    const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
      Effect.sync(() => Array.from(byProvider.keys()));

    const getByInstance: NonNullable<ProviderAdapterRegistryShape["getByInstance"]> = (
      instanceId,
      options,
    ) =>
      serverSettings.getSettings.pipe(
        Effect.flatMap((settings) => {
          const instance = deriveProviderInstances(settings).find(
            (candidate) => candidate.instanceId === instanceId,
          );
          if (!instance || (!instance.enabled && options?.allowDisabled !== true)) {
            return Effect.fail(new ProviderUnsupportedError({ provider: instanceId }));
          }
          return getByProvider(instance.driver).pipe(
            Effect.map((adapter) =>
              adapterFacadeForInstance(adapter, instance.instanceId, untaggedSessionClaims),
            ),
          );
        }),
        Effect.mapError((cause) => new ProviderUnsupportedError({ provider: instanceId, cause })),
      );

    const listInstances: NonNullable<ProviderAdapterRegistryShape["listInstances"]> = () =>
      serverSettings.getSettings.pipe(
        Effect.map((settings) =>
          deriveProviderInstances(settings)
            .filter((instance) => instance.enabled && byProvider.has(instance.driver))
            .map((instance) => instance.instanceId),
        ),
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<ProviderInstanceId>)),
      );

    return {
      getByInstance,
      getByProvider,
      listInstances,
      listProviders,
    } satisfies ProviderAdapterRegistryShape;
  });

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistry(),
);
