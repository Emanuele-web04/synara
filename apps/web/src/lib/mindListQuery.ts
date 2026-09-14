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
