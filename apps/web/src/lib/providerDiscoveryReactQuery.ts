import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderListModelsResult,
  ProviderListSkillsResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

const EMPTY_SKILLS_RESULT: ProviderListSkillsResult = {
  skills: [],
  source: "empty",
  cached: false,
};

const EMPTY_MODELS_RESULT: ProviderListModelsResult = {
  models: [],
  source: "empty",
  cached: false,
};

export const providerDiscoveryQueryKeys = {
  all: ["provider-discovery"] as const,
  composerCapabilities: (provider: ProviderKind) =>
    ["provider-discovery", "composer-capabilities", provider] as const,
  skills: (provider: ProviderKind, cwd: string | null, query: string) =>
    ["provider-discovery", "skills", provider, cwd, query] as const,
  models: (provider: ProviderKind) => ["provider-discovery", "models", provider] as const,
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
  query: string;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.skills(input.provider, input.cwd, input.query),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Skill discovery is unavailable.");
      }
      return api.provider.listSkills({
        provider: input.provider,
        cwd: input.cwd,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: 30_000,
    placeholderData: (previous) => previous ?? EMPTY_SKILLS_RESULT,
  });
}

export function providerModelsQueryOptions(input: { provider: ProviderKind; enabled?: boolean }) {
  return queryOptions({
    queryKey: providerDiscoveryQueryKeys.models(input.provider),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.provider.listModels({ provider: input.provider });
    },
    enabled: input.enabled ?? true,
    staleTime: 60_000,
    placeholderData: (previous) => previous ?? EMPTY_MODELS_RESULT,
  });
}

export function supportsSkillDiscovery(
  capabilities: ProviderComposerCapabilities | undefined,
): boolean {
  return capabilities?.supportsSkillDiscovery === true;
}
