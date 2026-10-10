import type {
  GitHubInboxItemKind,
  GitHubInboxListResult,
  GitHubInboxState,
  ProjectId,
  PullRequestDetailInput,
  PullRequestProjectContext,
  PullRequestSetPinnedInput,
  PullRequestState,
} from "@synara/contracts";
import {
  coalescePullRequestListEntries,
  pullRequestListEntryHasProject,
  pullRequestListProjectContexts,
  pullRequestListProjectPin,
  pullRequestListRepositoryIdentity,
  updatePullRequestListEntryProjectPin,
} from "@synara/shared/githubRepository";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { GITHUB_INBOX_STATES } from "./githubInboxQueryOptions";

// List caches are the GitHub inbox lists (`["github-inbox", "list", state, sort]`), which hold pull
// requests and issues. Pins apply to both kinds; action fields only ever match pull requests
// because GitHub numbers both kinds from one sequence per repository.
export type PullRequestListCacheEntry = {
  kind?: GitHubInboxItemKind;
  projectId: ProjectId;
  projectTitle?: string;
  repository: string;
  number: number;
  isPinned: boolean;
  headBranch?: string;
  projectContexts?: ReadonlyArray<PullRequestProjectContext>;
  state?: PullRequestState;
  isDraft?: boolean;
};

export type PullRequestListCache = {
  items: PullRequestListCacheEntry[];
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

/** Mutation scopes span every sort of a state; filters are applied on the client. */
export type PullRequestListQueryScope = {
  state: GitHubInboxState;
};

/** Merged pull requests live in the closed inbox list. */
export function githubInboxStateForPullRequestState(state: PullRequestState): GitHubInboxState {
  return state === "open" ? "open" : "closed";
}

export function pullRequestIdentityKey(
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): string {
  return JSON.stringify([input.projectId, input.repository.toLowerCase(), input.number]);
}

export function pullRequestRemoteIdentityKey(
  input: Pick<PullRequestDetailInput, "repository" | "number">,
): string {
  return pullRequestListRepositoryIdentity(input);
}

function matchesPullRequestRemoteIdentity(
  entry: Pick<PullRequestListCacheEntry, "repository" | "number">,
  input: Pick<PullRequestDetailInput, "repository" | "number">,
): boolean {
  return pullRequestRemoteIdentityKey(entry) === pullRequestRemoteIdentityKey(input);
}

function matchesPullRequestPinIdentity(
  entry: PullRequestListCacheEntry,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): boolean {
  return (
    matchesPullRequestRemoteIdentity(entry, input) &&
    pullRequestListEntryHasProject(entry, input.projectId)
  );
}

function updateEntryProjectPin(
  entry: PullRequestListCacheEntry,
  projectId: ProjectId,
  isPinned: boolean,
): PullRequestListCacheEntry {
  return updatePullRequestListEntryProjectPin(entry, projectId, isPinned);
}

export function isPullRequestListQueryKey(queryKey: QueryKey): boolean {
  return queryKey[0] === "github-inbox" && queryKey[1] === "list";
}

export function queryKeysEqual(left: QueryKey, right: QueryKey): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function pullRequestListQueryScope(queryKey: QueryKey): PullRequestListQueryScope | null {
  if (!isPullRequestListQueryKey(queryKey)) return null;
  const state = queryKey[2];
  if (!GITHUB_INBOX_STATES.includes(state as GitHubInboxState)) return null;
  return { state: state as GitHubInboxState };
}

function scopeKey(scope: PullRequestListQueryScope): string {
  return scope.state;
}

export function listScopesContainingPullRequest(
  queryClient: QueryClient,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): PullRequestListQueryScope[] {
  const scopes = new Map<string, PullRequestListQueryScope>();
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    if (!data?.items.some((entry) => matchesPullRequestPinIdentity(entry, input))) continue;
    const scope = pullRequestListQueryScope(queryKey);
    if (scope) scopes.set(scopeKey(scope), scope);
  }
  return [...scopes.values()];
}

/** List scopes whose cached rows prove they cover this PR or another item from its repository. */
export function listScopesContainingPullRequestRepository(
  queryClient: QueryClient,
  input: Pick<PullRequestDetailInput, "projectId" | "repository" | "number">,
): PullRequestListQueryScope[] {
  const scopes = new Map<string, PullRequestListQueryScope>();
  for (const [queryKey, data] of queryClient.getQueriesData<PullRequestListCache>({
    predicate: (query) => isPullRequestListQueryKey(query.queryKey),
  })) {
    const coversRepository = data?.items.some(
      (entry) => entry.repository.toLowerCase() === input.repository.toLowerCase(),
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
    const match = data?.items.find((entry) => matchesPullRequestRemoteIdentity(entry, input));
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
            items: current.items.map((entry) =>
              matchesPullRequestRemoteIdentity(entry, input) ? { ...entry, ...entryPatch } : entry,
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
            items: current.items.map((entry) => {
              if (!matchesPullRequestRemoteIdentity(entry, input.identity)) return entry;
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
            items: current.items.map((entry) =>
              matchesPullRequestPinIdentity(entry, input)
                ? updateEntryProjectPin(entry, input.projectId, isPinned)
                : entry,
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
    const match = data?.items.find((entry) => matchesPullRequestPinIdentity(entry, input));
    if (!match) continue;
    rollbackByQuery.push({
      queryKey,
      previousIsPinned: pullRequestListProjectPin(match, input.projectId)!,
    });
    queryClient.setQueryData<PullRequestListCache>(queryKey, (current) =>
      current
        ? {
            ...current,
            items: current.items.map((entry) =>
              matchesPullRequestPinIdentity(entry, input)
                ? updateEntryProjectPin(entry, input.projectId, input.isPinned)
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
          items: current.items.map((entry) =>
            matchesPullRequestPinIdentity(entry, input.identity) &&
            pullRequestListProjectPin(entry, input.identity.projectId) === input.expectedIsPinned
              ? updateEntryProjectPin(entry, input.identity.projectId, input.nextIsPinned)
              : entry,
          ),
        }
      : current,
  );
}

export function preserveProtectedPinValues(
  result: GitHubInboxListResult,
  current: PullRequestListCache | undefined,
  protectedIdentities: ReadonlySet<string>,
): GitHubInboxListResult {
  if (!current || protectedIdentities.size === 0) return result;
  type ResultEntry = GitHubInboxListResult["items"][number];
  const currentEntries = current.items as unknown as ReadonlyArray<ResultEntry>;
  const currentByRemoteIdentity = new Map(
    currentEntries.map((entry) => [pullRequestRemoteIdentityKey(entry), entry] as const),
  );
  const resultRemoteIdentities = new Set(result.items.map(pullRequestRemoteIdentityKey));
  const missingProtectedPinnedEntries = currentEntries.filter((entry) => {
    if (resultRemoteIdentities.has(pullRequestRemoteIdentityKey(entry))) return false;
    return pullRequestListProjectContexts(entry).some(
      (context) =>
        context.isPinned &&
        protectedIdentities.has(
          pullRequestIdentityKey({
            projectId: context.projectId,
            repository: entry.repository,
            number: entry.number,
          }),
        ),
    );
  });
  return {
    ...result,
    items: [
      ...missingProtectedPinnedEntries,
      ...result.items.flatMap((entry): ResultEntry[] => {
        const currentEntry = currentByRemoteIdentity.get(pullRequestRemoteIdentityKey(entry));
        const contexts = pullRequestListProjectContexts(entry);
        const protectedContexts = contexts.filter((context) =>
          protectedIdentities.has(
            pullRequestIdentityKey({
              projectId: context.projectId,
              repository: entry.repository,
              number: entry.number,
            }),
          ),
        );
        if (!currentEntry) {
          if (protectedContexts.length === 0) return [entry];
          // A missing current row is an acknowledged unpin of recovered-only data. Retain an
          // aggregate row only when it still represents an unprotected project context.
          if (protectedContexts.length === contexts.length) return [];
          return [
            protectedContexts.reduce(
              (next, context) =>
                updatePullRequestListEntryProjectPin(next, context.projectId, false),
              entry,
            ),
          ];
        }
        const hasAggregateContexts =
          (entry.projectContexts?.length ?? 0) > 0 ||
          (currentEntry.projectContexts?.length ?? 0) > 0;
        const mergedEntry = hasAggregateContexts
          ? coalescePullRequestListEntries([entry, currentEntry], {
              preferredProjectId: entry.projectId,
            })[0]!
          : entry;
        return [
          pullRequestListProjectContexts(currentEntry).reduce((next, context) => {
            const identityKey = pullRequestIdentityKey({
              projectId: context.projectId,
              repository: entry.repository,
              number: entry.number,
            });
            return protectedIdentities.has(identityKey)
              ? updatePullRequestListEntryProjectPin(next, context.projectId, context.isPinned)
              : next;
          }, mergedEntry),
        ];
      }),
    ],
  };
}

export type ProtectedActionFieldsByIdentity = ReadonlyMap<
  string,
  ReadonlySet<keyof PullRequestActionListPatch>
>;

export function preserveProtectedActionValues(
  result: GitHubInboxListResult,
  current: PullRequestListCache | undefined,
  protectedFieldsByIdentity: ProtectedActionFieldsByIdentity,
): GitHubInboxListResult {
  if (!current || protectedFieldsByIdentity.size === 0) return result;
  const currentByIdentity = new Map(
    current.items.map((entry) => [pullRequestRemoteIdentityKey(entry), entry] as const),
  );
  return {
    ...result,
    items: result.items.map((entry) => {
      const identityKey = pullRequestRemoteIdentityKey(entry);
      const protectedFields = protectedFieldsByIdentity.get(identityKey);
      const currentEntry = currentByIdentity.get(identityKey);
      // Action fields belong to pull requests; an issue row never carries them.
      if (!protectedFields || !currentEntry || entry.kind === "issue") return entry;
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
