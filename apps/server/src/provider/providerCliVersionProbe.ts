import { Effect, Option, Result } from "effect";

import { isCommandMissingCause, type CommandResult } from "./providerCliOutput";

export type ProviderCliVersionProbeOutcome =
  | { readonly outcome: "missing"; readonly cause: unknown }
  | { readonly outcome: "failure"; readonly cause: unknown }
  | { readonly outcome: "timeout" }
  | { readonly outcome: "nonzero"; readonly result: CommandResult }
  | { readonly outcome: "success"; readonly result: CommandResult };

export const probeProviderCliVersion = <ErrorType, Requirements>(
  command: Effect.Effect<CommandResult, ErrorType, Requirements>,
  timeoutMs: number,
): Effect.Effect<ProviderCliVersionProbeOutcome, never, Requirements> =>
  command.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.result,
    Effect.map((probe): ProviderCliVersionProbeOutcome => {
      if (Result.isFailure(probe)) {
        return isCommandMissingCause(probe.failure)
          ? { outcome: "missing", cause: probe.failure }
          : { outcome: "failure", cause: probe.failure };
      }
      if (Option.isNone(probe.success)) {
        return { outcome: "timeout" };
      }
      const result = probe.success.value;
      return result.code === 0 ? { outcome: "success", result } : { outcome: "nonzero", result };
    }),
  );
