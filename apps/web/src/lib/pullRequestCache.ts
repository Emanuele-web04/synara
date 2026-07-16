import type {
  ProjectId,
  PullRequestDetailInput,
  PullRequestSetPinnedInput,
  PullRequestState,
  PullRequestsListResult,
} from "@synara/contracts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { PULL_REQUEST_STATES } from "./pullRequestQueryOptions";

export type PullRequestListCacheEntry = {
  projectId: ProjectId;
  repository: string;
  number: number;
  isPinned: boolean;
  state?: PullRequestState;
  isDraft?: boolean;
};

export type PullRequestListCache = {
  entries: PullRequestListCacheEntry[];
};

export type PinCacheRollback = {
  queryKey: QueryKey;
  previousIsPinned: boolean;
};

export type PullRequestActionListPatch = {
  state?: PullRequestState;
  isDraft?: boolean;
};

export type ActionListCacheRollback = {
  queryKey: QueryKey;
  previousFields: PullRequestActionListPatch;
};

export type PullRequestListQueryScope = {
  state: PullRequestState;
  projectId: ProjectId | null;
};

export function pullRequestIdentityKey(
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): string {
  return JSON.stringify([input.projectId, input.repository.toLowerCase(), input.number]);
}

export function matchesPullRequestIdentity(
  entry: Pick<PullRequestListCacheEntry, "projectId" | "repository" | "number">,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): boolean {
  return (
    entry.projectId === input.projectId &&
    entry.repository.toLowerCase() === input.repository.toLowerCase() &&
    entry.number === input.number
  );
}

export function isPullRequestListQueryKey(queryKey: QueryKey): boolean {
  return (
    queryKey[0] === "pull-requests" &&
    (queryKey[1] === "list" || queryKey[1] === "list-involvement")
  );
}

export function queryKeysEqual(left: QueryKey, right: QueryKey): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function pullRequestListQueryScope(queryKey: QueryKey): PullRequestListQueryScope | null {
  if (!isPullRequestListQueryKey(queryKey)) return null;
  const stateIndex = queryKey[1] === "list" ? 2 : 3;
  const projectIdIndex = queryKey[1] === "list" ? 3 : 4;
  const state = queryKey[stateIndex];
  const projectId = queryKey[projectIdIndex];
  if (!PULL_REQUEST_STATES.includes(state as PullRequestState)) return null;
  if (projectId !== null && typeof projectId !== "string") return null;
  return { state: state as PullRequestState, projectId: projectId as ProjectId | null };
}

function scopeKey(scope: PullRequestListQueryScope): string {
  return `${scope.state}\u0000${scope.projectId ?? ""}`;
}

export function listScopesContainingPullRequest(
  queryClient: QueryClient,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): PullRequestListQueryScope[] {
  const scopes = new Map<string, PullRequestListQueryScope>();
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    if (!data?.entries.some((entry) => matchesPullRequestIdentity(entry, input))) continue;
    const scope = pullRequestListQueryScope(queryKey);
    if (scope) scopes.set(scopeKey(scope), scope);
  }
  return [...scopes.values()];
}

/** List scopes whose cached rows prove they cover this PR or another PR from its repository.
 * This reaches the relevant state/involvement siblings without invalidating unrelated projects. */
export function listScopesContainingPullRequestRepository(
  queryClient: QueryClient,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): PullRequestListQueryScope[] {
  const scopes = new Map<string, PullRequestListQueryScope>();
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    const coversRepository = data?.entries.some(
      (entry) =>
        entry.projectId === input.projectId &&
        entry.repository.toLowerCase() === input.repository.toLowerCase(),
    );
    if (!coversRepository) continue;
    const scope = pullRequestListQueryScope(queryKey);
    if (scope) scopes.set(scopeKey(scope), scope);
  }
  return [...scopes.values()];
}

export function invalidatePullRequestListScopes(
  queryClient: QueryClient,
  scopes: ReadonlyArray<PullRequestListQueryScope>,
) {
  const keys = new Set(scopes.map(scopeKey));
  if (keys.size === 0) return Promise.resolve();
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const scope = pullRequestListQueryScope(query.queryKey);
      return scope !== null && keys.has(scopeKey(scope));
    },
  });
}

/** Stop in-flight list snapshots for only the scopes an optimistic mutation will own. */
export function cancelPullRequestListScopes(
  queryClient: QueryClient,
  scopes: ReadonlyArray<PullRequestListQueryScope>,
) {
  const keys = new Set(scopes.map(scopeKey));
  if (keys.size === 0) return Promise.resolve();
  return queryClient.cancelQueries({
    predicate: (query) => {
      const scope = pullRequestListQueryScope(query.queryKey);
      return scope !== null && keys.has(scopeKey(scope));
    },
  });
}

/** Marks only same-state, same-project LIST-family siblings stale after a forced refresh. */
export function invalidateOtherPullRequestListQueries(
  queryClient: QueryClient,
  refreshedQueryKey: QueryKey,
) {
  const refreshedScope = pullRequestListQueryScope(refreshedQueryKey);
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const candidateScope = pullRequestListQueryScope(query.queryKey);
      return (
        refreshedScope !== null &&
        candidateScope !== null &&
        candidateScope.state === refreshedScope.state &&
        candidateScope.projectId === refreshedScope.projectId &&
        !queryKeysEqual(query.queryKey, refreshedQueryKey)
      );
    },
  });
}

export function optimisticallyPatchPullRequestActionFieldsInListCaches(
  queryClient: QueryClient,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
  entryPatch: PullRequestActionListPatch,
): ActionListCacheRollback[] {
  const rollbackByQuery: ActionListCacheRollback[] = [];
  if (Object.keys(entryPatch).length === 0) return rollbackByQuery;
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    const match = data?.entries.find((entry) => matchesPullRequestIdentity(entry, input));
    if (!match) continue;
    rollbackByQuery.push({
      queryKey,
      previousFields: {
        ...(entryPatch.state !== undefined ? { state: match.state } : {}),
        ...(entryPatch.isDraft !== undefined ? { isDraft: match.isDraft } : {}),
      },
    });
    queryClient.setQueryData<PullRequestListCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              matchesPullRequestIdentity(entry, input) ? { ...entry, ...entryPatch } : entry,
            ),
          }
        : current,
    );
  }
  return rollbackByQuery;
}

export function rollbackPullRequestActionFieldsInListCaches(input: {
  queryClient: QueryClient;
  identity: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">;
  optimisticPatch: PullRequestActionListPatch;
  rollbackByQuery: ReadonlyArray<ActionListCacheRollback>;
}) {
  for (const rollback of input.rollbackByQuery) {
    input.queryClient.setQueryData<PullRequestListCache>(rollback.queryKey, (current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) => {
              if (!matchesPullRequestIdentity(entry, input.identity)) return entry;
              const ownedRollback: PullRequestActionListPatch = {};
              if (
                input.optimisticPatch.state !== undefined &&
                entry.state === input.optimisticPatch.state
              ) {
                const previousState = rollback.previousFields.state;
                if (previousState !== undefined) ownedRollback.state = previousState;
              }
              if (
                input.optimisticPatch.isDraft !== undefined &&
                entry.isDraft === input.optimisticPatch.isDraft
              ) {
                const previousIsDraft = rollback.previousFields.isDraft;
                if (previousIsDraft !== undefined) ownedRollback.isDraft = previousIsDraft;
              }
              return Object.keys(ownedRollback).length > 0 ? { ...entry, ...ownedRollback } : entry;
            }),
          }
        : current,
    );
  }
}

export function patchPullRequestPinInListCaches(
  queryClient: QueryClient,
  input: Pick<PullRequestSetPinnedInput, "projectId" | "repository" | "number">,
  isPinned: boolean,
) {
  for (const [queryKey] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    queryClient.setQueryData<PullRequestListCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              matchesPullRequestIdentity(entry, input) ? { ...entry, isPinned } : entry,
            ),
          }
        : current,
    );
  }
}

export function optimisticallyPatchPullRequestPinInListCaches(
  queryClient: QueryClient,
  input: PullRequestSetPinnedInput,
): PinCacheRollback[] {
  const rollbackByQuery: PinCacheRollback[] = [];
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    const match = data?.entries.find((entry) => matchesPullRequestIdentity(entry, input));
    if (!match) continue;
    rollbackByQuery.push({ queryKey, previousIsPinned: match.isPinned });
    queryClient.setQueryData<PullRequestListCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            entries: current.entries.map((entry) =>
              matchesPullRequestIdentity(entry, input)
                ? { ...entry, isPinned: input.isPinned }
                : entry,
            ),
          }
        : current,
    );
  }
  return rollbackByQuery;
}

export function patchOwnedPullRequestPinInCache(input: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  identity: Pick<PullRequestSetPinnedInput, "projectId" | "repository" | "number">;
  expectedIsPinned: boolean;
  nextIsPinned: boolean;
}) {
  input.queryClient.setQueryData<PullRequestListCache>(input.queryKey, (current) =>
    current
      ? {
          ...current,
          entries: current.entries.map((entry) =>
            matchesPullRequestIdentity(entry, input.identity) &&
            entry.isPinned === input.expectedIsPinned
              ? { ...entry, isPinned: input.nextIsPinned }
              : entry,
          ),
        }
      : current,
  );
}

export function preserveProtectedPinValues(
  result: PullRequestsListResult,
  current: PullRequestListCache | undefined,
  protectedIdentities: ReadonlySet<string>,
): PullRequestsListResult {
  if (!current || protectedIdentities.size === 0) return result;
  // PullRequestListCache is the minimal structural view used for reads, but at runtime the
  // caches hold full wire entries (server results) — safe to re-insert them into the result.
  type ResultEntry = PullRequestsListResult["entries"][number];
  const currentEntryByIdentity = new Map<string, ResultEntry>();
  for (const entry of current.entries as unknown as ReadonlyArray<ResultEntry>) {
    const identityKey = pullRequestIdentityKey(entry);
    if (protectedIdentities.has(identityKey)) {
      currentEntryByIdentity.set(identityKey, entry);
    }
  }
  const resultIdentities = new Set(result.entries.map(pullRequestIdentityKey));
  return {
    ...result,
    // Reconcile both the owned field and list membership. The targeted pin refetch may finish
    // before an older forced snapshot, so preserve current absence after unpin and retain a
    // currently pinned recovered-only row when the stale result omitted it. Missing pinned rows
    // stay ahead of the remote snapshot, matching the server's pinned-first ordering.
    entries: [
      ...[...currentEntryByIdentity].flatMap(([identityKey, entry]) =>
        entry.isPinned && !resultIdentities.has(identityKey) ? [entry] : [],
      ),
      ...result.entries.flatMap((entry) => {
        const identityKey = pullRequestIdentityKey(entry);
        if (!protectedIdentities.has(identityKey)) return [entry];
        const currentEntry = currentEntryByIdentity.get(identityKey);
        return currentEntry ? [{ ...entry, isPinned: currentEntry.isPinned }] : [];
      }),
    ],
  };
}

export type ProtectedActionFieldsByIdentity = ReadonlyMap<
  string,
  ReadonlySet<keyof PullRequestActionListPatch>
>;

export function preserveProtectedActionValues(
  result: PullRequestsListResult,
  current: PullRequestListCache | undefined,
  protectedFieldsByIdentity: ProtectedActionFieldsByIdentity,
): PullRequestsListResult {
  if (!current || protectedFieldsByIdentity.size === 0) return result;
  const currentByIdentity = new Map(
    current.entries.map((entry) => [pullRequestIdentityKey(entry), entry] as const),
  );
  return {
    ...result,
    entries: result.entries.map((entry) => {
      const identityKey = pullRequestIdentityKey(entry);
      const protectedFields = protectedFieldsByIdentity.get(identityKey);
      const currentEntry = currentByIdentity.get(identityKey);
      if (!protectedFields || !currentEntry) return entry;
      return {
        ...entry,
        ...(protectedFields.has("state") && currentEntry.state !== undefined
          ? { state: currentEntry.state }
          : {}),
        ...(protectedFields.has("isDraft") && currentEntry.isDraft !== undefined
          ? { isDraft: currentEntry.isDraft }
          : {}),
      };
    }),
  };
}
