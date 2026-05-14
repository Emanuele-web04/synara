import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderListAgentsResult,
  ProviderListCommandsResult,
  ProviderListModelsResult,
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ProviderReadPluginResult,
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

// Resolved (not rejected) when a provider's model discovery fails, so the
// failure stays isolated to that provider and the shared picker stays usable.
const MODEL_DISCOVERY_ERROR_RESULT: ProviderListModelsResult = {
  models: [],
  source: "error",
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
  composerCapabilities: (provider: ProviderKind) =>
    ["provider-discovery", "composer-capabilities", provider] as const,
  commands: (provider: ProviderKind, cwd: string | null, query: string, agentDir: string | null) =>
    ["provider-discovery", "commands", provider, cwd, query, agentDir] as const,
  skills: (provider: ProviderKind, cwd: string | null, query: string, agentDir: string | null) =>
    ["provider-discovery", "skills", provider, cwd, query, agentDir] as const,
  plugins: (provider: ProviderKind, cwd: string | null) =>
    ["provider-discovery", "plugins", provider, cwd] as const,
  plugin: (provider: ProviderKind, marketplacePath: string, pluginName: string) =>
    ["provider-discovery", "plugin", provider, marketplacePath, pluginName] as const,
  models: (
    provider: ProviderKind,
    binaryPath: string | null,
    apiEndpoint: string | null,
    agentDir: string | null,
  ) => ["provider-discovery", "models", provider, binaryPath, apiEndpoint, agentDir] as const,
  agents: (provider: ProviderKind) => ["provider-discovery", "agents", provider] as const,
};

export function providerComposerCapabilitiesQueryOptions(provider: ProviderKind) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.composerCapabilities(provider),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.getComposerCapabilities({ provider });
    },
    staleTime: Infinity,
  });
}

export function providerSkillsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  agentDir?: string | null;
  query: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.skills(
      input.provider,
      input.cwd,
      input.query,
      input.agentDir ?? null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Skill discovery is unavailable.");
      }
      return api.provider.listSkills({
        provider: input.provider,
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

export function providerCommandsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  agentDir?: string | null;
  query: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.commands(
      input.provider,
      input.cwd,
      input.query,
      input.agentDir ?? null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Command discovery is unavailable.");
      }
      return api.provider.listCommands({
        provider: input.provider,
        cwd: input.cwd,
        ...(input.threadId ? { threadId: input.threadId } : {}),
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
  binaryPath?: string | null;
  apiEndpoint?: string | null;
  agentDir?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.models(
      input.provider,
      input.binaryPath ?? null,
      input.apiEndpoint ?? null,
      input.agentDir ?? null,
    ),
    queryFn: async () => {
      const api = ensureNativeApi();
      try {
        return await api.provider.listModels({
          provider: input.provider,
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
          ...(input.apiEndpoint ? { apiEndpoint: input.apiEndpoint } : {}),
          ...(input.agentDir ? { agentDir: input.agentDir } : {}),
        });
      } catch (error) {
        // Resolve instead of rejecting so one provider's failure can't blank
        // the shared picker; the UI falls back to that provider's static models.
        console.warn(`Model discovery failed for provider "${input.provider}".`, error);
        return MODEL_DISCOVERY_ERROR_RESULT;
      }
    },
    enabled: input.enabled ?? true,
    // queryFn already catches failures into a resolved result, so a retry would
    // only re-run a query that never rejects.
    retry: false,
    staleTime: 60_000,
    placeholderData: (previous) => previous ?? EMPTY_MODELS_RESULT,
  });
}

// True only on a query's first fetch. placeholderData keeps the query in
// "success" status during that fetch (isLoading never flips true), so
// isFetching && isPlaceholderData is what separates it from later refetches.
export function isInitialModelDiscoveryPending(query: {
  isLoading: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
}): boolean {
  return query.isLoading || (query.isFetching && query.isPlaceholderData);
}

export function providerAgentsQueryOptions(input: { provider: ProviderKind; enabled?: boolean }) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.agents(input.provider),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listAgents({ provider: input.provider });
    },
    enabled: input.enabled ?? true,
    staleTime: 60_000,
    placeholderData: (previous) => previous ?? EMPTY_AGENTS_RESULT,
  });
}

export function providerPluginsQueryOptions(input: {
  provider: ProviderKind;
  cwd: string | null;
  threadId?: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.plugins(input.provider, input.cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listPlugins({
        provider: input.provider,
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
  marketplacePath: string;
  pluginName: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.plugin(
      input.provider,
      input.marketplacePath,
      input.pluginName,
    ),
    queryFn: async (): Promise<ProviderReadPluginResult> => {
      const api = ensureNativeApi();
      return api.provider.readPlugin({
        provider: input.provider,
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
