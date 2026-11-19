// FILE: botEngines.ts
// Purpose: Which providers a new bot can start on, best first (SynBot, Beta).
// Layer: Pure bot engine policy
// Exports: STRONG_BOT_PROVIDERS, rankBotProviders

import { DEFAULT_MODEL_BY_PROVIDER, type ProviderKind } from "@synara/contracts";

/** Providers SynBot prefers for its own chat, in order. */
export const STRONG_BOT_PROVIDERS: readonly ProviderKind[] = ["codex", "claudeAgent"];

/**
 * The providers a bot can start on, best first: the strong providers, then every other enabled
 * provider that has a default model and that health reports available. Without that tail, a
 * computer with neither Codex nor Claude could not set up SynBot at all. An unknown status counts
 * as available only for the strong providers, as it always has; a fallback must be known to run.
 */
export function rankBotProviders(input: {
  readonly isEnabled: (provider: ProviderKind) => boolean;
  readonly statuses: ReadonlyArray<{ readonly provider: string; readonly available: boolean }>;
}): ProviderKind[] {
  const status = (provider: ProviderKind) =>
    input.statuses.find((entry) => entry.provider === provider);
  const strong = STRONG_BOT_PROVIDERS.filter((provider) => {
    const health = status(provider);
    return input.isEnabled(provider) && (health === undefined || health.available);
  });
  const fallbacks = (Object.keys(DEFAULT_MODEL_BY_PROVIDER) as ProviderKind[]).filter(
    (provider) =>
      !STRONG_BOT_PROVIDERS.includes(provider) &&
      input.isEnabled(provider) &&
      status(provider)?.available === true,
  );
  return [...strong, ...fallbacks];
}
