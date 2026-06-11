// Purpose: Cache-backed read-only discovery queries against a Codex app-server
//   session — skills/list, plugin/list, plugin/read, model/list. Each function
//   owns its cache lookup/populate and the request shape; the manager supplies
//   the cache maps and the two collaborators (context resolution + request send).
// Layer: Free functions over a CodexDiscoveryQueryDeps surface. No transport
//   creation, no map lifecycle beyond the supplied caches. Depends on the pure
//   parsers/protocol modules and contracts result types.
// Exports: CodexDiscoveryQueryDeps, listSkills, listPlugins, readPlugin, listModels.
import type {
  ProviderListModelsResult,
  ProviderListPluginsResult,
  ProviderListSkillsResult,
  ProviderReadPluginResult,
} from "@t3tools/contracts";

import {
  parseModelListResponse,
  parsePluginListResponse,
  parsePluginReadResponse,
  parseSkillsListResponse,
} from "./codexAppServer.parsers.ts";
import { shouldRetrySkillsListWithCwdFallback } from "./codexAppServer.protocol.ts";
import type {
  CodexPluginListInput,
  CodexPluginReadInput,
  CodexSessionContext,
  CodexSkillListInput,
} from "./codexAppServer.types.ts";

const CODEX_DISCOVERY_CACHE_MAX_ENTRIES = 128;

function getRecentCacheEntry<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) {
    return undefined;
  }
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setRecentCacheEntry<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries = CODEX_DISCOVERY_CACHE_MAX_ENTRIES,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

export interface CodexDiscoveryQueryDeps {
  readonly skillsCache: Map<string, ProviderListSkillsResult>;
  readonly pluginsCache: Map<string, ProviderListPluginsResult>;
  readonly pluginDetailCache: Map<string, ProviderReadPluginResult>;
  readonly modelCache: Map<string, ProviderListModelsResult>;
  resolveContextForDiscovery(threadId?: string, cwd?: string): Promise<CodexSessionContext>;
  sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
  ): Promise<TResponse>;
}

export async function listSkills(
  deps: CodexDiscoveryQueryDeps,
  input: CodexSkillListInput,
): Promise<ProviderListSkillsResult> {
  const cwd = input.cwd.trim();
  const cacheKey = JSON.stringify({
    cwd,
    threadId: input.threadId?.trim() || null,
  });
  if (!input.forceReload) {
    const cached = getRecentCacheEntry(deps.skillsCache, cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }
  }

  const context = await deps.resolveContextForDiscovery(input.threadId, cwd);
  let response: Record<string, unknown>;
  try {
    response = await deps.sendRequest<Record<string, unknown>>(context, "skills/list", {
      cwds: [cwd],
      ...(input.forceReload ? { forceReload: true } : {}),
    });
  } catch (error) {
    if (!shouldRetrySkillsListWithCwdFallback(error)) {
      throw error;
    }
    response = await deps.sendRequest<Record<string, unknown>>(context, "skills/list", {
      cwd,
      ...(input.forceReload ? { forceReload: true } : {}),
    });
  }
  const skills = parseSkillsListResponse(response, cwd);
  const result: ProviderListSkillsResult = {
    skills,
    source: "codex-app-server",
    cached: false,
  };
  setRecentCacheEntry(deps.skillsCache, cacheKey, result);
  return result;
}

export async function listPlugins(
  deps: CodexDiscoveryQueryDeps,
  input: CodexPluginListInput,
): Promise<ProviderListPluginsResult> {
  const cwd = input.cwd?.trim() || null;
  const cacheKey = JSON.stringify({
    cwd,
    threadId: input.threadId?.trim() || null,
    forceRemoteSync: input.forceRemoteSync === true,
  });
  if (!input.forceReload) {
    const cached = getRecentCacheEntry(deps.pluginsCache, cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
      };
    }
  }

  const context = await deps.resolveContextForDiscovery(input.threadId, cwd ?? undefined);
  const response = await deps.sendRequest<Record<string, unknown>>(context, "plugin/list", {
    ...(cwd ? { cwds: [cwd] } : {}),
    ...(input.forceRemoteSync ? { forceRemoteSync: true } : {}),
  });
  const result: ProviderListPluginsResult = {
    ...parsePluginListResponse(response),
    source: "codex-app-server",
    cached: false,
  };
  setRecentCacheEntry(deps.pluginsCache, cacheKey, result);
  return result;
}

export async function readPlugin(
  deps: CodexDiscoveryQueryDeps,
  input: CodexPluginReadInput,
): Promise<ProviderReadPluginResult> {
  const marketplacePath = input.marketplacePath.trim();
  const pluginName = input.pluginName.trim();
  const cacheKey = JSON.stringify({
    marketplacePath,
    pluginName,
  });
  const cached = getRecentCacheEntry(deps.pluginDetailCache, cacheKey);
  if (cached) {
    return {
      ...cached,
      cached: true,
    };
  }

  const context = await deps.resolveContextForDiscovery(undefined);
  const response = await deps.sendRequest<Record<string, unknown>>(context, "plugin/read", {
    marketplacePath,
    pluginName,
  });
  const result: ProviderReadPluginResult = {
    plugin: parsePluginReadResponse(response),
    source: "codex-app-server",
    cached: false,
  };
  setRecentCacheEntry(deps.pluginDetailCache, cacheKey, result);
  return result;
}

export async function listModels(
  deps: CodexDiscoveryQueryDeps,
  threadId?: string,
): Promise<ProviderListModelsResult> {
  const cacheKey = threadId?.trim() || "__default__";
  const cached = getRecentCacheEntry(deps.modelCache, cacheKey);
  if (cached) {
    return {
      ...cached,
      cached: true,
    };
  }

  const context = await deps.resolveContextForDiscovery(threadId);
  const response = await deps.sendRequest<Record<string, unknown>>(context, "model/list", {
    cursor: null,
    limit: 50,
    includeHidden: false,
  });
  const models = parseModelListResponse(response);
  const result: ProviderListModelsResult = {
    models,
    source: "codex-app-server",
    cached: false,
  };
  setRecentCacheEntry(deps.modelCache, cacheKey, result);
  return result;
}
