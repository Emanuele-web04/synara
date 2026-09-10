import { randomUUID } from "node:crypto";

import type {
  ProjectProvisionInput,
  ProjectProvisionPhase,
  ProjectProvisionProgressEvent,
} from "@synara/contracts";
import {
  gitHostCliName,
  gitHostDisplayName,
  remoteUrlMatchesRepository,
  type GitHostKind,
} from "@synara/shared/gitHostRepository";
import { parseGitHubRepositoryInput } from "@synara/shared/githubRepository";
import {
  parseGitLabRepositoryInput,
  parseGitLabRepositoryReference,
} from "@synara/shared/gitlabRepository";
import { normalizeProjectDirectoryName } from "@synara/shared/projectDirectoryName";
import { Effect, FileSystem, Path, PlatformError, Schema, Semaphore } from "effect";

import { GitCommandError, GitHostCliError } from "../git/Errors";
import type { GitCoreShape } from "../git/Services/GitCore";
import type { GitHostCliRouterShape } from "../git/Services/GitHostCli";

const CLONE_TIMEOUT_MS = 30 * 60 * 1_000;
const CLONE_OUTPUT_LIMIT_BYTES = 2 * 1_024 * 1_024;
const MAX_CLONE_PROGRESS_MESSAGE_LENGTH = 240;
function repositoryHttpsUrl(host: GitHostKind, repository: string): string {
  if (host === "github") return `https://github.com/${repository}`;
  const parsed = parseGitLabRepositoryReference(repository);
  return parsed ? `https://${parsed.host}/${parsed.fullPath}` : `https://${repository}`;
}

const CLONE_PROGRESS_LINE =
  /^(?:remote:\s*)?(?:Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files|Filtering content):/i;

export const ProjectProvisioningErrorCode = Schema.Literals([
  "INVALID_REPOSITORY",
  "INVALID_DESTINATION",
  "DESTINATION_CONFLICT",
  "REPOSITORY_NOT_FOUND",
  "AUTH_REQUIRED",
  "NETWORK_ERROR",
  "CLONE_TIMEOUT",
  "PERMISSION_DENIED",
  "DISK_FULL",
  "CLONE_FAILED",
]);
export type ProjectProvisioningErrorCode = typeof ProjectProvisioningErrorCode.Type;

export class ProjectProvisioningError extends Schema.TaggedErrorClass<ProjectProvisioningError>()(
  "ProjectProvisioningError",
  {
    code: ProjectProvisioningErrorCode,
    message: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ProjectProvisioningProgressReporter {
  readonly publish: (event: ProjectProvisionProgressEvent) => Effect.Effect<void, never>;
}

export interface ProjectCheckoutResult {
  readonly operationId: string;
  readonly repository: string;
  readonly workspaceRoot: string;
  readonly checkout: "created" | "reused";
  readonly recoveryPath: string | null;
}

interface ProjectProvisionerDependencies {
  readonly homeDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly git: GitCoreShape;
  readonly gitHost: GitHostCliRouterShape;
}

export interface ProjectProvisioner {
  readonly provisionCheckout: (
    input: ProjectProvisionInput,
    reporter: ProjectProvisioningProgressReporter,
  ) => Effect.Effect<ProjectCheckoutResult, ProjectProvisioningError>;
}

function provisioningError(
  code: ProjectProvisioningErrorCode,
  message: string,
  retryable: boolean,
  cause?: unknown,
): ProjectProvisioningError {
  return new ProjectProvisioningError({
    code,
    message,
    retryable,
    ...(cause === undefined ? {} : { cause }),
  });
}

function safeCloneProgressMessage(rawLine: string): string | null {
  const normalized = rawLine
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!CLONE_PROGRESS_LINE.test(normalized)) return null;
  return normalized.slice(0, MAX_CLONE_PROGRESS_MESSAGE_LENGTH);
}

function createCloneProgressChunkHandler(
  operationId: string,
  reporter: ProjectProvisioningProgressReporter,
): (chunk: string) => void {
  let buffer = "";
  let lastMessage = "";

  return (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/[\r\n]+/);
    buffer = parts.pop() ?? "";
    if (buffer.length > 4_096) buffer = buffer.slice(-4_096);

    for (const part of parts) {
      const message = safeCloneProgressMessage(part);
      if (!message || message === lastMessage) continue;
      lastMessage = message;
      Effect.runFork(
        reporter.publish({
          operationId,
          kind: "clone-progress",
          phase: "cloning",
          message,
        }),
      );
    }
  };
}

function classifyCloneFailure(host: GitHostKind, cause: unknown): ProjectProvisioningError {
  if (cause instanceof ProjectProvisioningError) return cause;
  const hostName = gitHostDisplayName(host);
  const cliName = gitHostCliName(host);

  const detail =
    cause instanceof GitHostCliError || cause instanceof GitCommandError
      ? cause.detail
      : cause instanceof Error
        ? cause.message
        : String(cause);
  const lower = detail.toLowerCase();

  const exceededConfiguredCloneTimeout =
    (cause instanceof GitCommandError &&
      cause.operation === "clone public project" &&
      lower.endsWith(" timed out.")) ||
    (cause instanceof GitHostCliError &&
      lower.includes(`${cliName} repo clone`) &&
      lower.includes(" timed out."));
  if (exceededConfiguredCloneTimeout) {
    return provisioningError(
      "CLONE_TIMEOUT",
      "The repository clone exceeded Synara's 30-minute limit. For very large repositories, clone it manually and add the local folder instead.",
      false,
      cause,
    );
  }

  if (
    lower.includes("repository not found") ||
    lower.includes("could not resolve to a repository") ||
    lower.includes("http 404")
  ) {
    return provisioningError(
      "REPOSITORY_NOT_FOUND",
      `The ${hostName} repository was not found, or the current account cannot access it.`,
      false,
      cause,
    );
  }
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("not authenticated") ||
    lower.includes("bad credentials") ||
    lower.includes("http 401") ||
    lower.includes("http 403") ||
    lower.includes("returned error: 401") ||
    lower.includes("returned error: 403") ||
    lower.includes("401 unauthorized") ||
    lower.includes("403 forbidden")
  ) {
    return provisioningError(
      "AUTH_REQUIRED",
      `${hostName} authentication is required. Sign in with \`${cliName} auth login\` or configure Git credentials, then retry.`,
      false,
      cause,
    );
  }
  if (
    lower.includes("could not resolve host") ||
    lower.includes("failed to connect") ||
    lower.includes("connection timed out") ||
    lower.includes("network is unreachable") ||
    lower.includes("connection reset") ||
    lower.includes("timed out")
  ) {
    return provisioningError(
      "NETWORK_ERROR",
      `Synara could not reach ${hostName}. Check the server's network connection and retry.`,
      true,
      cause,
    );
  }
  if (lower.includes("no space left on device") || lower.includes("disk full")) {
    return provisioningError(
      "DISK_FULL",
      "The repository could not be cloned because the destination disk is full.",
      false,
      cause,
    );
  }
  if (lower.includes("permission denied") || lower.includes("operation not permitted")) {
    return provisioningError(
      "PERMISSION_DENIED",
      "Synara does not have permission to write to the selected destination.",
      false,
      cause,
    );
  }
  return provisioningError(
    "CLONE_FAILED",
    `The ${hostName} repository could not be cloned. Check the repository and Git configuration, then retry.`,
    true,
    cause,
  );
}

function classifyPromotionFailure(cause: unknown): ProjectProvisioningError {
  const reason =
    cause instanceof PlatformError.PlatformError &&
    cause.reason instanceof PlatformError.SystemError
      ? cause.reason._tag
      : null;
  if (reason === "AlreadyExists") {
    return provisioningError(
      "DESTINATION_CONFLICT",
      "The destination appeared while the repository was cloning. Choose another folder name or retry after removing it.",
      false,
      cause,
    );
  }
  if (reason === "PermissionDenied") {
    return provisioningError(
      "PERMISSION_DENIED",
      "Synara does not have permission to move the cloned repository into the selected destination.",
      false,
      cause,
    );
  }
  return provisioningError(
    "CLONE_FAILED",
    "The cloned repository could not be moved into the selected destination. Retry or choose another folder.",
    true,
    cause,
  );
}

function publishPhase(
  reporter: ProjectProvisioningProgressReporter,
  operationId: string,
  phase: ProjectProvisionPhase,
  message: string,
) {
  return reporter.publish({ operationId, kind: "phase", phase, message });
}

export const makeProjectProvisioner = Effect.fn(function* (
  dependencies: ProjectProvisionerDependencies,
): Effect.fn.Return<ProjectProvisioner> {
  const { fileSystem, git, gitHost, homeDir, path } = dependencies;
  const cloneSlots = yield* Semaphore.make(2);
  const lockIndex = yield* Semaphore.make(1);
  const destinationLocks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

  const withDestinationLock = <A, E, R>(destination: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      lockIndex.withPermits(1)(
        Effect.gen(function* () {
          const existing = destinationLocks.get(destination);
          if (existing) {
            existing.users += 1;
            return existing;
          }
          const entry = { lock: yield* Semaphore.make(1), users: 1 };
          destinationLocks.set(destination, entry);
          return entry;
        }),
      ),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        lockIndex.withPermits(1)(
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0 && destinationLocks.get(destination) === entry) {
              destinationLocks.delete(destination);
            }
          }),
        ),
    );

  const verifyCheckout = Effect.fnUntraced(function* (
    workspaceRoot: string,
    expectedRepository: string,
  ) {
    const result = yield* git.execute({
      operation: "verify project clone",
      cwd: workspaceRoot,
      args: ["remote", "get-url", "origin"],
      allowNonZeroExit: true,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1_024,
    });
    if (result.code !== 0) {
      const detail = `${result.stdout}\n${result.stderr}`.trim();
      const lower = detail.toLowerCase();
      if (lower.includes("not a git repository") || lower.includes("no such remote 'origin'")) {
        return false;
      }
      return yield* new GitCommandError({
        operation: "verify project clone",
        command: "git remote get-url origin",
        cwd: workspaceRoot,
        detail: detail || `git exited with code ${result.code}.`,
      });
    }
    return remoteUrlMatchesRepository(result.stdout.trim(), expectedRepository);
  });

  const inspectExistingDestination = Effect.fnUntraced(function* (
    workspaceRoot: string,
    repository: string,
  ) {
    const stat = yield* fileSystem
      .stat(workspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat) return null;
    if (stat.type !== "Directory") {
      return yield* provisioningError(
        "DESTINATION_CONFLICT",
        "The destination already exists and is not a directory. Choose another folder name.",
        false,
      );
    }
    const matches = yield* verifyCheckout(workspaceRoot, repository);
    if (!matches) {
      return yield* provisioningError(
        "DESTINATION_CONFLICT",
        "The destination already contains different files or a different repository. Choose another folder name.",
        false,
      );
    }
    return {
      operationId: "",
      repository,
      workspaceRoot,
      checkout: "reused" as const,
      recoveryPath: null,
    };
  });

  const cloneToStaging = Effect.fnUntraced(function* (
    input: ProjectProvisionInput,
    repository: string,
    parent: string,
    stagingPath: string,
    reporter: ProjectProvisioningProgressReporter,
  ) {
    const publishChunk = createCloneProgressChunkHandler(input.operationId, reporter);
    const selection = yield* gitHost.forRepository(repository);
    const cliReady = yield* selection.cli
      .getViewerLogin({ cwd: parent, host: selection.host })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    const cloneEnv = {
      GCM_INTERACTIVE: "never",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    };
    const httpsUrl = repositoryHttpsUrl(selection.kind, repository);

    if (cliReady) {
      yield* selection.cli.execute({
        cwd: parent,
        args:
          selection.kind === "github"
            ? ["repo", "clone", "--no-upstream", repository, stagingPath, "--", "--progress"]
            : // glab clones by project URL so a self-hosted instance needs no ambient host.
              ["repo", "clone", httpsUrl, stagingPath, "--", "--progress"],
        timeoutMs: CLONE_TIMEOUT_MS,
        maxBufferBytes: CLONE_OUTPUT_LIMIT_BYTES,
        outputMode: "truncate",
        env: cloneEnv,
        onStdoutChunk: publishChunk,
        onStderrChunk: publishChunk,
      });
      return;
    }

    // GitCore.execute owns the spawned process in an Effect Scope. Cancelling the
    // WebSocket request interrupts this Effect, closes that Scope, and terminates
    // the fallback `git clone` process just like runProcess does for the CLI path.
    yield* git.execute({
      operation: "clone public project",
      cwd: parent,
      args: ["clone", "--progress", "--", `${httpsUrl}.git`, stagingPath],
      env: {
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeoutMs: CLONE_TIMEOUT_MS,
      maxOutputBytes: CLONE_OUTPUT_LIMIT_BYTES,
      outputMode: "truncate",
      progress: {
        onStdoutLine: (line) => Effect.sync(() => publishChunk(`${line}\n`)),
        onStderrLine: (line) => Effect.sync(() => publishChunk(`${line}\n`)),
      },
    });
  });

  const provisionCheckout: ProjectProvisioner["provisionCheckout"] = (input, reporter) =>
    Effect.gen(function* () {
      yield* publishPhase(reporter, input.operationId, "validating", "Validating repository");
      const repository =
        input.host === "gitlab"
          ? parseGitLabRepositoryInput(input.repository)
          : parseGitHubRepositoryInput(input.repository);
      if (!repository) {
        return yield* provisioningError(
          "INVALID_REPOSITORY",
          input.host === "gitlab"
            ? "Enter a GitLab project as `group/project`, `host/group/project`, or a GitLab project URL."
            : "Enter a GitHub repository as `owner/repository` or a GitHub.com repository URL.",
          false,
        );
      }

      const directoryName = normalizeProjectDirectoryName(input.directoryName);
      if (!directoryName) {
        return yield* provisioningError(
          "INVALID_DESTINATION",
          "Choose a valid folder name without path separators or reserved characters.",
          false,
        );
      }

      const rawParent = input.destinationParent.trim();
      const expandedParent =
        rawParent === "~"
          ? homeDir
          : rawParent.startsWith("~/") || rawParent.startsWith("~\\")
            ? path.join(homeDir, rawParent.slice(2))
            : rawParent;
      if (!path.isAbsolute(expandedParent)) {
        return yield* provisioningError(
          "INVALID_DESTINATION",
          "Choose an absolute destination folder on the Synara server.",
          false,
        );
      }

      const resolvedParent = path.resolve(expandedParent);
      const parentStat = yield* fileSystem
        .stat(resolvedParent)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!parentStat || parentStat.type !== "Directory") {
        return yield* provisioningError(
          "INVALID_DESTINATION",
          "The destination folder does not exist or is not a directory.",
          false,
        );
      }
      const parent = yield* fileSystem
        .realPath(resolvedParent)
        .pipe(
          Effect.mapError((cause) =>
            provisioningError(
              "INVALID_DESTINATION",
              "The destination folder could not be resolved.",
              false,
              cause,
            ),
          ),
        );
      const workspaceRoot = path.join(parent, directoryName);

      return yield* withDestinationLock(
        workspaceRoot,
        Effect.gen(function* () {
          const existing = yield* inspectExistingDestination(workspaceRoot, repository);
          if (existing) {
            return { ...existing, operationId: input.operationId };
          }

          yield* publishPhase(
            reporter,
            input.operationId,
            "resolving-access",
            `Resolving ${gitHostDisplayName(input.host)} access`,
          );
          const stagingPath = path.join(
            parent,
            `.synara-clone-${process.pid}-${randomUUID().replace(/-/g, "")}`,
          );
          let promoted = false;

          const runClone = Effect.gen(function* () {
            yield* publishPhase(reporter, input.operationId, "cloning", `Cloning ${repository}`);
            yield* cloneSlots.withPermits(1)(
              cloneToStaging(input, repository, parent, stagingPath, reporter),
            );

            yield* publishPhase(reporter, input.operationId, "verifying", "Verifying checkout");
            const valid = yield* verifyCheckout(stagingPath, repository);
            if (!valid) {
              return yield* provisioningError(
                "CLONE_FAILED",
                "The cloned repository's origin does not match the requested repository.",
                false,
              );
            }

            const appearedDuringClone = yield* inspectExistingDestination(
              workspaceRoot,
              repository,
            );
            if (appearedDuringClone) {
              return { ...appearedDuringClone, operationId: input.operationId };
            }

            yield* fileSystem
              .rename(stagingPath, workspaceRoot)
              .pipe(Effect.mapError(classifyPromotionFailure));
            promoted = true;
            return {
              operationId: input.operationId,
              repository,
              workspaceRoot,
              checkout: "created" as const,
              recoveryPath: stagingPath,
            };
          });

          return yield* runClone.pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                promoted
                  ? Effect.void
                  : fileSystem
                      .remove(stagingPath, { recursive: true, force: true })
                      .pipe(Effect.catch(() => Effect.void)),
              ),
            ),
          );
        }),
      );
    }).pipe(Effect.mapError((cause) => classifyCloneFailure(input.host, cause)));

  return { provisionCheckout };
});
