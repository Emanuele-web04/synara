import fs from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Layer, PlatformError, Scope, Stream } from "effect";
import { afterAll, describe, expect, vi } from "vitest";
import os from "node:os";
import * as betaOperationalIssue from "../../betaOperationalIssue";
import * as processRunner from "../../processRunner";
import { GitHubCliLive } from "./GitHubCli";
import { ServerSettingsError, WsRpcError, type GitActionProgressEvent } from "@synara/contracts";
import { makeGitActionRunner } from "../gitActionRunner";
import type {
  GitPullRequestCheck,
  GitPullRequestComment,
  ModelSelection,
  ProviderStartOptions,
} from "@synara/contracts";

import { GitCommandError, GitHubCliError, TextGenerationError } from "../Errors.ts";
import { type GitManagerShape } from "../Services/GitManager.ts";
import {
  GitHubCli,
  type GitHubCliShape,
  PULL_REQUEST_SUMMARY_JSON_FIELDS,
} from "../Services/GitHubCli.ts";
import {
  type AutomationIntentGenerationInput,
  type AutomationIntentGenerationResult,
  type AutomationCompletionEvaluationInput,
  type AutomationCompletionEvaluationResult,
  type TextGenerationShape,
  TextGeneration,
  type ThreadRecapGenerationInput,
  type ProjectDigestGenerationInput,
  type ProjectDigestGenerationResult,
} from "../Services/TextGeneration.ts";
import { GitCoreLive } from "./GitCore.ts";
import { GitCore } from "../Services/GitCore.ts";
import { createGitHubCliWithFakeGh, type FakeGhScenario } from "../testing/fakeGitHubCli.ts";
import { makeGitManager } from "./GitManager.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PULL_REQUEST_ATTRIBUTION_FOOTER } from "../gitAttribution.ts";

interface FakeGitTextGeneration {
  generateCommitMessage: (input: {
    cwd: string;
    branch: string | null;
    stagedSummary: string;
    stagedPatch: string;
    codexHomePath?: string;
    providerOptions?: ProviderStartOptions;
    includeBranch?: boolean;
    model?: string;
    modelSelection?: ModelSelection;
  }) => Effect.Effect<
    { subject: string; body: string; branch?: string | undefined },
    TextGenerationError
  >;
  generatePrContent: (input: {
    cwd: string;
    baseBranch: string;
    headBranch: string;
    commitSummary: string;
    diffSummary: string;
    diffPatch: string;
    prTemplate?: string | undefined;
    codexHomePath?: string;
    providerOptions?: ProviderStartOptions;
    model?: string;
    modelSelection?: ModelSelection;
  }) => Effect.Effect<{ title: string; body: string }, TextGenerationError>;
  generateDiffSummary: (input: {
    cwd: string;
    patch: string;
    codexHomePath?: string;
    providerOptions?: ProviderStartOptions;
    model?: string;
    modelSelection?: ModelSelection;
  }) => Effect.Effect<{ summary: string }, TextGenerationError>;
  generateBranchName: (input: {
    cwd: string;
    message: string;
    providerOptions?: ProviderStartOptions;
    model?: string;
    modelSelection?: ModelSelection;
  }) => Effect.Effect<{ branch: string }, TextGenerationError>;
  generateThreadTitle: (input: {
    cwd: string;
    message: string;
    providerOptions?: ProviderStartOptions;
    model?: string;
    modelSelection?: ModelSelection;
  }) => Effect.Effect<{ title: string }, TextGenerationError>;
  generateThreadRecap: (
    input: ThreadRecapGenerationInput,
  ) => Effect.Effect<{ recap: string }, TextGenerationError>;
  generateProjectDigest: (
    input: ProjectDigestGenerationInput,
  ) => Effect.Effect<ProjectDigestGenerationResult, TextGenerationError>;
  generateAutomationIntent: (
    input: AutomationIntentGenerationInput,
  ) => Effect.Effect<AutomationIntentGenerationResult, TextGenerationError>;
  evaluateAutomationCompletion: (
    input: AutomationCompletionEvaluationInput,
  ) => Effect.Effect<AutomationCompletionEvaluationResult, TextGenerationError>;
}

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  { readonly code: number; readonly stdout: string; readonly stderr: string },
  GitCommandError,
  GitCore
> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    return yield* gitCore.execute({
      operation: "GitManager.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
  });
}

// Built once per file through git, then cloned: a fresh repo costs six git spawns.
let initialRepoTemplate: string | undefined;
afterAll(() => {
  if (initialRepoTemplate) fs.rmSync(initialRepoTemplate, { recursive: true, force: true });
  initialRepoTemplate = undefined;
});

function initRepo(
  cwd: string,
): Effect.Effect<
  void,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    if (initialRepoTemplate) {
      fs.cpSync(initialRepoTemplate, cwd, { recursive: true });
      // Copied files carry new inode/ctime values; settle the index stat cache.
      yield* runGit(cwd, ["update-index", "--refresh"]);
      return;
    }
    const fs_ = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    yield* fs_.writeFileString(path.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
    const template = fs.mkdtempSync(path.join(os.tmpdir(), "git-manager-template-"));
    fs.cpSync(cwd, template, { recursive: true });
    initialRepoTemplate = template;
  });
}

/** A `gh pr` JSON entry for a pull request in the sample repository, based on main. */
const prEntry = <T extends Record<string, unknown> = Record<never, never>>(
  number: number,
  title: string,
  headRefName: string,
  extra: T = {} as T,
) => ({
  number,
  title,
  url: `https://github.com/example-org/sample-repo/pull/${number}`,
  baseRefName: "main",
  headRefName,
  ...extra,
});

/** The normalized pull request summary GitManager reports for `prEntry` fixtures without extras. */
const expectedPrSummary = (number: number, title: string, headBranch: string, state: string) => ({
  number,
  title,
  url: `https://github.com/example-org/sample-repo/pull/${number}`,
  baseBranch: "main",
  headBranch,
  state,
  isDraft: false,
  mergeability: "unknown",
  additions: null,
  deletions: null,
  changedFiles: null,
});

/** Trimmed stdout of a git command run through GitCore. */
const gitOut = (cwd: string, args: readonly string[]) =>
  runGit(cwd, args).pipe(Effect.map((result) => result.stdout.trim()));

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("synara-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

function createTextGeneration(overrides: Partial<FakeGitTextGeneration> = {}): TextGenerationShape {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
        ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
      }),
    generatePrContent: () =>
      Effect.succeed({
        title: "Add stacked git actions",
        body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
      }),
    generateDiffSummary: () =>
      Effect.succeed({
        summary: "## Summary\n- Explain the selected diff\n\n## Files Changed\n- Not run",
      }),
    generateBranchName: () =>
      Effect.succeed({
        branch: "update-workflow",
      }),
    generateThreadTitle: () =>
      Effect.succeed({
        title: "Update workflow",
      }),
    generateThreadRecap: () =>
      Effect.succeed({
        recap: "Update workflow recap",
      }),
    generateProjectDigest: () =>
      Effect.succeed({
        summary: "Update workflow digest",
        focusItems: [] as ProjectDigestGenerationResult["focusItems"],
      }),
    generateAutomationIntent: () =>
      Effect.succeed({
        isAutomation: true,
        confidence: 1,
        language: null,
        name: "Check site",
        taskPrompt: "Check the site",
        schedule: { type: "interval", everySeconds: 3600 },
        mode: "heartbeat",
        completionPolicy: { type: "none" },
        missingFields: [],
        needsConfirmation: false,
        reason: null,
      }),
    evaluateAutomationCompletion: () =>
      Effect.succeed({
        stopMatched: false,
        confidence: 0.2,
        reason: "Stop condition was not met.",
      }),
    ...overrides,
  };

  const wrapped = Object.fromEntries(
    (Object.keys(implementation) as Array<keyof FakeGitTextGeneration>).map((operation) => [
      operation,
      (input: never) =>
        (implementation[operation] as (input: never) => Effect.Effect<unknown, unknown>)(
          input,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "fake text generation failed",
                ...(cause !== undefined ? { cause } : {}),
              }),
          ),
        ),
    ]),
  );
  // Git actions never request composer predictions.
  return {
    ...wrapped,
    generateComposerPrediction: () => Effect.succeed({ suggestion: null }),
  } as unknown as TextGenerationShape;
}

function runStackedAction(
  manager: GitManagerShape,
  input: {
    cwd: string;
    action: "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
    prTitle?: string;
    prBody?: string;
    prDraft?: boolean;
    allowDirtyWorkingTree?: boolean;
  },
  options?: Parameters<GitManagerShape["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

function resolvePullRequest(manager: GitManagerShape, input: { cwd: string; reference: string }) {
  return manager.resolvePullRequest(input);
}

function preparePullRequestThread(
  manager: GitManagerShape,
  input: { cwd: string; reference: string; mode: "local" | "worktree" },
) {
  return manager.preparePullRequestThread(input);
}

function handoffThread(
  manager: GitManagerShape,
  input: {
    cwd: string;
    targetMode: "local" | "worktree";
    currentBranch: string | null;
    worktreePath: string | null;
    associatedWorktreePath: string | null;
    associatedWorktreeBranch: string | null;
    associatedWorktreeRef: string | null;
    preferredLocalBranch: string | null;
    preferredWorktreeBaseBranch: string | null;
    preferredNewWorktreeName: string | null;
  },
) {
  return manager.handoffThread(input);
}

function makeManager(input?: {
  ghScenario?: FakeGhScenario;
  github?: GitHubCliShape;
  textGeneration?: Partial<FakeGitTextGeneration>;
  settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  settingsLayer?: Layer.Layer<ServerSettingsService, ServerSettingsError>;
}) {
  const {
    service: gitHubCli,
    ghCalls,
    createdPrBodies,
  } = createGitHubCliWithFakeGh(input?.ghScenario);
  const textGeneration = createTextGeneration(input?.textGeneration);
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-git-manager-test-",
  });

  const gitCoreLayer = GitCoreLive.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerConfigLayer),
  );

  const managerLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, input?.github ?? gitHubCli),
    Layer.succeed(TextGeneration, textGeneration),
    input?.settingsLayer ?? ServerSettingsService.layerTest(input?.settings),
    gitCoreLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

  return makeGitManager.pipe(
    Effect.provide(managerLayer),
    Effect.map((manager) => ({ manager, ghCalls, createdPrBodies })),
  );
}

const GitManagerTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "synara-git-manager-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("commits and pushes selected files beyond status and argument capture limits", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-many-files-");
      yield* initRepo(repoDir);
      const remote = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remote]);
      const filePaths = Array.from(
        { length: 6_000 },
        (_, index) => `${index}-${"file".repeat(48)}.txt`,
      );
      yield* Effect.sync(() => {
        for (const file of filePaths) fs.writeFileSync(path.join(repoDir, file), "content\n");
        fs.writeFileSync(path.join(repoDir, "excluded.txt"), "keep untracked\n");
      });
      const { manager } = yield* makeManager();
      const status = yield* manager.status({ cwd: repoDir });
      expect(status.hasWorkingTreeChanges).toBe(true);
      expect(status.workingTree.files).toHaveLength(6_001);
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        commitMessage: "Add selected files",
        filePaths,
      });
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      const localTree = yield* gitOut(repoDir, ["rev-parse", "HEAD^{tree}"]);
      const branch = yield* gitOut(repoDir, ["branch", "--show-current"]);
      expect(yield* gitOut(remote, ["rev-parse", `${branch}^{tree}`])).toBe(localTree);
      expect(yield* gitOut(repoDir, ["status", "--porcelain"])).toBe("?? excluded.txt");
      const committedCount = (yield* runGit(repoDir, ["diff", "--shortstat", "HEAD~", "HEAD"]))
        .stdout;
      expect(committedCount).toContain("6000 files changed");
    }),
  );

  it.effect("routes file-scoped working-tree diffs and rejects other scopes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-file-diff-");
      yield* initRepo(repoDir);
      yield* Effect.sync(() => {
        fs.writeFileSync(path.join(repoDir, "selected.txt"), "selected\n");
        fs.writeFileSync(path.join(repoDir, "other.txt"), "other\n");
      });
      const { manager } = yield* makeManager();
      const { patch } = yield* manager.readWorkingTreeDiff({
        cwd: repoDir,
        scope: "workingTree",
        filePath: "selected.txt",
      });
      expect(patch).toContain("selected.txt");
      expect(patch).not.toContain("other.txt");
      for (const scope of ["staged", "unstaged", "branch", "ref"] as const) {
        const exit = yield* manager
          .readWorkingTreeDiff({
            cwd: repoDir,
            scope,
            filePath: "selected.txt",
            compareRef: "HEAD",
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(exit.cause)).toContain("only supported for the working tree");
      }
      expect(
        Exit.isFailure(
          yield* manager
            .readWorkingTreeDiffStats({
              cwd: repoDir,
              scope: "workingTree",
              filePath: "selected.txt",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
    }),
  );

  it.effect("refuses to summarize a working-tree patch whose capture was truncated", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-truncated-summary-");
      yield* initRepo(repoDir);
      yield* Effect.sync(() => {
        fs.writeFileSync(path.join(repoDir, "oversized.txt"), "generated line\n".repeat(100_000));
      });
      let generationCalls = 0;
      const { manager } = yield* makeManager({
        textGeneration: {
          generateDiffSummary: () => {
            generationCalls += 1;
            return Effect.succeed({ summary: "## Summary\n- Partial input" });
          },
        },
      });

      const captured = yield* manager.readWorkingTreeDiff({
        cwd: repoDir,
        scope: "workingTree",
      });
      expect(captured.truncated).toBe(true);

      const result = yield* Effect.result(
        manager.summarizeDiff({ cwd: repoDir, scope: "workingTree" }),
      );

      expect(result._tag).toBe("Failure");
      expect(generationCalls).toBe(0);
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "GitManagerError",
          operation: "summarizeDiff",
        });
        expect(result.failure.message).toContain("truncated diff");
      }
    }),
  );

  it.effect("status includes PR metadata when branch already has an open PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-open-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              prEntry(13, "Existing PR", "feature/status-open-pr", {
                isDraft: true,
                mergeable: "CONFLICTING",
                additions: 38,
                deletions: 36,
                changedFiles: 3,
              }),
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-open-pr");
      expect(status.pr).toEqual({
        number: 13,
        title: "Existing PR",
        url: "https://github.com/example-org/sample-repo/pull/13",
        baseBranch: "main",
        headBranch: "feature/status-open-pr",
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        additions: 38,
        deletions: 36,
        changedFiles: 3,
      });
    }),
  );

  it.effect("status exposes the configured PR merge base", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/configured-pr-base"]);
      yield* runGit(repoDir, [
        "config",
        "branch.feature/configured-pr-base.gh-merge-base",
        "release",
      ]);

      const { manager } = yield* makeManager();
      const status = yield* manager.status({ cwd: repoDir });

      expect(status.configuredPrBaseBranch).toBe("release");
    }),
  );

  it.effect("resolves a captured branch PR after the checkout has moved elsewhere", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/captured-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/captured-pr"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            "feature/captured-pr": JSON.stringify([
              prEntry(574, "Captured branch PR", "feature/captured-pr", { state: "OPEN" }),
            ]),
          },
        },
      });

      const resolved = yield* manager.pullRequestForBranch({
        cwd: repoDir,
        branch: "feature/captured-pr",
        upstreamRef: "origin/feature/captured-pr",
      });

      expect(resolved).toMatchObject({ number: 574, headBranch: "feature/captured-pr" });
      expect(ghCalls.some((call) => call.includes("pr list --head feature/captured-pr"))).toBe(
        true,
      );
    }),
  );

  it.effect(
    "status detects cross-repo PRs from the upstream remote URL owner",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        fs.writeFileSync(path.join(repoDir, "fork-pr.txt"), "fork pr\n");
        yield* runGit(repoDir, ["add", "fork-pr.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "synara/pr-488/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* runGit(repoDir, [
          "config",
          "remote.fork-seed.url",
          "git@github.com:jasonLaster/sample-repo.git",
        ]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              JSON.stringify([]),
              JSON.stringify([]),
              JSON.stringify([
                prEntry(488, "Rebase this PR on latest main", "statemachine", {
                  state: "OPEN",
                  updatedAt: "2026-03-10T07:00:00Z",
                }),
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("synara/pr-488/statemachine");
        expect(status.pr).toEqual(
          expectedPrSummary(488, "Rebase this PR on latest main", "statemachine", "open"),
        );
        expect(ghCalls).toContain(
          "pr list --head jasonLaster:statemachine --state all --limit 20 --json number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,mergeable,additions,deletions,changedFiles,isCrossRepository,headRepository,headRepositoryOwner,updatedAt",
        );
      }),
    30_000,
  );

  it.effect("status returns merged PR state when latest PR was merged", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-merged-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              prEntry(22, "Merged PR", "feature/status-merged-pr", {
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              }),
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-merged-pr");
      expect(status.pr).toEqual(
        expectedPrSummary(22, "Merged PR", "feature/status-merged-pr", "merged"),
      );
    }),
  );

  it.effect("status prefers open PR when merged PR has newer updatedAt", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-over-merged"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              prEntry(45, "Merged PR", "feature/status-open-over-merged", {
                state: "MERGED",
                mergedAt: "2026-01-31T10:00:00Z",
                updatedAt: "2026-02-01T10:00:00Z",
              }),
              prEntry(46, "Open PR", "feature/status-open-over-merged", {
                state: "OPEN",
                updatedAt: "2026-01-30T10:00:00Z",
              }),
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-open-over-merged");
      expect(status.pr).toEqual(
        expectedPrSummary(46, "Open PR", "feature/status-open-over-merged", "open"),
      );
    }),
  );

  it.effect("status is resilient to gh lookup failures and returns pr null", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-no-gh"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-no-gh"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCliError({
            operation: "execute",
            detail: "GitHub CLI (`gh`) is required but not available on PATH.",
          }),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-no-gh");
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nworld\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(yield* gitOut(repoDir, ["log", "-1", "--pretty=%s"])).toBe(
        "Implement stacked git actions",
      );
    }),
  );

  it.effect("creates feature branch, commits, and pushes with featureBranch option", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nfeature-branch\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "Implement stacked git actions",
                body: "",
                ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        featureBranch: true,
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/implement-stacked-git-actions");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(yield* gitOut(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
        "feature/implement-stacked-git-actions",
      );

      const mainSha = yield* gitOut(repoDir, ["rev-parse", "main"]);
      const mergeBase = yield* gitOut(repoDir, ["merge-base", "main", "HEAD"]);
      expect(mergeBase).toBe(mainSha);
      expect(generatedCount).toBe(1);
    }),
  );

  it.effect("falls back to a derived feature branch when text generation fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nfeature-fallback\n");

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateCommitMessage",
                detail: "Codex CLI command failed: skills loader failed",
              }),
            ),
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        featureBranch: true,
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/update-readme-md");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("Update README.md");
      expect(result.push.status).toBe("pushed");
      expect(yield* gitOut(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
        "feature/update-readme-md",
      );
    }),
  );

  it.effect("featureBranch uses custom commit message and derives branch name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom-feature\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "unused",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/feat-custom-summary-line");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);
      expect(yield* gitOut(repoDir, ["log", "-1", "--pretty=%b"])).toContain("- details from user");

      const mainSha = yield* gitOut(repoDir, ["rev-parse", "main"]);
      const mergeBase = yield* gitOut(repoDir, ["merge-base", "main", result.branch.name!]);
      expect(mergeBase).toBe(mainSha);
    }),
  );

  it.effect(
    "creates feature branch, pushes, and opens PR for already-committed work",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        const originalMainSha = yield* gitOut(repoDir, ["rev-parse", "main"]);
        fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncreate-pr-from-default\n");
        yield* runGit(repoDir, ["add", "README.md"]);
        yield* runGit(repoDir, ["commit", "-m", "Create PR from default branch"]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              "[]",
              "[]",
              "[]",
              JSON.stringify([
                prEntry(
                  90,
                  "Create PR from default branch",
                  "feature/create-pr-from-default-branch",
                ),
              ]),
            ],
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "create_pr",
          featureBranch: true,
        });

        expect(result.branch.status).toBe("created");
        expect(result.branch.name).toBe("feature/create-pr-from-default-branch");
        expect(result.commit.status).toBe("skipped_not_requested");
        expect(result.push.status).toBe("pushed");
        expect(result.pr.status).toBe("created");
        expect(yield* gitOut(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/create-pr-from-default-branch",
        );
        expect(
          ghCalls.some((call) =>
            call.includes("pr create --base main --head feature/create-pr-from-default-branch"),
          ),
        ).toBe(true);
        expect(yield* gitOut(repoDir, ["rev-parse", "main"])).toBe(originalMainSha);
      }),
    30_000,
  );

  it.effect(
    "restores the original branch from a matching remote branch when upstream is unset",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        const originalMainSha = yield* gitOut(repoDir, ["rev-parse", "main"]);
        yield* runGit(repoDir, ["branch", "--unset-upstream", "main"]);
        fs.writeFileSync(path.join(repoDir, "README.md"), "hello\npush-no-upstream\n");
        yield* runGit(repoDir, ["add", "README.md"]);
        yield* runGit(repoDir, ["commit", "-m", "Push from default branch without upstream"]);

        const { manager } = yield* makeManager();
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "push",
          featureBranch: true,
        });

        expect(result.branch.status).toBe("created");
        expect(result.branch.name).toBe("feature/push-from-default-branch-without-upstream");
        expect(result.push.status).toBe("pushed");
        expect(yield* gitOut(repoDir, ["rev-parse", "main"])).toBe(originalMainSha);
      }),
    30_000,
  );

  it.effect(
    "blocks feature-branch push when the source branch has no upstream and multiple remotes",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["push", "fork", "main"]);
        yield* runGit(repoDir, ["branch", "--unset-upstream", "main"]);
        fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nmulti-remote-block\n");
        yield* runGit(repoDir, ["add", "README.md"]);
        yield* runGit(repoDir, ["commit", "-m", "Push from default branch with multiple remotes"]);

        const { manager } = yield* makeManager();
        const errorMessage = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "push",
          featureBranch: true,
        }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );

        expect(errorMessage).toContain("has no upstream and this repository has multiple remotes");
      }),
    30_000,
  );

  it.effect("featureBranch returns error when worktree is clean", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("no changes to commit");
    }),
  );

  it.effect(
    "pushes and creates PR from a no-upstream branch when local commits are ahead of base",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/no-upstream-pr"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              "[]",
              "[]",
              "[]",
              JSON.stringify([prEntry(77, "Add no-upstream PR flow", "feature/no-upstream-pr")]),
            ],
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.branch.status).toBe("skipped_not_requested");
        expect(result.commit.status).toBe("created");
        expect(result.push.status).toBe("pushed");
        expect(result.push.setUpstream).toBe(true);
        expect(result.pr.status).toBe("created");
        expect(yield* gitOut(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/no-upstream-pr",
        );
        expect(
          ghCalls.some((call) =>
            call.includes("pr create --base main --head feature/no-upstream-pr"),
          ),
        ).toBe(true);
      }),
  );

  it.effect("skips push when branch is already up to date", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/up-to-date"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/up-to-date"]);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("skipped_no_changes");
      expect(result.push.status).toBe("skipped_up_to_date");
    }),
  );

  it.effect(
    "pushes clean local commits without running the commit step",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/push-only"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "push-only.txt"), "push only\n");
        yield* runGit(repoDir, ["add", "push-only.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Push only commit"]);

        const { manager } = yield* makeManager();
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "push",
        });

        expect(result.commit.status).toBe("skipped_not_requested");
        expect(result.push.status).toBe("pushed");
        expect(result.push.setUpstream).toBe(true);
        expect(yield* gitOut(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/push-only",
        );
      }),
    30_000,
  );

  it.effect(
    "creates PR from a clean branch and pushes first when upstream is missing",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/create-pr-only"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "create-pr.txt"), "create pr\n");
        yield* runGit(repoDir, ["add", "create-pr.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Create PR only"]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              "[]",
              "[]",
              "[]",
              JSON.stringify([prEntry(89, "Create PR only", "feature/create-pr-only")]),
            ],
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "create_pr",
        });

        expect(result.commit.status).toBe("skipped_not_requested");
        expect(result.push.status).toBe("pushed");
        expect(result.push.setUpstream).toBe(true);
        expect(result.pr.status).toBe("created");
        expect(
          ghCalls.some((call) =>
            call.includes("pr create --base main --head feature/create-pr-only"),
          ),
        ).toBe(true);
      }),
    30_000,
  );

  it.effect(
    "uses provided PR title, body, and draft flag without generating content",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/custom-pr-content"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "custom-pr.txt"), "custom pr\n");
        yield* runGit(repoDir, ["add", "custom-pr.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Custom PR content"]);

        let generateCalls = 0;
        const { manager, ghCalls } = yield* makeManager({
          textGeneration: {
            generatePrContent: () => {
              generateCalls += 1;
              return Effect.succeed({ title: "Generated title", body: "Generated body" });
            },
          },
          ghScenario: {
            prListSequence: [
              "[]",
              "[]",
              "[]",
              JSON.stringify([prEntry(91, "Custom PR title", "feature/custom-pr-content")]),
            ],
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "create_pr",
          prTitle: "Custom PR title",
          prBody: "Custom PR body.",
          prDraft: true,
        });

        expect(result.pr.status).toBe("created");
        expect(result.pr.title).toBe("Custom PR title");
        expect(generateCalls).toBe(0);
        const createCall = ghCalls.find((call) => call.startsWith("pr create "));
        expect(createCall).toContain(
          "pr create --base main --head feature/custom-pr-content --title Custom PR title",
        );
        expect(createCall).toContain("--draft");
      }),
    30_000,
  );

  it.effect(
    "rejects create_pr with uncommitted changes unless the caller opts out of the guard",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/dirty-create-pr"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "committed.txt"), "committed\n");
        yield* runGit(repoDir, ["add", "committed.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Committed work"]);
        fs.writeFileSync(path.join(repoDir, "uncommitted.txt"), "left out\n");

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              "[]",
              "[]",
              "[]",
              JSON.stringify([prEntry(92, "Committed work", "feature/dirty-create-pr")]),
            ],
          },
        });
        const guardedError = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "create_pr",
        }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
        expect(guardedError).toContain("Commit local changes before creating a PR.");
        expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(false);

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "create_pr",
          allowDirtyWorkingTree: true,
        });

        expect(result.commit.status).toBe("skipped_not_requested");
        expect(result.push.status).toBe("pushed");
        expect(result.pr.status).toBe("created");
        const status = yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
          Effect.map((gitResult) => gitResult.stdout),
        );
        expect(status).toContain("uncommitted.txt");
      }),
    30_000,
  );

  it.effect(
    "rejects push with uncommitted changes unless the caller opts out of the guard",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/dirty-push"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "committed.txt"), "committed\n");
        yield* runGit(repoDir, ["add", "committed.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Committed work"]);
        fs.writeFileSync(path.join(repoDir, "uncommitted.txt"), "left out\n");

        const { manager } = yield* makeManager();
        const guardedError = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "push",
        }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
        expect(guardedError).toContain("Commit or stash local changes before pushing.");

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "push",
          allowDirtyWorkingTree: true,
        });

        expect(result.commit.status).toBe("skipped_not_requested");
        expect(result.push.status).toBe("pushed");
        const status = yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
          Effect.map((gitResult) => gitResult.stdout),
        );
        expect(status).toContain("uncommitted.txt");
      }),
    30_000,
  );

  it.effect("rejects PR creation when base and head resolve to the same branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      fs.writeFileSync(path.join(repoDir, "self-pr.txt"), "same branch\n");
      yield* runGit(repoDir, ["add", "self-pr.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Attempt self PR"]);

      const { manager, ghCalls } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "create_pr",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("Cannot create a pull request from 'main' into itself");
      expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(false);
    }),
  );

  it.effect("allows cross-repo PR creation when head and base branch names match", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      fs.mkdirSync(path.join(repoDir, ".github"));
      fs.writeFileSync(
        path.join(repoDir, ".github", "pull_request_template.md"),
        "target repository template",
      );
      yield* runGit(repoDir, ["add", ".github/pull_request_template.md"]);
      yield* runGit(repoDir, ["commit", "-m", "Add target PR template"]);
      yield* runGit(repoDir, ["push", "origin", "main"]);
      yield* runGit(repoDir, ["push", "-u", "fork", "main"]);
      fs.writeFileSync(
        path.join(repoDir, ".github", "pull_request_template.md"),
        "fork-only template",
      );
      yield* runGit(repoDir, ["add", ".github/pull_request_template.md"]);
      yield* runGit(repoDir, ["commit", "-m", "Change template in fork"]);
      yield* runGit(repoDir, ["push", "fork", "main"]);
      yield* runGit(repoDir, [
        "config",
        "remote.origin.url",
        "git@github.com:example-org/sample-repo.git",
      ]);
      yield* runGit(repoDir, ["config", "remote.origin.pushurl", originDir]);
      yield* runGit(repoDir, [
        "config",
        "remote.fork.url",
        "git@github.com:octocat/sample-repo.git",
      ]);
      yield* runGit(repoDir, ["config", "remote.fork.pushurl", forkDir]);
      fs.writeFileSync(path.join(repoDir, "cross-repo-pr.txt"), "fork main change\n");
      yield* runGit(repoDir, ["add", "cross-repo-pr.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Cross repo main PR"]);
      let generatedPrTemplate: string | undefined;

      const { manager, ghCalls } = yield* makeManager({
        textGeneration: {
          generatePrContent: (input) => {
            generatedPrTemplate = input.prTemplate;
            return Effect.succeed({
              title: "Cross-repository change",
              body: "Target template body",
            });
          },
        },
        ghScenario: {
          prListByHeadSelector: {
            "octocat:main": "[]",
            "fork:main": "[]",
            main: "[]",
          },
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "create_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(
        ghCalls.some((call) => call.includes("pr create --base main --head octocat:main")),
      ).toBe(true);
      expect(generatedPrTemplate).toBe("target repository template");
    }),
  );

  it.effect(
    "uses a supplied PR title to publish unstaged changes from main without text generation",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        const mainHead = yield* gitOut(repoDir, ["rev-parse", "main"]);
        fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nupdated\n");
        const { manager } = yield* makeManager({
          textGeneration: {
            generateCommitMessage: () => Effect.die("Unnecessary commit generation"),
            generatePrContent: () => Effect.die("Unnecessary PR generation"),
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
          featureBranch: true,
          prTitle: "Update readme",
          prBody: "Document the change.",
        });

        expect(result.pr.status).toBe("created");
        expect(result.commit.subject).toBe("Update readme");
        expect(result.branch.name).toBe("feature/update-readme");
        expect(yield* gitOut(repoDir, ["status", "--porcelain"])).toBe("");
        expect(yield* gitOut(repoDir, ["rev-parse", "main"])).toBe(mainHead);
        expect((yield* runGit(remoteDir, ["show", "feature/update-readme:README.md"])).stdout).toBe(
          "hello\nupdated\n",
        );
      }),
  );

  it.effect("returns existing PR metadata for commit/push/pr action", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/existing-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/existing-pr"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [JSON.stringify([prEntry(42, "Existing PR", "feature/existing-pr")])],
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("opened_existing");
      expect(result.pr.number).toBe(42);
      expect(ghCalls.some((call) => call.startsWith("pr view "))).toBe(false);
    }),
  );

  it.effect("ignores mismatched cross-repo PR candidates before reusing an existing PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/collision"]);
      const originDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/collision"]);
      yield* runGit(repoDir, [
        "config",
        "remote.origin.url",
        "git@github.com:example-org/sample-repo.git",
      ]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            "feature/collision": JSON.stringify([
              {
                number: 201,
                title: "Wrong repo PR",
                url: "https://github.com/someone-else/sample-repo/pull/201",
                baseRefName: "main",
                headRefName: "feature/collision",
                isCrossRepository: true,
                headRepository: {
                  nameWithOwner: "someone-else/sample-repo",
                },
                headRepositoryOwner: {
                  login: "someone-else",
                },
              },
            ]),
            "origin:feature/collision": JSON.stringify([
              {
                number: 202,
                title: "Correct repo PR",
                url: "https://github.com/example-org/sample-repo/pull/202",
                baseRefName: "main",
                headRefName: "feature/collision",
                isCrossRepository: false,
                headRepository: {
                  nameWithOwner: "example-org/sample-repo",
                },
                headRepositoryOwner: {
                  login: "example-org",
                },
              },
            ]),
          },
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "create_pr",
      });

      expect(result.pr.status).toBe("opened_existing");
      expect(result.pr.number).toBe(202);
      expect(ghCalls.some((call) => call.includes("pr list --head feature/collision"))).toBe(true);
      expect(ghCalls.some((call) => call.includes("pr list --head origin:feature/collision"))).toBe(
        true,
      );
      expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(false);
    }),
  );

  it.effect(
    "stops probing head selectors after finding an existing PR",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "synara/pr-142/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* runGit(repoDir, [
          "config",
          "remote.fork-seed.url",
          "git@github.com:octocat/sample-repo.git",
        ]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              "octocat:statemachine": JSON.stringify([
                prEntry(142, "Existing fork PR", "statemachine"),
              ]),
              "fork-seed:statemachine": JSON.stringify([]),
              "synara/pr-142/statemachine": JSON.stringify([]),
              statemachine: JSON.stringify([]),
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);

        const prListCalls = ghCalls.filter((call) => call.startsWith("pr list "));
        expect(prListCalls).toHaveLength(1);
        expect(prListCalls[0]).toContain(
          "pr list --head octocat:statemachine --state open --limit 1",
        );
      }),
    30_000,
  );

  it.effect("creates PR when one does not already exist", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      fs.mkdirSync(path.join(repoDir, ".github"));
      fs.writeFileSync(
        path.join(repoDir, ".github", "pull_request_template.md"),
        "## What changed?\n\n## Verification",
      );
      yield* runGit(repoDir, ["add", ".github/pull_request_template.md"]);
      yield* runGit(repoDir, ["commit", "-m", "Add pull request template"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature-create-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "origin", "main"]);
      yield* runGit(repoDir, ["branch", "-f", "main", "HEAD^"]);
      fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
      yield* runGit(repoDir, ["add", "changes.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature-create-pr"]);
      yield* runGit(repoDir, ["config", "branch.feature-create-pr.gh-merge-base", "main"]);
      let generatedPrTemplate: string | undefined;

      const { manager, ghCalls } = yield* makeManager({
        textGeneration: {
          generatePrContent: (input) => {
            generatedPrTemplate = input.prTemplate;
            return Effect.succeed({
              title: "Add stacked git actions",
              body: "## What changed?\nAdded stacked git actions.",
            });
          },
        },
        ghScenario: {
          prListSequence: [
            "[]",
            "[]",
            "[]",
            JSON.stringify([prEntry(88, "Add stacked git actions", "feature-create-pr")]),
          ],
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("created");
      expect(result.pr.number).toBe(88);
      expect(generatedPrTemplate).toBe("## What changed?\n\n## Verification");
      expect(
        ghCalls.some((call) => call.includes("pr create --base main --head feature-create-pr")),
      ).toBe(true);
      expect(ghCalls.some((call) => call.startsWith("pr view "))).toBe(false);
    }),
  );

  it.effect("opens existing PR when create reports a duplicate branch PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/already-created"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
      yield* runGit(repoDir, ["add", "changes.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/already-created"]);
      yield* runGit(repoDir, ["config", "branch.feature/already-created.gh-merge-base", "main"]);

      const existingPrUrl = "https://github.com/example-org/sample-repo/pull/82";
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: ["[]"],
          createPullRequestError: new GitHubCliError({
            operation: "execute",
            detail: `GitHub CLI command failed: gh pr create failed (code=1, signal=null). a pull request for branch "feature/already-created" into branch "main" already exists: ${existingPrUrl}`,
          }),
          pullRequest: {
            number: 82,
            title: "Already created PR",
            url: existingPrUrl,
            baseRefName: "main",
            headRefName: "feature/already-created",
            state: "open",
          },
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.pr.status).toBe("opened_existing");
      expect(result.pr.number).toBe(82);
      expect(ghCalls.some((call) => call.includes("pr create --base main"))).toBe(true);
      expect(ghCalls.some((call) => call.startsWith(`pr view ${existingPrUrl}`))).toBe(true);
    }),
  );

  it.effect("uses the local base template when a cross-repo origin ref is absent", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      fs.mkdirSync(path.join(repoDir, ".github"));
      fs.writeFileSync(
        path.join(repoDir, ".github", "pull_request_template.md"),
        "local base template",
      );
      yield* runGit(repoDir, ["add", ".github/pull_request_template.md"]);
      yield* runGit(repoDir, ["commit", "-m", "Add local base template"]);
      yield* runGit(repoDir, [
        "remote",
        "add",
        "origin",
        "git@github.com:example-org/sample-repo.git",
      ]);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
      fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
      yield* runGit(repoDir, ["add", "changes.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
      yield* runGit(repoDir, ["checkout", "-b", "synara/pr-91/statemachine"]);
      yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
      yield* runGit(repoDir, [
        "config",
        "remote.fork-seed.url",
        "git@github.com:octocat/sample-repo.git",
      ]);
      let generatedPrTemplate: string | undefined;

      const { manager, ghCalls } = yield* makeManager({
        textGeneration: {
          generatePrContent: (input) => {
            generatedPrTemplate = input.prTemplate;
            return Effect.succeed({
              title: "Add stacked git actions",
              body: "Local base template body",
            });
          },
        },
        ghScenario: {
          prListSequence: [
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify([prEntry(188, "Add stacked git actions", "statemachine")]),
          ],
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(result.pr.number).toBe(188);
      expect(
        ghCalls.some((call) => call.includes("pr create --base main --head octocat:statemachine")),
      ).toBe(true);
      expect(
        ghCalls.some((call) =>
          call.includes("pr create --base statemachine --head octocat:statemachine"),
        ),
      ).toBe(false);
      expect(generatedPrTemplate).toBe("local base template");
    }),
  );

  it.effect("rejects push/pr actions from detached HEAD", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "--detach", "HEAD"]);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
      expect(errorMessage).toContain("detached HEAD");
    }),
  );

  it.effect("surfaces missing gh binary errors", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/gh-missing"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/gh-missing"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCliError({
            operation: "execute",
            detail: "GitHub CLI (`gh`) is required but not available on PATH.",
          }),
        },
      });

      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
      expect(errorMessage).toContain("GitHub CLI (`gh`) is required");
    }),
  );

  it.effect("keeps direct PR resolution available during a polling pause", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli;
      const runProcessSpy = vi
        .spyOn(processRunner, "runProcess")
        .mockImplementation(async (_command, args) => {
          if (args[0] === "api") throw new Error("gh: API rate limit exceeded (HTTP 403)");
          return {
            stdout: JSON.stringify({
              number: 42,
              title: "Agent association",
              url: "https://github.com/acme/app/pull/42",
              baseRefName: "main",
              headRefName: "feature",
              state: "OPEN",
            }),
            stderr: "",
            code: 0,
            signal: null,
            timedOut: false,
          };
        });
      yield* Effect.addFinalizer(() => Effect.sync(() => runProcessSpy.mockRestore()));
      const { manager } = yield* makeManager({ github: gh });
      yield* gh.execute({ cwd: "/agent-association", args: ["api", "user"] }).pipe(Effect.flip);
      const result = yield* manager.resolvePullRequest({
        cwd: "/agent-association",
        reference: "#42",
      });
      expect(result.pullRequest.number).toBe(42);
      const poll = yield* manager
        .resolvePullRequest({ cwd: "/agent-association", reference: "#43" }, { background: true })
        .pipe(Effect.result);
      expect(poll._tag).toBe("Failure");
      expect(runProcessSpy).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(GitHubCliLive)),
  );

  it.effect("resolves pull requests from #number references", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: prEntry(42, "Resolve PR", "feature/resolve-pr", { state: "open" }),
        },
      });

      const result = yield* resolvePullRequest(manager, {
        cwd: repoDir,
        reference: "#42",
      });

      expect(result.pullRequest).toEqual(
        expectedPrSummary(42, "Resolve PR", "feature/resolve-pr", "open"),
      );
      expect(ghCalls.some((call) => call.startsWith("pr view 42 "))).toBe(true);
    }),
  );

  it.effect("loads PR snapshots with checks and review comments", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);

      const checks: GitPullRequestCheck[] = [
        { name: "Format, Lint, Typecheck", status: "pending", url: null },
        { name: "Release Smoke", status: "success", url: "https://ci.example/2" },
      ];
      const comments: GitPullRequestComment[] = [
        {
          id: "11",
          author: "codex-bot",
          body: "Avoid returning shims directly",
          path: "CursorAcpCommand.ts",
          url: "https://github.com/example-org/sample-repo/pull/42#discussion_r11",
          createdAt: "2026-07-01T10:00:00Z",
        },
      ];

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 42,
            title: "Snapshot PR",
            url: "https://github.enterprise.test/example-org/sample-repo/pull/42",
            baseRefName: "main",
            headRefName: "feature/snapshot-pr",
            state: "open",
          },
          pullRequestChecks: checks,
          pullRequestReviewComments: comments,
          pullRequestReviewCommentsTruncated: true,
        },
      });

      const result = yield* manager.pullRequestSnapshot({
        cwd: repoDir,
        reference: "#42",
      });

      expect(result.pullRequest.number).toBe(42);
      expect(result.checks).toEqual(checks);
      expect(result.comments).toEqual(comments);
      expect(result.commentsTruncated).toBe(true);
      expect(result.commentsError).toBeNull();
      expect(ghCalls).toContain(
        `pr view 42 --json ${PULL_REQUEST_SUMMARY_JSON_FIELDS},headRefOid,statusCheckRollup`,
      );
      // Owner/repo come from the PR URL, not the local checkout's remotes.
      expect(ghCalls).toContain(
        "api graphql reviewThreads github.enterprise.test/example-org/sample-repo#42",
      );
    }),
  );

  it.effect("keeps checks when PR review comments cannot be loaded", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);

      const checks: GitPullRequestCheck[] = [
        { name: "Format, Lint, Typecheck", status: "success", url: "https://ci.example/1" },
      ];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: prEntry(43, "Checks still visible", "feature/checks-still-visible", {
            state: "open",
          }),
          pullRequestChecks: checks,
          reviewCommentsError: new GitHubCliError({
            operation: "getPullRequestReviewComments",
            detail: "GraphQL rate limit exceeded.",
          }),
        },
      });

      const result = yield* manager.pullRequestSnapshot({
        cwd: repoDir,
        reference: "#43",
      });

      expect(result.checks).toEqual(checks);
      expect(result.comments).toEqual([]);
      expect(result.commentsTruncated).toBe(false);
      expect(result.commentsError).toContain("GraphQL rate limit exceeded");
    }),
  );

  it.effect("fails PR snapshots when the repository cannot be derived from the URL", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 7,
            title: "Odd URL",
            url: "https://example.test/not-a-pr",
            baseRefName: "main",
            headRefName: "feature/odd-url",
            state: "open",
          },
        },
      });

      const errorMessage = yield* manager
        .pullRequestSnapshot({ cwd: repoDir, reference: "#7" })
        .pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      expect(errorMessage).toContain("Could not determine the repository");
    }),
  );

  it.effect("prepares pull request threads in local mode by checking out the PR branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local"]);
      fs.writeFileSync(path.join(repoDir, "local.txt"), "local\n");
      yield* runGit(repoDir, ["add", "local.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local PR branch"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: prEntry(64, "Local PR", "feature/pr-local", { state: "open" }),
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "#64",
        mode: "local",
      });

      expect(result.branch).toBe("feature/pr-local");
      expect(result.worktreePath).toBeNull();
      const branch = yield* gitOut(repoDir, ["branch", "--show-current"]);
      expect(branch).toBe("feature/pr-local");
      expect(ghCalls).toContain("pr checkout 64 --force");
    }),
  );

  it.effect("prepares pull request threads in worktree mode on the PR head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-worktree"]);
      fs.writeFileSync(path.join(repoDir, "worktree.txt"), "worktree\n");
      yield* runGit(repoDir, ["add", "worktree.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR worktree branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-worktree"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/77/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: prEntry(77, "Worktree PR", "feature/pr-worktree", { state: "open" }),
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "77",
        mode: "worktree",
      });

      expect(result.branch).toBe("feature/pr-worktree");
      expect(result.worktreePath).not.toBeNull();
      expect(fs.existsSync(result.worktreePath as string)).toBe(true);
      const worktreeBranch = yield* gitOut(result.worktreePath as string, [
        "branch",
        "--show-current",
      ]);
      expect(worktreeBranch).toBe("feature/pr-worktree");
    }),
  );

  it.effect("preserves fork upstream tracking when preparing a worktree PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-fork"]);
      fs.writeFileSync(path.join(repoDir, "fork.txt"), "fork\n");
      yield* runGit(repoDir, ["add", "fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 81,
            title: "Fork PR",
            url: "https://github.com/example-org/sample-repo/pull/81",
            baseRefName: "main",
            headRefName: "feature/pr-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/sample-repo",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/sample-repo": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "81",
        mode: "worktree",
      });

      expect(result.worktreePath).not.toBeNull();
      const upstreamRef = yield* gitOut(result.worktreePath as string, [
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      ]);
      expect(upstreamRef).toBe("fork-seed/feature/pr-fork");
      expect(upstreamRef.startsWith("origin/")).toBe(false);
      expect(
        yield* gitOut(result.worktreePath as string, ["config", "--get", "remote.fork-seed.url"]),
      ).toBe(forkDir);
    }),
  );

  it.effect("derives fork repository identity from PR URL when GitHub omits nameWithOwner", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "binbandit-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "fix/git-action-default-without-origin"]);
      fs.writeFileSync(path.join(repoDir, "derived-fork.txt"), "derived fork\n");
      yield* runGit(repoDir, ["add", "derived-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Derived fork PR branch"]);
      yield* runGit(repoDir, [
        "push",
        "-u",
        "binbandit-seed",
        "fix/git-action-default-without-origin",
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "fix/git-action-default-without-origin"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 642,
            title: "fix: use commit as the default git action without origin",
            url: "https://github.com/example-org/synara/pull/642",
            baseRefName: "main",
            headRefName: "fix/git-action-default-without-origin",
            state: "open",
            isCrossRepository: true,
            headRepositoryOwnerLogin: "binbandit",
          },
          repositoryCloneUrls: {
            "binbandit/synara": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "642",
        mode: "local",
      });

      expect(result.branch).toBe("fix/git-action-default-without-origin");
      expect(result.worktreePath).toBeNull();
      expect(yield* gitOut(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
        "binbandit-seed/fix/git-action-default-without-origin",
      );
    }),
  );

  for (const mode of ["local", "worktree"] as const) {
    it.effect(`reuses an existing dedicated PR worktree in ${mode} mode`, () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-existing-worktree"]);
        fs.writeFileSync(path.join(repoDir, "existing.txt"), "existing\n");
        yield* runGit(repoDir, ["add", "existing.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Existing worktree branch"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const worktreePath = path.join(repoDir, "..", `pr-existing-${Date.now()}`);
        yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-existing-worktree"]);
        fs.writeFileSync(path.join(worktreePath, "existing.txt"), "unsent changes\n");
        const mainHead = yield* gitOut(repoDir, ["rev-parse", "HEAD"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: prEntry(78, "Existing worktree PR", "feature/pr-existing-worktree", {
              state: "open",
            }),
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "78",
          mode,
        });

        expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
          fs.realpathSync.native(worktreePath),
        );
        expect(result.branch).toBe("feature/pr-existing-worktree");
        expect(yield* gitOut(repoDir, ["branch", "--show-current"])).toBe("main");
        expect(yield* gitOut(repoDir, ["rev-parse", "HEAD"])).toBe(mainHead);
        expect(fs.readFileSync(path.join(worktreePath, "existing.txt"), "utf8")).toBe(
          "unsent changes\n",
        );
      }),
    );
  }

  it.effect(
    "does not block fork PR worktree prep when the fork head branch collides with root main",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "fork-main-source"]);
        fs.writeFileSync(path.join(repoDir, "fork-main.txt"), "fork main\n");
        yield* runGit(repoDir, ["add", "fork-main.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork main branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-source:main"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const mainBefore = yield* gitOut(repoDir, ["rev-parse", "main"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 91,
              title: "Fork main PR",
              url: "https://github.com/example-org/sample-repo/pull/91",
              baseRefName: "main",
              headRefName: "main",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/sample-repo",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/sample-repo": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "worktree",
        });

        expect(result.branch).toBe("synara/pr-91/main");
        expect(result.worktreePath).not.toBeNull();
        expect(yield* gitOut(repoDir, ["branch", "--show-current"])).toBe("main");
        expect(yield* gitOut(repoDir, ["rev-parse", "main"])).toBe(mainBefore);
        expect(yield* gitOut(result.worktreePath as string, ["branch", "--show-current"])).toBe(
          "synara/pr-91/main",
        );
      }),
  );

  it.effect(
    "does not overwrite an existing local main branch when preparing a fork PR worktree",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "fork-main-source"]);
        fs.writeFileSync(path.join(repoDir, "fork-main-second.txt"), "fork main second\n");
        yield* runGit(repoDir, ["add", "fork-main-second.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork main second branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-source:main"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const localMainBefore = yield* gitOut(repoDir, ["rev-parse", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/root-branch"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 92,
              title: "Fork main overwrite PR",
              url: "https://github.com/example-org/sample-repo/pull/92",
              baseRefName: "main",
              headRefName: "main",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/sample-repo",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/sample-repo": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "92",
          mode: "worktree",
        });

        expect(result.branch).toBe("synara/pr-92/main");
        expect(yield* gitOut(repoDir, ["rev-parse", "main"])).toBe(localMainBefore);
        expect(
          yield* gitOut(result.worktreePath as string, [
            "rev-parse",
            "--abbrev-ref",
            "@{upstream}",
          ]),
        ).toBe("fork-seed/main");
      }),
  );

  it.effect("reuses an existing PR worktree and restores fork upstream tracking", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-fork"]);
      fs.writeFileSync(path.join(repoDir, "reused-fork.txt"), "reused fork\n");
      yield* runGit(repoDir, ["add", "reused-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-reused-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-reused-fork-${Date.now()}`);
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-reused-fork"]);
      yield* runGit(worktreePath, ["branch", "--unset-upstream"], true);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 83,
            title: "Reused Fork PR",
            url: "https://github.com/example-org/sample-repo/pull/83",
            baseRefName: "main",
            headRefName: "feature/pr-reused-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/sample-repo",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/sample-repo": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "83",
        mode: "worktree",
      });

      expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
        fs.realpathSync.native(worktreePath),
      );
      expect(yield* gitOut(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
        "fork-seed/feature/pr-reused-fork",
      );
    }),
  );

  it.effect("does not reuse a different fork's worktree when preparing a local PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/shared-name"]);
      yield* runGit(repoDir, [
        "remote",
        "add",
        "other-fork",
        "https://github.com/other/sample-repo.git",
      ]);
      yield* runGit(repoDir, ["config", "branch.feature/shared-name.remote", "other-fork"]);
      yield* runGit(repoDir, [
        "remote",
        "add",
        "octocat",
        "https://github.com/octocat/sample-repo.git",
      ]);
      yield* runGit(repoDir, ["update-ref", "refs/remotes/octocat/feature/shared-name", "HEAD"]);
      yield* runGit(repoDir, [
        "config",
        "branch.feature/shared-name.merge",
        "refs/heads/feature/shared-name",
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "collision-worktree");
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/shared-name"]);
      fs.writeFileSync(path.join(worktreePath, "README.md"), "unsent other-fork work\n");
      const worktreeHead = yield* gitOut(worktreePath, ["rev-parse", "HEAD"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 84,
            title: "Different fork PR",
            url: "https://github.com/example-org/sample-repo/pull/84",
            baseRefName: "main",
            headRefName: "feature/shared-name",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/sample-repo",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/sample-repo": {
              url: "https://github.com/octocat/sample-repo.git",
              sshUrl: "git@github.com:octocat/sample-repo.git",
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "84",
        mode: "local",
      }).pipe(Effect.exit);

      expect(
        yield* gitOut(worktreePath, ["config", "--get", "branch.feature/shared-name.remote"]),
      ).toBe("other-fork");
      expect(Exit.isFailure(result)).toBe(true);
      expect(String(Exit.isFailure(result) ? result.cause : "")).toContain(
        "different GitHub repository",
      );
      expect(ghCalls.some((call) => call.startsWith("pr checkout"))).toBe(false);
      expect(yield* gitOut(repoDir, ["branch", "--show-current"])).toBe("main");
      expect(yield* gitOut(worktreePath, ["rev-parse", "HEAD"])).toBe(worktreeHead);
      expect(fs.readFileSync(path.join(worktreePath, "README.md"), "utf8")).toBe(
        "unsent other-fork work\n",
      );
    }),
  );

  it.effect("rejects worktree prep when the PR head branch is checked out in the main repo", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-root-only"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: prEntry(79, "Root-only PR", "feature/pr-root-only", { state: "open" }),
        },
      });

      const errorMessage = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "79",
        mode: "worktree",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("already checked out in the main repo");
    }),
  );

  it.effect("creates a new handoff worktree on a named branch instead of detached HEAD", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const result = yield* handoffThread(manager, {
        cwd: repoDir,
        targetMode: "worktree",
        currentBranch: "main",
        worktreePath: null,
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
        preferredLocalBranch: "main",
        preferredWorktreeBaseBranch: "main",
        preferredNewWorktreeName: "worktree/demo-handoff",
      });

      expect(result.targetMode).toBe("worktree");
      expect(result.branch).toBe("worktree/demo-handoff");
      expect(result.associatedWorktreeBranch).toBe("worktree/demo-handoff");

      const worktreeBranch = yield* gitOut(result.worktreePath as string, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      expect(worktreeBranch).toBe("worktree/demo-handoff");

      const localBranch = yield* gitOut(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      expect(localBranch).toBe("main");
    }),
  );

  it.effect(
    "carries uncommitted local changes into a new handoff worktree without leaking the stash",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-manager-");
        yield* initRepo(repoDir);

        // Create uncommitted working-tree changes so handoffThread takes the stash path.
        // This is the path that previously failed with:
        //   "<sha>" is not a stash reference
        // because git rev-parse refs/stash returns a commit SHA, but `git stash pop`
        // requires a `stash@{N}` reference.
        const workingFile = path.join(repoDir, "uncommitted.txt");
        fs.writeFileSync(workingFile, "draft change\n");

        const { manager } = yield* makeManager();
        const result = yield* handoffThread(manager, {
          cwd: repoDir,
          targetMode: "worktree",
          currentBranch: "main",
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          preferredLocalBranch: "main",
          preferredWorktreeBaseBranch: "main",
          preferredNewWorktreeName: "worktree/stash-handoff",
        });

        expect(result.targetMode).toBe("worktree");
        expect(result.changesTransferred).toBe(true);
        expect(result.conflictsDetected).toBe(false);

        // The uncommitted change should now live inside the new worktree.
        const transferredPath = path.join(result.worktreePath as string, "uncommitted.txt");
        expect(fs.existsSync(transferredPath)).toBe(true);
        expect(fs.readFileSync(transferredPath, "utf8")).toBe("draft change\n");

        // The original local checkout should be clean again.
        expect(fs.existsSync(workingFile)).toBe(false);

        // The stash entry must have been dropped after a successful apply — otherwise
        // we would leak `stash@{0}` on every handoff that carries uncommitted work.
        const stashList = yield* gitOut(repoDir, ["stash", "list"]);
        expect(stashList).toBe("");
      }),
  );

  it.effect(
    "finishes a real push after its observer disconnects without repeating the commit",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-reconnect-");
        yield* initRepo(repoDir);
        const remote = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remote]);
        fs.writeFileSync(path.join(repoDir, "reconnect.txt"), "survives disconnect\n");
        fs.writeFileSync(
          path.join(repoDir, ".git", "hooks", "pre-push"),
          "#!/bin/sh\ntouch .git/push-started\nwhile [ ! -f .git/release-push ]; do sleep 0.05; done\n",
          { mode: 0o755 },
        );
        const { manager } = yield* makeManager();
        let runs = 0;
        const observe = yield* makeGitActionRunner((input, publish) => {
          runs++;
          return manager
            .runStackedAction(input, {
              actionId: input.actionId,
              progressReporter: { publish },
            })
            .pipe(Effect.mapError((error) => new WsRpcError({ message: error.message })));
        });
        const input = {
          actionId: "one-commit-one-push",
          recoverable: true,
          cwd: repoDir,
          action: "commit_push" as const,
          commitMessage: "Survive reconnect",
        };
        const first = yield* observe(input).pipe(Stream.runDrain, Effect.forkChild);
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 5000;
          while (!fs.existsSync(path.join(repoDir, ".git", "push-started"))) {
            if (Date.now() > deadline) throw new Error("Push hook did not start");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        });
        yield* Fiber.interrupt(first);
        fs.writeFileSync(path.join(repoDir, ".git", "release-push"), "ready");
        const events = yield* observe({ ...input, resume: true }).pipe(Stream.runCollect);
        expect(events.at(-1)).toMatchObject({
          kind: "action_finished",
          result: { commit: { status: "created" }, push: { status: "pushed" } },
        });
        const replay = yield* observe({ ...input, resume: true }).pipe(Stream.runCollect);
        expect(replay).toEqual([events.at(-1)]);
        expect(runs).toBe(1);
        expect((yield* runGit(remote, ["rev-parse", "refs/heads/main"])).stdout).toBe(
          (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout,
        );
        expect(yield* gitOut(repoDir, ["rev-list", "--count", "HEAD"])).toBe("2");
      }),
  );

  it.effect("emits ordered progress events for commit hooks", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "hooked.txt"), "hooked\n");
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        '#!/bin/sh\necho "hook: start" >&2\nsleep 1\necho "hook: end" >&2\n',
        { mode: 0o755 },
      );

      const { manager } = yield* makeManager();
      const events: GitActionProgressEvent[] = [];

      const result = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "commit",
        },
        {
          actionId: "action-1",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      );

      expect(result.commit.status).toBe("created");
      expect(events.map((event) => event.kind)).toContain("action_started");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "phase_started",
            phase: "commit",
          }),
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: start",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: end",
          }),
          expect.objectContaining({
            kind: "hook_finished",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "action_finished",
          }),
        ]),
      );
    }),
  );

  it.effect("emits action_failed when a commit hook rejects", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("synara-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "hook-failure.txt"), "broken\n");
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        '#!/bin/sh\necho "hook: fail" >&2\nexit 1\n',
        { mode: 0o755 },
      );

      const { manager } = yield* makeManager();
      const issueReport = vi
        .spyOn(betaOperationalIssue, "reportBetaOperationalIssue")
        .mockImplementation(() => {});
      yield* Effect.addFinalizer(() => Effect.sync(() => issueReport.mockRestore()));
      const events: GitActionProgressEvent[] = [];

      const errorMessage = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "commit",
        },
        {
          actionId: "action-2",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      ).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("hook: fail");
      expect(issueReport).toHaveBeenCalledExactlyOnceWith({
        code: "git.commit.failed",
        reason: "unknown",
        durationMs: expect.any(Number),
      });
      expect(JSON.stringify(issueReport.mock.calls)).not.toContain("hook: fail");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "action_failed",
            phase: "commit",
          }),
        ]),
      );
    }),
  );

  describe("Synara attribution", () => {
    const GENERATED_PR_BODY = "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run";

    /** Runs commit_push_pr on a fresh feature branch and returns the commit message and PR body. */
    const runCommitPushPr = (input: {
      branch: string;
      settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
      settingsLayer?: Layer.Layer<ServerSettingsService, ServerSettingsError>;
      prBody?: string;
    }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-attribution-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", input.branch]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "attributed.txt"), "attributed\n");
        const { manager, createdPrBodies } = yield* makeManager({
          ...(input.settings ? { settings: input.settings } : {}),
          ...(input.settingsLayer ? { settingsLayer: input.settingsLayer } : {}),
          ghScenario: {
            prListSequence: [
              "[]",
              "[]",
              "[]",
              JSON.stringify([prEntry(77, "Add stacked git actions", input.branch)]),
            ],
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
          ...(input.prBody ? { prBody: input.prBody } : {}),
        });
        expect(result.commit.status).toBe("created");
        expect(result.pr.status).toBe("created");
        expect(createdPrBodies).toHaveLength(1);
        return {
          result,
          commitMessage: yield* gitOut(repoDir, ["log", "-1", "--pretty=%B"]),
          prBody: createdPrBodies[0]!,
        };
      });

    it.effect(
      "ends a new PR description with the footer by default and leaves the commit alone",
      () =>
        Effect.gen(function* () {
          const { result, commitMessage, prBody } = yield* runCommitPushPr({
            branch: "feature/attribution-default",
          });
          expect(prBody).toBe(`${GENERATED_PR_BODY}\n\n${PULL_REQUEST_ATTRIBUTION_FOOTER}`);
          expect(result.pr.title).toBe("Add stacked git actions");
          expect(commitMessage).toBe("Implement stacked git actions");
        }),
    );

    it.effect("adds no footer when the setting is off", () =>
      Effect.gen(function* () {
        const { prBody } = yield* runCommitPushPr({
          branch: "feature/attribution-setting-off",
          settings: { gitAttributionEnabled: false },
        });
        expect(prBody).toBe(GENERATED_PR_BODY);
      }),
    );

    it.effect("treats an unreadable setting as off without failing the action", () =>
      Effect.gen(function* () {
        const failingSettingsLayer = Layer.effect(
          ServerSettingsService,
          Effect.gen(function* () {
            const base = yield* ServerSettingsService;
            return {
              ...base,
              getSettings: Effect.fail(
                new ServerSettingsError({ settingsPath: "<memory>", detail: "unreadable" }),
              ),
            };
          }),
        ).pipe(Layer.provide(ServerSettingsService.layerTest()));
        const { prBody } = yield* runCommitPushPr({
          branch: "feature/attribution-unreadable",
          settingsLayer: failingSettingsLayer,
        });
        expect(prBody).toBe(GENERATED_PR_BODY);
      }),
    );

    it.effect("does not duplicate a footer the user already wrote", () =>
      Effect.gen(function* () {
        const userBody = `Hand-written description.\n\n${PULL_REQUEST_ATTRIBUTION_FOOTER}`;
        const { prBody } = yield* runCommitPushPr({
          branch: "feature/attribution-user-text",
          prBody: userBody,
        });
        expect(prBody).toBe(userBody);
      }),
    );

    it.effect("returns an already-open PR without creating or editing one", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("synara-git-attribution-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/attribution-existing"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/attribution-existing"]);
        const { manager, ghCalls, createdPrBodies } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              JSON.stringify([prEntry(43, "Existing PR", "feature/attribution-existing")]),
            ],
          },
        });

        const result = yield* runStackedAction(manager, { cwd: repoDir, action: "create_pr" });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(43);
        expect(createdPrBodies).toHaveLength(0);
        expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(false);
        expect(ghCalls.some((call) => call.startsWith("pr edit "))).toBe(false);
      }),
    );
  });
});
