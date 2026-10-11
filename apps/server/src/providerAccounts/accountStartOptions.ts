import type {
  ProviderAccountLaunchContext,
  ProviderKind,
  ProviderStartOptions,
} from "@synara/contracts";

/** Server-resolved credentials are ephemeral; ProviderService redacts environment before persistence. */
export function accountStartOptions(
  provider: ProviderKind,
  options: ProviderStartOptions | undefined,
  launch: ProviderAccountLaunchContext | undefined,
): ProviderStartOptions | undefined {
  if (!launch) return options;
  const environment = { ...launch.environment };
  switch (provider) {
    case "codex": {
      // The explicit source home owns auth; keep the current prepared-home/MCP
      // overlay machinery instead of repointing CODEX_HOME after preparation.
      environment.CODEX_HOME = "";
      const { shadowHomePath: _shadow, ...codex } = options?.codex ?? {};
      return {
        ...options,
        codex: {
          ...codex,
          homePath: launch.profilePath,
          accountId: `managed-${launch.ordinal}-${launch.generation}`,
          environment,
        },
      };
    }
    case "claudeAgent":
      return {
        ...options,
        claudeAgent: { ...options?.claudeAgent, homePath: launch.profilePath, environment },
      };
    case "cursor":
      return { ...options, cursor: { ...options?.cursor, environment } };
    case "grok":
      return { ...options, grok: { ...options?.grok, environment } };
    default:
      return options;
  }
}
