import { parse as parseToml } from "smol-toml";

import { registerProviderCredentialKey } from "./providerChildEnvironment.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Shared parsing for managed account state and child credential grants. */
export function parseManagedCodexConfig(content: string): {
  readonly root: Record<string, unknown>;
  readonly activeProfile?: Record<string, unknown>;
} {
  let root: Record<string, unknown>;
  try {
    root = parseToml(content) as Record<string, unknown>;
  } catch {
    // TOML parser diagnostics can quote source lines containing credentials.
    throw new Error(
      "Codex config.toml must be valid TOML so Synara can verify managed account state safely.",
    );
  }
  if (root.profile === undefined) return { root };
  if (typeof root.profile !== "string" || root.profile.trim().length === 0) {
    throw new Error("Codex config profile must name a valid profile table.");
  }
  const activeProfile = asRecord(asRecord(root.profiles)?.[root.profile]);
  if (!activeProfile) {
    throw new Error(`Codex config profile '${root.profile}' does not name a valid profile table.`);
  }
  return { root, activeProfile };
}

/** Classify every configured key before a child boundary, and resolve the active grant. */
export function registerCodexProviderCredentials(content: string): {
  activeProvider: string | undefined;
  providerEnvKey: string | undefined;
} {
  const { root: config, activeProfile: profile } = parseManagedCodexConfig(content);
  const providers = asRecord(config.model_providers);
  for (const provider of Object.values(providers ?? {})) {
    const envKey = asRecord(provider)?.env_key;
    if (typeof envKey === "string") registerProviderCredentialKey(envKey);
  }

  const activeProvider = profile?.model_provider ?? config.model_provider;
  if (activeProvider !== undefined && typeof activeProvider !== "string") {
    throw new Error("Codex model_provider must name a provider.");
  }
  const providerEnvKey =
    activeProvider && activeProvider !== "openai"
      ? asRecord(providers?.[activeProvider])?.env_key
      : undefined;
  if (providerEnvKey !== undefined && typeof providerEnvKey !== "string") {
    throw new Error("Codex provider env_key must name an environment variable.");
  }
  return { activeProvider, providerEnvKey };
}
