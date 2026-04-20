import type {
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", cwd, query, limit] as const,
  searchLocalEntries: (rootPath: string | null, query: string, limit: number) =>
    ["projects", "search-local-entries", rootPath, query, limit] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const DEFAULT_SEARCH_LOCAL_ENTRIES_LIMIT = 50;
const DEFAULT_SEARCH_LOCAL_ENTRIES_STALE_TIME = 10_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};
const EMPTY_SEARCH_LOCAL_ENTRIES_RESULT: ProjectSearchLocalEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.cwd, input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

export function projectSearchLocalEntriesQueryOptions(input: {
  rootPath: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  includeFiles?: boolean;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_LOCAL_ENTRIES_LIMIT;
  const trimmedQuery = input.query.trim();
  return queryOptions({
    queryKey: projectQueryKeys.searchLocalEntries(input.rootPath, trimmedQuery, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.rootPath) {
        throw new Error("Local entry search is unavailable.");
      }
      return api.projects.searchLocalEntries({
        rootPath: input.rootPath,
        query: trimmedQuery,
        limit,
        ...(input.includeFiles !== undefined ? { includeFiles: input.includeFiles } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.rootPath !== null && trimmedQuery.length >= 2,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_LOCAL_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_LOCAL_ENTRIES_RESULT,
  });
}
