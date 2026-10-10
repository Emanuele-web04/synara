import {
  AgentProviderUsageQuery,
  ProviderInstanceId,
  type ProviderKind,
  type ServerAgentProviderAccountUsage,
  type ServerAgentProviderUsage,
  type ServerProviderUsageSnapshot,
  type ServerSettings,
} from "@synara/contracts";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";
import { Duration, Effect, Option, Schema } from "effect";

import { redactProviderUsageAccountText, summarizeProviderUsageForAgent } from "./agent.ts";
import { getCachedProviderInstanceUsageSnapshot } from "./index.ts";
import type { ProviderUsageContext } from "./types.ts";

const querySchemaDocument = Schema.toJsonSchemaDocument(AgentProviderUsageQuery);
export const PROVIDER_ACCOUNT_USAGE_INPUT_SCHEMA = {
  ...querySchemaDocument.schema,
  $defs: querySchemaDocument.definitions,
};

export class ProviderUsageAccountNotFoundError extends Error {
  constructor() {
    super("Provider account was not found or does not match the requested provider.");
  }
}

/** Shared account query for both MCP surfaces. Provider refreshes remain owned by the UI path. */
export function makeProviderAccountUsageReader(input: {
  readonly getSettings: Effect.Effect<ServerSettings, unknown>;
  readonly context: Omit<ProviderUsageContext, "nowMs">;
  readonly stateDir: string;
  readonly baseDir: string;
  readonly timeout?: Duration.Input;
  readonly now?: () => number;
}): (query?: unknown) => Effect.Effect<ReadonlyArray<ServerAgentProviderAccountUsage>, unknown> {
  const supported = new Set<ProviderKind>(PROVIDER_USAGE_PROVIDERS);
  const now = input.now ?? Date.now;
  return (query = {}) =>
    Effect.gen(function* () {
      const filter = yield* Schema.decodeUnknownEffect(AgentProviderUsageQuery)(query).pipe(
        Effect.mapError(
          () =>
            new Error("Invalid provider usage query; use provider and instanceId filters only."),
        ),
      );
      const settings = yield* input.getSettings.pipe(Effect.timeout(input.timeout ?? "3 seconds"));
      const instances = deriveProviderInstances(settings).filter(
        (instance) =>
          (filter.provider === undefined || instance.driver === filter.provider) &&
          (filter.instanceId === undefined || instance.instanceId === filter.instanceId),
      );
      if (filter.instanceId !== undefined && instances.length === 0) {
        return yield* Effect.fail(new ProviderUsageAccountNotFoundError());
      }

      const observations = yield* Effect.forEach(
        instances,
        (instance) =>
          supported.has(instance.driver)
            ? readProviderUsageForAgents({
                providers: [instance.driver],
                enabledProviders: new Set(instance.enabled ? [instance.driver] : []),
                loadSnapshot: () =>
                  Effect.tryPromise({
                    try: () =>
                      getCachedProviderInstanceUsageSnapshot(
                        instance,
                        {
                          ...input.context,
                          nowMs: now(),
                          claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
                          codexBinaryPath: settings.providers.codex.binaryPath,
                        },
                        input.stateDir,
                        input.baseDir,
                      ),
                    catch: (error) => error,
                  }),
                ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
                now,
              }).pipe(Effect.map(([usage]) => ({ instance, usage: usage! })))
            : Effect.succeed({
                instance,
                usage: summarizeProviderUsageForAgent({
                  provider: instance.driver,
                  enabled: instance.enabled,
                  snapshot: null,
                  unavailableReason: "unsupported",
                  checkedAtMs: now(),
                }),
              }),
        { concurrency: "unbounded" },
      );
      // Account reads settle independently. Recheck all quota windows at the response time.
      const checkedAtMs = now();
      return observations.map(({ instance, usage }) => {
        const summary = usage.snapshot
          ? summarizeProviderUsageForAgent({
              provider: instance.driver,
              enabled: instance.enabled,
              snapshot: usage.snapshot,
              checkedAtMs,
            })
          : { ...usage, checkedAt: new Date(checkedAtMs).toISOString() };
        return Object.assign(summary, {
          instanceId: ProviderInstanceId.makeUnsafe(instance.instanceId),
          displayName: redactProviderUsageAccountText(instance.displayName),
          isDefault: instance.isDefault,
          enabled: instance.enabled,
        });
      });
    });
}

/** Bound each waiter independently without cancelling the shared cache's in-flight fetch. */
export function readProviderUsageForAgents(input: {
  providers: ReadonlyArray<ProviderKind>;
  enabledProviders: ReadonlySet<ProviderKind>;
  loadSnapshot: (
    provider: ProviderKind,
  ) => Effect.Effect<ServerProviderUsageSnapshot | null, unknown>;
  timeout?: Duration.Input;
  now?: () => number;
}): Effect.Effect<ServerAgentProviderUsage[]> {
  return Effect.gen(function* () {
    const observations = yield* Effect.forEach(
      input.providers,
      (provider) =>
        input.enabledProviders.has(provider)
          ? input.loadSnapshot(provider).pipe(
              Effect.timeoutOption(input.timeout ?? "3 seconds"),
              Effect.map((result) =>
                Option.match(result, {
                  onNone: () => ({
                    provider,
                    snapshot: null,
                    unavailableReason: "timed-out" as const,
                  }),
                  onSome: (snapshot) => ({ provider, snapshot }),
                }),
              ),
              Effect.catch(() =>
                Effect.succeed({
                  provider,
                  snapshot: null,
                  unavailableReason: "provider-error" as const,
                }),
              ),
            )
          : Effect.succeed({ provider, snapshot: null }),
      { concurrency: "unbounded" },
    );
    // Recheck every window at response time: an early result may expire while a peer is loading.
    const checkedAtMs = (input.now ?? Date.now)();
    return observations.map((observation) =>
      summarizeProviderUsageForAgent({
        ...observation,
        enabled: input.enabledProviders.has(observation.provider),
        checkedAtMs,
      }),
    );
  });
}
