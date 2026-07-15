import type { OrchestrationProject, ProjectId, PullRequestsListResult } from "@synara/contracts";
import { Effect } from "effect";

import type {
  ProjectPullRequestPin,
  ProjectPullRequestPinsShape,
} from "../persistence/Services/ProjectPullRequestPins";
import type { GitHubRepositoryInventory, GitHubRepositoryLink } from "./repositoryResolution";

export type ProjectRepositoryResolution = {
  readonly project: OrchestrationProject;
  readonly error: unknown | null;
  readonly inventory: GitHubRepositoryInventory;
};

export type ProjectRepositoryIndex = {
  readonly errors: PullRequestsListResult["errors"];
  readonly repositoryKeysByProject: ReadonlyMap<ProjectId, Set<string>>;
  readonly uniqueRepositories: ReadonlyMap<
    string,
    { repository: GitHubRepositoryLink; projects: OrchestrationProject[] }
  >;
};

export function resolveProjectRepositoryInventories(input: {
  projects: ReadonlyArray<OrchestrationProject>;
  resolve: (project: OrchestrationProject) => Effect.Effect<GitHubRepositoryInventory, unknown>;
}) {
  return Effect.forEach(
    input.projects,
    (project) =>
      input.resolve(project).pipe(
        Effect.match({
          onFailure: (error): ProjectRepositoryResolution => ({
            project,
            error,
            inventory: { repositories: [], authoritative: false },
          }),
          onSuccess: (inventory): ProjectRepositoryResolution => ({
            project,
            error: null,
            inventory,
          }),
        }),
      ),
    { concurrency: 6 },
  );
}

export function indexProjectRepositoryInventories(
  resolved: ReadonlyArray<ProjectRepositoryResolution>,
): ProjectRepositoryIndex {
  const errors = resolved.flatMap(({ project, error }) =>
    error
      ? [
          {
            projectId: project.id,
            projectTitle: project.title,
            message: error instanceof Error ? error.message : "Repository lookup failed.",
          },
        ]
      : [],
  );
  const uniqueRepositories = new Map<
    string,
    { repository: GitHubRepositoryLink; projects: OrchestrationProject[] }
  >();
  const repositoryKeysByProject = new Map<ProjectId, Set<string>>();

  for (const item of resolved) {
    repositoryKeysByProject.set(
      item.project.id,
      new Set(
        item.inventory.repositories.map((repository) => repository.nameWithOwner.toLowerCase()),
      ),
    );
    for (const repository of item.inventory.repositories) {
      const key = repository.nameWithOwner.toLowerCase();
      const existing = uniqueRepositories.get(key);
      if (existing) {
        if (!existing.projects.some((project) => project.id === item.project.id)) {
          existing.projects.push(item.project);
        }
      } else {
        uniqueRepositories.set(key, { repository, projects: [item.project] });
      }
    }
  }

  return { errors, repositoryKeysByProject, uniqueRepositories };
}

/** Remove pins only when an explicitly authoritative inventory proves ownership ended. */
export function cleanupUnconfiguredPullRequestPins(input: {
  pins: ProjectPullRequestPinsShape;
  pinnedRows: ReadonlyArray<ProjectPullRequestPin>;
  projectById: ReadonlyMap<ProjectId, OrchestrationProject>;
  repositoryKeysByProject: ReadonlyMap<ProjectId, Set<string>>;
  resolved: ReadonlyArray<ProjectRepositoryResolution>;
}) {
  const resolutionByProject = new Map(input.resolved.map((item) => [item.project.id, item]));
  const unconfiguredPins = input.pinnedRows.filter((row) => {
    const resolution = resolutionByProject.get(row.projectId);
    return (
      resolution?.error === null &&
      resolution.inventory.authoritative &&
      input.repositoryKeysByProject.get(row.projectId)?.has(row.repositoryKey.toLowerCase()) !==
        true
    );
  });

  return Effect.forEach(
    unconfiguredPins,
    (row) =>
      input.pins
        .setPinned({
          projectId: row.projectId,
          repositoryKey: row.repositoryKey,
          number: row.number,
          isPinned: false,
        })
        .pipe(
          Effect.map((): PullRequestsListResult["errors"][number] | null => null),
          Effect.catch((error) => {
            const project = input.projectById.get(row.projectId);
            return Effect.succeed(
              project
                ? {
                    projectId: project.id,
                    projectTitle: project.title,
                    message: `Stale pull request pin cleanup failed: ${error.message}`,
                  }
                : null,
            );
          }),
        ),
    { concurrency: 3 },
  ).pipe(Effect.map((errors) => errors.filter((error) => error !== null)));
}
