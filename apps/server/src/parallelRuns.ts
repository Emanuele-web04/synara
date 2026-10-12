import * as path from "node:path";
import { canonicalizeJson } from "./orchestration/commandFingerprint";
import { autoRuntimeModeSelectionIssue } from "@synara/shared/runtimeMode";
import { createHash } from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationStartParallelRunInput,
} from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { Effect, Option } from "effect";
import type { GitCoreShape } from "./git/Services/GitCore";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";

/** Stage every isolated attempt before admitting any provider work. Stable ids make
 * retries settle the original commands rather than launching another batch. */
export function startParallelRun(
  input: OrchestrationStartParallelRunInput,
  deps: {
    git: GitCoreShape;
    query: ProjectionSnapshotQueryShape;
    dispatch: (
      command: Extract<
        ClientOrchestrationCommand,
        { type: "thread.create" | "thread.turn.start" | "thread.meta.update" }
      >,
    ) => Effect.Effect<unknown, unknown>;
  },
) {
  return Effect.gen(function* () {
    if (input.attempts.length < 2 || input.attempts.length > 3)
      return yield* Effect.fail(new Error("Choose two or three attempts."));
    const sourceOption = yield* deps.query.getThreadShellById(input.sourceThreadId);
    if (Option.isNone(sourceOption) || sourceOption.value.archivedAt)
      return yield* Effect.fail(new Error("The source thread must be active."));
    const source = sourceOption.value;
    const projectOption = yield* deps.query.getProjectShellById(source.projectId);
    if (Option.isNone(projectOption) || (projectOption.value.kind ?? "project") !== "project")
      return yield* Effect.fail(new Error("Parallel runs require a code project."));
    const cwd = resolveThreadWorkspaceCwd({
      ...source,
      projectCwd: projectOption.value.workspaceRoot,
    });
    if (!cwd) return yield* Effect.fail(new Error("The source has no repository workspace."));
    const requestHash = createHash("sha256")
      .update(JSON.stringify(canonicalizeJson(input)))
      .digest("hex");
    const threadIds = input.attempts.map((_, index) =>
      ThreadId.makeUnsafe(`parallel-${input.runId}-${index}`),
    );
    const baseCommit = yield* deps.git.withMutation(
      cwd,
      Effect.gen(function* () {
        const existing = yield* deps.query.getThreadShellsByIds(threadIds);
        for (const thread of existing) {
          const group = thread.parallelRun;
          if (
            !group ||
            group.runId !== input.runId ||
            group.requestHash !== requestHash ||
            group.count !== input.attempts.length ||
            thread.sourceThreadId !== input.sourceThreadId ||
            JSON.stringify(canonicalizeJson(thread.modelSelection)) !==
              JSON.stringify(canonicalizeJson(input.attempts[group.index])) ||
            thread.archivedAt
          )
            return yield* Effect.fail(
              new Error("This run id is already bound to another request or an archived attempt."),
            );
        }
        const base =
          existing[0]?.parallelRun?.baseCommit ??
          (yield* deps.git.execute({
            cwd,
            operation: "ParallelRuns.base",
            args: ["rev-parse", "HEAD"],
            timeoutMs: 5_000,
          })).stdout.trim();
        if (!/^[a-f0-9]{40,64}$/u.test(base))
          return yield* Effect.fail(new Error("Cannot resolve the common base commit."));
        // Persist the canonical batch before any Git mutation. A reload can
        // recover even a crash between the first worktree and its association.
        for (const [index, selection] of input.attempts.entries()) {
          if (existing.some((thread) => thread.id === threadIds[index])) continue;
          if (yield* deps.query.threadIdExistsIncludingDeleted(threadIds[index]!))
            return yield* Effect.fail(
              new Error("A previous attempt was deleted. Start a new run."),
            );
          const branch = `synara/parallel/${input.runId}/${index + 1}`;
          const createdAt = input.createdAt;
          yield* deps.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`parallel:${input.runId}:create:${index}`),
            threadId: threadIds[index]!,
            projectId: source.projectId,
            title: `${input.prompt.slice(0, 72)} · Attempt ${index + 1}`,
            modelSelection: selection,
            runtimeMode: autoRuntimeModeSelectionIssue({
              runtimeMode: input.runtimeMode,
              modelSelection: selection,
            })
              ? "approval-required"
              : input.runtimeMode,
            interactionMode: input.interactionMode,
            envMode: "worktree",
            branch,
            worktreePath: null,
            sourceThreadId: input.sourceThreadId,
            parallelRun: {
              request: input,
              runId: input.runId,
              index,
              count: input.attempts.length,
              baseCommit: base,
              requestHash,
            },
            createdAt,
          });
        }
        const stagedPlaceholders = yield* deps.query.getThreadShellsByIds(threadIds);
        const repositoryRoot = (yield* deps.git.execute({
          cwd,
          operation: "ParallelRuns.root",
          args: ["rev-parse", "--show-toplevel"],
          timeoutMs: 5_000,
        })).stdout.trim();
        const relativeCwd = path.relative(repositoryRoot, cwd);
        if (
          path.isAbsolute(relativeCwd) ||
          relativeCwd === ".." ||
          relativeCwd.startsWith(`..${path.sep}`)
        )
          return yield* Effect.fail(new Error("The source directory is outside its repository."));
        const branches = yield* deps.git.listBranches({ cwd });
        for (const [index] of input.attempts.entries()) {
          if (
            stagedPlaceholders.some(
              (thread) => thread.id === threadIds[index] && thread.worktreePath,
            )
          )
            continue;
          const branch = `synara/parallel/${input.runId}/${index + 1}`;
          const previous = branches.branches.find((entry) => entry.name === branch);
          let worktreePath: string;
          if (previous) {
            if (!previous.worktreePath)
              return yield* Effect.fail(
                new Error(
                  `The branch ${branch} exists without a worktree. Preserve it and start a new run.`,
                ),
              );
            const head = (yield* deps.git.execute({
              cwd: previous.worktreePath,
              operation: "ParallelRuns.retryHead",
              args: ["rev-parse", "HEAD"],
              timeoutMs: 5_000,
            })).stdout.trim();
            const status = yield* deps.git.statusDetails(previous.worktreePath);
            if (head !== base || status.hasWorkingTreeChanges)
              return yield* Effect.fail(
                new Error("An unfinished attempt has changed. Preserve it and start a new run."),
              );
            worktreePath = previous.worktreePath;
          } else {
            worktreePath = (yield* deps.git.createWorktree({
              cwd,
              branch: base,
              newBranch: branch,
              path: null,
            })).worktree.path;
          }
          yield* deps.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`parallel:${input.runId}:attach:${index}`),
            threadId: threadIds[index]!,
            worktreePath,
            workingDirectory: path.resolve(worktreePath, relativeCwd),
          });
        }
        return base;
      }),
    );
    // Attempts run concurrently through the existing per-thread provider reactors.
    // Do not stop/delete earlier attempts if a later admission has an unknown outcome.
    const staged = yield* deps.query.getThreadShellsByIds(threadIds);
    for (const [index, selection] of input.attempts.entries()) {
      const attempt = staged.find((thread) => thread.id === threadIds[index]);
      if (!attempt || attempt.archivedAt)
        return yield* Effect.fail(new Error("The attempt is no longer active."));
      yield* deps.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`parallel:${input.runId}:start:${index}`),
        threadId: threadIds[index]!,
        message: {
          messageId: MessageId.makeUnsafe(`parallel:${input.runId}:prompt:${index}`),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        modelSelection: selection,
        runtimeMode: attempt.runtimeMode,
        interactionMode: attempt.interactionMode,
        createdAt: input.createdAt,
      });
    }
    return { threadIds, baseCommit };
  });
}
