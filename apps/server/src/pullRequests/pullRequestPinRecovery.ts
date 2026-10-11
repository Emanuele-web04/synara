import type {
  GitHubInboxItem,
  GitHubInboxListError,
  GitHubInboxState,
  OrchestrationProject,
  ProjectId,
} from "@synara/contracts";
import { Effect } from "effect";

import type { GitHubCliError } from "../git/Errors";
import type { GitHubRepositoryInboxLookup } from "../git/Services/GitHubCli";
import {
  PROJECT_PULL_REQUEST_PIN_LIMIT,
  type ProjectPullRequestPin,
  type ProjectPullRequestPinsShape,
} from "../persistence/Services/ProjectPullRequestPins";
import {
  repositoryPullRequestIdentityKey,
  selectRecoverablePullRequestPins,
} from "../pullRequests.logic";

/** Unique remote lookups per list request. Pins are capped per project, so this bounds recovery
 * work before any GitHub request is considered. */
export const PULL_REQUEST_PIN_RECOVERY_LIMIT = PROJECT_PULL_REQUEST_PIN_LIMIT + 4;

/** One repository's inbox batch, as pin recovery needs it. */
export type PinRecoveryContext = {
  readonly cwd: string;
  readonly repository: string;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  /** Either list (pull requests or issues) hit the page cap, so a pin may be missing. */
  readonly truncated: boolean;
};

/**
 * Restore pinned pull requests and issues that fall outside a repository's capped inbox lists.
 * Pins do not record a kind, so each lookup asks GitHub for "issue or pull request #n". Only an
 * exact per-number NOT_FOUND answer deletes a pin; permission, auth, timeout, and transport
 * failures keep it for a later retry.
 */
export function recoverPinnedInboxItems<C extends PinRecoveryContext>(input: {
  state: GitHubInboxState;
  pins: ReadonlyArray<ProjectPullRequestPin>;
  pinStore: ProjectPullRequestPinsShape;
  /** Project-local identity keys (`projectPullRequestIdentityKey`) already in the response. */
  presentKeys: ReadonlySet<string>;
  recoveryContexts: ReadonlyArray<C>;
  repositoryKeysByProject: ReadonlyMap<ProjectId, Set<string>>;
  projectById: ReadonlyMap<ProjectId, OrchestrationProject>;
  // Deliberately boolean, not a type predicate: callers check values already typed
  // GitHubCliError, and a predicate would narrow the false branch to `never`.
  isGlobalError: (error: unknown) => boolean;
  loadItems: (
    context: C,
    numbers: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyMap<number, GitHubRepositoryInboxLookup>, GitHubCliError>;
  buildItem: (
    context: C,
    lookup: Extract<GitHubRepositoryInboxLookup, { _tag: "found" }>,
  ) => GitHubInboxItem;
  describeError: (error: GitHubCliError) => string;
}) {
  return Effect.gen(function* () {
    const errors = new Map<string, GitHubInboxListError>();
    const addError = (project: OrchestrationProject, repository: string, message: string) => {
      errors.set(`${project.id}\u0000${message}`, {
        projectId: project.id,
        projectTitle: project.title,
        repository,
        message,
        reason: "unavailable",
        retryAt: null,
        showingCachedData: false,
      });
    };
    if (input.pins.length === 0) {
      return { items: [] as GitHubInboxItem[], errors: [] as GitHubInboxListError[] };
    }

    const contextByRepository = new Map(
      input.recoveryContexts.map((context) => [context.repository.toLowerCase(), context]),
    );
    const allMissingPins = selectRecoverablePullRequestPins({
      pins: input.pins,
      presentKeys: input.presentKeys,
      repositoryKeysByProject: input.repositoryKeysByProject,
      batches: input.recoveryContexts.map((context) => ({
        repository: context.repository,
        truncated: context.truncated,
        projectIds: context.projects.map((project) => project.id),
      })),
    });

    // Budget unique remote lookups rather than project-local rows. Shared repositories fan one
    // result out to every owning project without consuming the recovery budget repeatedly.
    const pinsByLookup = new Map<string, ProjectPullRequestPin[]>();
    for (const row of allMissingPins) {
      const context = contextByRepository.get(row.repositoryKey.trim().toLowerCase());
      if (!context) continue;
      const lookupKey = repositoryPullRequestIdentityKey({
        repository: context.repository,
        number: row.number,
      });
      const rows = pinsByLookup.get(lookupKey) ?? [];
      rows.push(row);
      pinsByLookup.set(lookupKey, rows);
    }
    const lookupGroups = [...pinsByLookup.values()];
    for (const row of lookupGroups.slice(PULL_REQUEST_PIN_RECOVERY_LIMIT).flat()) {
      const project = input.projectById.get(row.projectId);
      if (project) {
        addError(
          project,
          row.repositoryKey,
          `Pinned item recovery was limited to ${PULL_REQUEST_PIN_RECOVERY_LIMIT} items. ` +
            "Unpin items you no longer need to recover the rest.",
        );
      }
    }
    const missingPins = lookupGroups.slice(0, PULL_REQUEST_PIN_RECOVERY_LIMIT).flat();

    const numbersByRepository = new Map<string, Set<number>>();
    for (const row of missingPins) {
      const repositoryKey = row.repositoryKey.trim().toLowerCase();
      const numbers = numbersByRepository.get(repositoryKey) ?? new Set<number>();
      numbers.add(row.number);
      numbersByRepository.set(repositoryKey, numbers);
    }

    type RepositoryLookup = {
      readonly results: ReadonlyMap<number, GitHubRepositoryInboxLookup> | null;
      readonly error: GitHubCliError | null;
    };
    const lookups = new Map<string, RepositoryLookup>(
      yield* Effect.forEach(
        numbersByRepository,
        ([repositoryKey, numbers]) => {
          const context = contextByRepository.get(repositoryKey)!;
          return input
            .loadItems(
              context,
              [...numbers].toSorted((a, b) => a - b),
            )
            .pipe(
              Effect.map((results): readonly [string, RepositoryLookup] => [
                repositoryKey,
                { results, error: null },
              ]),
              Effect.catch((error) =>
                input.isGlobalError(error)
                  ? Effect.fail(error)
                  : Effect.succeed<readonly [string, RepositoryLookup]>([
                      repositoryKey,
                      { results: null, error },
                    ]),
              ),
            );
        },
        { concurrency: 3 },
      ),
    );

    const definitivelyMissingPins = missingPins.filter(
      (row) =>
        lookups.get(row.repositoryKey.trim().toLowerCase())?.results?.get(row.number)?._tag ===
        "not-found",
    );
    yield* Effect.forEach(
      definitivelyMissingPins,
      (row) =>
        input.pinStore
          .setPinned({
            projectId: row.projectId,
            repositoryKey: row.repositoryKey,
            number: row.number,
            isPinned: false,
          })
          .pipe(
            Effect.catch((error) => {
              const project = input.projectById.get(row.projectId);
              if (project) {
                addError(
                  project,
                  row.repositoryKey,
                  `Missing pinned item cleanup failed: ${error.message}`,
                );
              }
              return Effect.void;
            }),
          ),
      { concurrency: 3, discard: true },
    );

    const items: GitHubInboxItem[] = [];
    for (const rows of lookupGroups.slice(0, PULL_REQUEST_PIN_RECOVERY_LIMIT)) {
      const first = rows[0]!;
      const repositoryKey = first.repositoryKey.trim().toLowerCase();
      const context = contextByRepository.get(repositoryKey);
      const lookup = lookups.get(repositoryKey);
      if (!context || !lookup) continue;
      if (lookup.error) {
        for (const row of rows) {
          const project = input.projectById.get(row.projectId);
          if (project) {
            addError(
              project,
              context.repository,
              `Pinned #${row.number} could not be recovered: ${input.describeError(lookup.error)}`,
            );
          }
        }
        continue;
      }
      const result = lookup.results?.get(first.number);
      if (result?._tag !== "found") continue;
      // A pin in the other list (for example a merged PR while viewing Open) stays out of this one.
      if ((result.item.item.state === "open" ? "open" : "closed") !== input.state) continue;
      items.push(input.buildItem(context, result));
    }

    return { items, errors: [...errors.values()] };
  });
}
