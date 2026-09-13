import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { MindListResult } from "@synara/contracts";

/**
 * Every Mind list cache entry lives under this root: `"all"` is the global
 * page (shared with the sidebar badge), a project id is that project's own
 * page. Scoping the key by project keeps a selected project's full store —
 * the global page is capped across projects, so filtering it client-side
 * would hide valid rows.
 */
export const MIND_LIST_QUERY_ROOT = ["mind", "list"] as const;

export const mindListQueryKey = (projectId: string | null) =>
  [...MIND_LIST_QUERY_ROOT, projectId ?? "all"] as const;

/**
 * Snapshot every cached list page (global plus any project scopes) before an
 * optimistic mutation rewrites them. `setQueriesData` below fans one updater
 * out to each cached scope so a forget/edit/pin lands in every open view.
 */
export type MindListSnapshot = ReadonlyArray<readonly [QueryKey, MindListResult | undefined]>;

export const snapshotMindLists = async (queryClient: QueryClient): Promise<MindListSnapshot> => {
  await queryClient.cancelQueries({ queryKey: MIND_LIST_QUERY_ROOT });
  return queryClient.getQueriesData<MindListResult>({ queryKey: MIND_LIST_QUERY_ROOT });
};

/**
 * Roll back after a rejected mutation: restore each snapshot that held data.
 * Entries that were undefined stayed untouched (the optimistic updaters
 * return `prev` unchanged when absent), so only defined snapshots restore.
 */
export const restoreMindLists = (
  queryClient: QueryClient,
  snapshot: MindListSnapshot | undefined,
): void => {
  for (const [key, data] of snapshot ?? []) {
    if (data !== undefined) queryClient.setQueryData(key, data);
  }
};
