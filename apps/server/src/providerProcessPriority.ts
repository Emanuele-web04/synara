// FILE: providerProcessPriority.ts
// Purpose: Reads server-owned CPU scheduling policy at agent process launch.
// Layer: Server provider runtime

import { Effect, Option } from "effect";
import { ServerSettingsService } from "./serverSettings";

// Optional for standalone runtimes/tests; production supplies the authoritative service.
export const providerProcessPriorityEnabled: Effect.Effect<boolean> = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(service)) return true;
  return yield* service.value.getSettings.pipe(
    Effect.map((settings) => settings.lowerProviderProcessPriority),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read agent process priority setting", cause).pipe(
        Effect.as(true),
      ),
    ),
  );
});
