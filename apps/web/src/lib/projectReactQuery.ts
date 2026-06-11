import type {
  ProjectEntry,
  ProjectListDirectoriesResult,
  ProjectReadFileResult,
  ProjectDiscoverScriptsResult,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesResult,
} from "@t3tools/contracts";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  listDirectories: (cwd: string | null, relativePath: string | null, includeFiles: boolean) =>
    ["projects", "list-directories", cwd, relativePath, includeFiles] as const,
  readFile: (cwd: string | null, relativePath: string | null) =>
    ["projects", "read-file", cwd, relativePath] as const,
  discoverScripts: (cwd: string | null, depth: number) =>
    ["projects", "discover-scripts", cwd, depth] as const,
  searchEntries: (
    cwd: string | null,
    query: string,
    limit: number,
    kind: ProjectEntry["kind"] | null = null,
  ) => ["projects", "search-entries", cwd, query, limit, kind] as const,
  searchLocalEntries: (rootPath: string | null, query: string, limit: number) =>
    ["projects", "search-local-entries", rootPath, query, limit] as const,
};

// Scope live file-change invalidations to one workspace so unrelated
// project/worktree caches stay warm (mirrors invalidateGitQueriesForCwds).
export function invalidateProjectFileQueriesForCwds(
  queryClient: QueryClient,
  cwds: Iterable<string>,
) {
  const uniqueCwds = [...new Set([...cwds].filter((cwd) => cwd.length > 0))];
  return Promise.all(
    uniqueCwds.flatMap((cwd) => [
      queryClient.invalidateQueries({ queryKey: ["projects", "list-directories", cwd] as const }),
      queryClient.invalidateQueries({ queryKey: ["projects", "read-file", cwd] as const }),
      queryClient.invalidateQueries({ queryKey: ["projects", "search-entries", cwd] as const }),
    ]),
  );
}

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_LIST_DIRECTORIES_STALE_TIME = 15_000;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const DEFAULT_DISCOVER_SCRIPTS_DEPTH = 2;
const DEFAULT_DISCOVER_SCRIPTS_STALE_TIME = 30_000;
const DEFAULT_SEARCH_LOCAL_ENTRIES_LIMIT = 50;
const DEFAULT_SEARCH_LOCAL_ENTRIES_STALE_TIME = 10_000;
const DEFAULT_READ_FILE_STALE_TIME = 5_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};
const EMPTY_DISCOVER_SCRIPTS_RESULT: ProjectDiscoverScriptsResult = {
  targets: [],
};
const EMPTY_SEARCH_LOCAL_ENTRIES_RESULT: ProjectSearchLocalEntriesResult = {
  entries: [],
  truncated: false,
};

export function projectListDirectoriesQueryOptions(input: {
  cwd: string | null;
  relativePath?: string | null;
  includeFiles?: boolean;
  enabled?: boolean;
  staleTime?: number;
}) {
  const relativePath = input.relativePath?.trim() || null;
  const includeFiles = input.includeFiles ?? true;
  return queryOptions<ProjectListDirectoriesResult>({
    queryKey: projectQueryKeys.listDirectories(input.cwd, relativePath, includeFiles),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace directory listing is unavailable.");
      }
      return api.projects.listDirectories({
        cwd: input.cwd,
        includeFiles,
        ...(relativePath ? { relativePath } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_LIST_DIRECTORIES_STALE_TIME,
    placeholderData: (previous) => previous ?? { entries: [] },
  });
}

export function projectReadFileQueryOptions(input: {
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions<ProjectReadFileResult>({
    queryKey: projectQueryKeys.readFile(input.cwd, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.relativePath) {
        throw new Error("Workspace file read is unavailable.");
      }
      return api.projects.readFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.relativePath !== null,
    staleTime: input.staleTime ?? DEFAULT_READ_FILE_STALE_TIME,
  });
}

export function projectDiscoverScriptsQueryOptions(input: {
  cwd: string | null;
  enabled?: boolean;
  depth?: number;
  staleTime?: number;
}) {
  const depth = input.depth ?? DEFAULT_DISCOVER_SCRIPTS_DEPTH;
  return queryOptions({
    queryKey: projectQueryKeys.discoverScripts(input.cwd, depth),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Project script discovery is unavailable.");
      }
      return api.projects.discoverScripts({
        cwd: input.cwd,
        depth,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_DISCOVER_SCRIPTS_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_DISCOVER_SCRIPTS_RESULT,
  });
}

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
  kind?: ProjectEntry["kind"];
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.cwd, input.query, limit, input.kind ?? null),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
        ...(input.kind ? { kind: input.kind } : {}),
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
