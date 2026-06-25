import type {
  ProviderComposerCapabilities,
  ProviderInstanceId,
  ProviderKind,
  ProviderListAgentsResult,
  ProviderListCommandsResult,
  ProviderListModelsResult,
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ProviderReadPluginResult,
  ProviderSkillsCatalogResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

const EMPTY_SKILLS_RESULT: ProviderListSkillsResult = {
  skills: [],
  source: "empty",
  cached: false,
};

const EMPTY_COMMANDS_RESULT: ProviderListCommandsResult = {
  commands: [],
  source: "empty",
  cached: false,
};

const EMPTY_MODELS_RESULT: ProviderListModelsResult = {
  models: [],
  source: "empty",
  cached: false,
};

const EMPTY_AGENTS_RESULT: ProviderListAgentsResult = {
  agents: [],
  source: "empty",
  cached: false,
};

const EMPTY_PLUGINS_RESULT: ProviderListPluginsResult = {
  marketplaces: [],
  marketplaceLoadErrors: [],
  remoteSyncError: null,
  featuredPluginIds: [],
  source: "empty",
  cached: false,
};

export const providerDiscoveryQueryKeys = {
  all: ["provider-discovery"] as const,
  composerCapabilities: (provider: ProviderKind, instanceId: ProviderInstanceId | null) =>
    ["provider-discovery", "composer-capabilities", provider, instanceId] as const,
  commands: (
    provider: ProviderKind,
    instanceId: ProviderInstanceId | null,
    cwd: string | null,
    agentDir: string | null,
    connectionKey: string | null,
  ) =>
    ["provider-discovery", "commands", provider, instanceId, cwd, agentDir, connectionKey] as const,
  // The skill list is query-independent (filtering is client-side), so the key
  // deliberately excludes the typed filter to avoid a refetch per keystroke.
  skills: (
    provider: ProviderKind,
    instanceId: ProviderInstanceId | null,
    cwd: string | null,
    agentDir: string | null,
  ) => ["provider-discovery", "skills", provider, instanceId, cwd, agentDir] as const,
  skillsCatalog: (cwd: string | null) => ["provider-discovery", "skills-catalog", cwd] as const,
  plugins: (provider: ProviderKind, instanceId: ProviderInstanceId | null, cwd: string | null) =>
    ["provider-discovery", "plugins", provider, instanceId, cwd] as const,
  plugin: (
    provider: ProviderKind,
    instanceId: ProviderInstanceId | null,
    marketplacePath: string,
    pluginName: string,
  ) => ["provider-discovery", "plugin", provider, instanceId, marketplacePath, pluginName] as const,
  models: (
    provider: ProviderKind,
    instanceId: ProviderInstanceId | null,
    binaryPath: string | null,
    homePath: string | null,
    shadowHomePath: string | null,
    accountId: string | null,
    apiEndpoint: string | null,
    agentDir: string | null,
    cwd: string | null,
  ) =>
    [
      "provider-discovery",
      "models",
      provider,
      instanceId,
      binaryPath,
      homePath,
      shadowHomePath,
      accountId,
      apiEndpoint,
      agentDir,
      cwd,
    ] as const,
  agentsForProvider: (provider: ProviderKind, instanceId: ProviderInstanceId | null) =>
    ["provider-discovery", "agents", provider, instanceId] as const,
  agents: (
    provider: ProviderKind,
    instanceId: ProviderInstanceId | null,
    binaryPath: string | null,
    cwd: string | null,
  ) =>
    [
      ...providerDiscoveryQueryKeys.agentsForProvider(provider, instanceId),
      binaryPath,
      cwd,
    ] as const,
};

export function providerComposerCapabilitiesQueryOptions(
  provider: ProviderKind,
  instanceId?: ProviderInstanceId | null,
) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.composerCapabilities(provider, instanceId ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.getComposerCapabilities({
        provider,
        ...(instanceId ? { instanceId } : {}),
      });
    },
    staleTime: Infinity,
  });
}

export function providerSkillsQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  cwd: string | null;
  threadId?: string | null;
  agentDir?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.skills(
      input.provider,
      input.instanceId ?? null,
      input.cwd,
      input.agentDir ?? null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Skill discovery is unavailable.");
      }
      return api.provider.listSkills({
        provider: input.provider,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        cwd: input.cwd,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_SKILLS_RESULT,
  });
}

// Unified cross-provider skills catalog (settings page); not filtered by toggles.
// Keep prior data during refetches so Settings does not flicker back to "Scanning..."
// while the server refreshes filesystem discovery in the background.
export function skillsCatalogQueryOptions(input?: { cwd?: string | null; enabled?: boolean }) {
  const cwd = input?.cwd ?? null;
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.skillsCatalog(cwd),
    queryFn: async (): Promise<ProviderSkillsCatalogResult> => {
      const api = ensureNativeApi();
      return api.provider.listSkillsCatalog(cwd ? { cwd } : {});
    },
    enabled: input?.enabled ?? true,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

export function providerCommandsQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  cwd: string | null;
  threadId?: string | null;
  binaryPath?: string | null;
  serverUrl?: string | null;
  serverPassword?: string | null;
  // Undefined means "not applicable" (non-OpenCode providers); the body normalizes it.
  experimentalWebSockets?: boolean | undefined;
  agentDir?: string | null;
  enabled?: boolean;
}) {
  const connectionKey = JSON.stringify({
    binaryPath: input.binaryPath ?? null,
    serverUrl: input.serverUrl ?? null,
    hasServerPassword: Boolean(input.serverPassword),
    experimentalWebSockets: input.experimentalWebSockets ?? null,
  });
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.commands(
      input.provider,
      input.instanceId ?? null,
      input.cwd,
      input.agentDir ?? null,
      connectionKey,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Command discovery is unavailable.");
      }
      return api.provider.listCommands({
        provider: input.provider,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        cwd: input.cwd,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
        ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
        ...(input.experimentalWebSockets !== undefined
          ? { experimentalWebSockets: input.experimentalWebSockets }
          : {}),
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_COMMANDS_RESULT,
  });
}

export function providerModelsQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  binaryPath?: string | null;
  homePath?: string | null;
  shadowHomePath?: string | null;
  accountId?: string | null;
  apiEndpoint?: string | null;
  agentDir?: string | null;
  cwd?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.models(
      input.provider,
      input.instanceId ?? null,
      input.binaryPath ?? null,
      input.homePath ?? null,
      input.shadowHomePath ?? null,
      input.accountId ?? null,
      input.apiEndpoint ?? null,
      input.agentDir ?? null,
      input.cwd ?? null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listModels({
        provider: input.provider,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.homePath ? { homePath: input.homePath } : {}),
        ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.apiEndpoint ? { apiEndpoint: input.apiEndpoint } : {}),
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
    },
    enabled: input.enabled ?? true,
    retry: input.provider === "cursor" ? 1 : 3,
    staleTime: 60_000,
    placeholderData: (previous) => previous ?? EMPTY_MODELS_RESULT,
  });
}

export function providerAgentsQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  binaryPath?: string | null;
  cwd?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.agents(
      input.provider,
      input.instanceId ?? null,
      input.binaryPath ?? null,
      input.cwd ?? null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listAgents({
        provider: input.provider,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 60_000,
    placeholderData: (previous) => previous ?? EMPTY_AGENTS_RESULT,
  });
}

export function providerPluginsQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  cwd: string | null;
  threadId?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.plugins(
      input.provider,
      input.instanceId ?? null,
      input.cwd,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listPlugins({
        provider: input.provider,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_PLUGINS_RESULT,
  });
}

export function providerReadPluginQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId | null;
  marketplacePath: string;
  pluginName: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.plugin(
      input.provider,
      input.instanceId ?? null,
      input.marketplacePath,
      input.pluginName,
    ),
    queryFn: async (): Promise<ProviderReadPluginResult> => {
      const api = ensureNativeApi();
      return api.provider.readPlugin({
        provider: input.provider,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        marketplacePath: input.marketplacePath,
        pluginName: input.pluginName,
      });
    },
    enabled: input.enabled ?? true,
    staleTime: 60_000,
  });
}

export function supportsSkillDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsSkillDiscovery === true;
}

export function supportsNativeSlashCommandDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsNativeSlashCommandDiscovery === true;
}

export function supportsPluginDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsPluginDiscovery === true;
}

export function supportsThreadCompaction(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadCompaction === true;
}

export function supportsThreadImport(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsThreadImport === true;
}
