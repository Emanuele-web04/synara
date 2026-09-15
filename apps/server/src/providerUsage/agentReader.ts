import type {
  ProviderKind,
  ServerAgentProviderUsage,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import { Duration, Effect, Option } from "effect";

import { summarizeProviderUsageForAgent } from "./agent.ts";

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
