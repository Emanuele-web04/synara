import type {
  GitHubAccountSelection,
  OrchestrationProject,
  PullRequestDetail,
} from "@synara/contracts";
import { githubAvatarUrlForLogin } from "@synara/shared/githubAvatar";
import { Effect } from "effect";

import type { GitHubCliShape } from "../git/Services/GitHubCli";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import type { PullRequestServiceShape } from "./Services/PullRequestService";

type PullRequestOperations = Pick<
  PullRequestServiceShape,
  "detail" | "diff" | "action" | "comment" | "setPinned"
>;

export function makePullRequestOperations(dependencies: {
  github: GitHubCliShape;
  pins: ProjectPullRequestPinsShape;
  findProject: (
    projectId: Parameters<PullRequestServiceShape["detail"]>[0]["projectId"],
  ) => Effect.Effect<OrchestrationProject, unknown>;
  validateRepository: (repository: string) => Effect.Effect<string, Error>;
  validateProjectRepository: (
    project: OrchestrationProject,
    repository: string,
  ) => Effect.Effect<string, unknown>;
  loadMergeCapabilities: (
    cwd: string,
    repository: string,
    account?: GitHubAccountSelection,
  ) => Effect.Effect<PullRequestDetail["mergeCapabilities"], unknown>;
  withGitHubRead: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  finalizeMutationCaches: (
    repository: string,
    number: number,
    options: { readonly invalidateReviewMatches: boolean },
    account?: GitHubAccountSelection,
  ) => Effect.Effect<void, never>;
}): PullRequestOperations {
  const loadDetail = (project: OrchestrationProject, repositoryInput: string, number: number) =>
    Effect.gen(function* () {
      const repository = yield* dependencies.validateProjectRepository(project, repositoryInput);
      const account = project.githubAccount ?? undefined;
      const [owner = "", repo = ""] = repository.split("/");
      const [detail, mergeCapabilities, reviewCommentsResult] = yield* Effect.all(
        [
          dependencies.withGitHubRead(
            dependencies.github.getPullRequestDetail({
              cwd: project.workspaceRoot,
              repository,
              number,
              ...(account ? { account } : {}),
            }),
          ),
          dependencies.loadMergeCapabilities(project.workspaceRoot, repository, account),
          dependencies
            .withGitHubRead(
              dependencies.github.getPullRequestReviewComments({
                cwd: project.workspaceRoot,
                host: account?.host ?? "github.com",
                owner,
                repo,
                number,
                ...(account ? { account } : {}),
              }),
            )
            .pipe(
              Effect.map((result) => ({ ...result, incomplete: false })),
              Effect.catch(() =>
                Effect.succeed({ comments: [], truncated: false, incomplete: true }),
              ),
            ),
        ],
        { concurrency: 3 },
      );
      const comments = [
        ...detail.comments,
        ...reviewCommentsResult.comments.map((comment) => ({
          id: comment.id,
          kind: "review-comment" as const,
          author: comment.author
            ? {
                login: comment.author,
                name: null,
                avatarUrl: githubAvatarUrlForLogin(comment.author),
                url: null,
              }
            : null,
          body: comment.body,
          createdAt: comment.createdAt ?? detail.updatedAt,
          updatedAt: null,
          url: comment.url,
          path: comment.path,
          reviewState: null,
        })),
      ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
      return {
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        repository,
        ...detail,
        comments,
        commentsTruncated: reviewCommentsResult.truncated,
        commentsIncomplete: reviewCommentsResult.incomplete,
        mergeCapabilities,
      } satisfies PullRequestDetail;
    });

  const detail: PullRequestServiceShape["detail"] = (input) =>
    dependencies
      .findProject(input.projectId)
      .pipe(Effect.flatMap((project) => loadDetail(project, input.repository, input.number)));

  const diff: PullRequestServiceShape["diff"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      const account = project.githubAccount ?? undefined;
      return yield* dependencies.withGitHubRead(
        dependencies.github.getPullRequestDiff({
          cwd: project.workspaceRoot,
          repository,
          number: input.number,
          ...(account ? { account } : {}),
        }),
      );
    });

  const action: PullRequestServiceShape["action"] = (input) =>
    Effect.gen(function* () {
      if (input.action === "merge") {
        return yield* Effect.fail(
          new Error("Merge this pull request on GitHub. Synara does not merge pull requests."),
        );
      }
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      const account = project.githubAccount ?? undefined;
      yield* dependencies.github
        .runPullRequestAction({
          cwd: project.workspaceRoot,
          repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
          ...(account ? { account } : {}),
        })
        .pipe(
          Effect.ensuring(
            dependencies.finalizeMutationCaches(
              repository,
              input.number,
              { invalidateReviewMatches: true },
              account,
            ),
          ),
        );
      return {
        projectId: project.id,
        repository,
        number: input.number,
        workspaceRoot: project.workspaceRoot,
      };
    });

  const comment: PullRequestServiceShape["comment"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      const account = project.githubAccount ?? undefined;
      yield* dependencies.github
        .commentOnPullRequest({
          cwd: project.workspaceRoot,
          repository,
          number: input.number,
          body: input.body,
          ...(account ? { account } : {}),
        })
        .pipe(
          Effect.ensuring(
            dependencies.finalizeMutationCaches(
              repository,
              input.number,
              { invalidateReviewMatches: false },
              account,
            ),
          ),
        );
      return {
        projectId: project.id,
        repository,
        number: input.number,
        workspaceRoot: project.workspaceRoot,
      };
    });

  const setPinned: PullRequestServiceShape["setPinned"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      // Clearing an orphaned pin intentionally requires only a valid canonical repository key.
      const repository = yield* input.isPinned
        ? dependencies.validateProjectRepository(project, input.repository)
        : dependencies.validateRepository(input.repository);
      yield* dependencies.pins.setPinned({
        projectId: project.id,
        repositoryKey: repository.toLowerCase(),
        number: input.number,
        isPinned: input.isPinned,
      });
      return {
        projectId: project.id,
        repository,
        number: input.number,
        isPinned: input.isPinned,
      };
    });

  return { detail, diff, action, comment, setPinned };
}
