import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RuntimeWorkspaceDiff } from "../../executionRuntime/Services/RuntimeWorkspaceDiff.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import {
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnStart,
  resolveThreadWorkspaceCwd,
} from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(input: {
  readonly threadId: OrchestrationGetTurnDiffResultType["threadId"];
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly diff: string;
}): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff: input.diff,
  };
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;
  const runtimeWorkspaceDiff = yield* RuntimeWorkspaceDiff;

  // A remote-runtime thread's edits land in the sandbox, not the host repo, so
  // the host CheckpointStore has nothing to diff. Returns the sandbox working-
  // tree diff for any requested range (v1 has no per-turn sandbox checkpoints, so
  // every range maps to "current uncommitted changes vs the cloned ref"), or
  // `null` for a local/worktree thread which keeps the host path. Best-effort: an
  // unreadable sandbox degrades to an empty diff rather than the host "ref
  // unavailable" error.
  const resolveRemoteThreadDiff = (
    threadId: OrchestrationGetTurnDiffResultType["threadId"],
    fromTurnCount: number,
    toTurnCount: number,
  ) =>
    Effect.gen(function* () {
      const threadOption = yield* projectionSnapshotQuery
        .getThreadDetailById(threadId)
        .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
      const thread = Option.getOrUndefined(threadOption);
      const runtime = thread?.runtime;
      if (runtime?.targetKind !== "remote-runtime" || runtime.instance === null) {
        return null;
      }
      const workspaceDiff = yield* runtimeWorkspaceDiff.read({
        instanceId: runtime.instance.id,
        provider: runtime.instance.provider,
        workdir: runtime.instance.rootPath ?? undefined,
      });
      return buildTurnDiffResult({
        threadId,
        fromTurnCount,
        toTurnCount,
        diff: workspaceDiff.diff,
      });
    });

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff;
      }

      const remoteDiff = yield* resolveRemoteThreadDiff(
        input.threadId,
        input.fromTurnCount,
        input.toTurnCount,
      );
      if (remoteDiff !== null) {
        if (!isTurnDiffResult(remoteDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return remoteDiff;
      }

      const threadContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
        input.threadId,
      );
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        });
      }

      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread: {
          projectId: threadContext.value.projectId,
          envMode: threadContext.value.envMode,
          worktreePath: threadContext.value.worktreePath,
        },
        projects: [
          {
            id: threadContext.value.projectId,
            workspaceRoot: threadContext.value.workspaceRoot,
          },
        ],
      });
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        });
      }

      const toCheckpoint = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      );
      if (!toCheckpoint) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const fromCheckpoint =
        input.fromTurnCount === 0
          ? null
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            );
      if (fromCheckpoint?.status === "missing") {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint diff is not available yet for turn ${input.fromTurnCount}.`,
        });
      }

      let fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : fromCheckpoint?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      const toCheckpointRef = toCheckpoint.checkpointRef;
      if (toCheckpoint.status === "missing") {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint diff is not available yet for turn ${input.toTurnCount}.`,
        });
      }
      if (input.toTurnCount === input.fromTurnCount + 1) {
        const turnStartCheckpointRef = checkpointRefForThreadTurnStart(
          input.threadId,
          toCheckpoint.turnId,
        );
        const turnStartExists = yield* checkpointStore.hasCheckpointRef({
          cwd: workspaceCwd,
          checkpointRef: turnStartCheckpointRef,
        });
        if (turnStartExists) {
          fromCheckpointRef = turnStartCheckpointRef;
        }
      }

      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      });

      const turnDiff = buildTurnDiffResult({
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      });
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed turn diff result does not satisfy contract schema.",
        });
      }

      return turnDiff;
    });

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = (
    input: OrchestrationGetFullThreadDiffInput,
  ) =>
    Effect.gen(function* () {
      const operation = "CheckpointDiffQuery.getFullThreadDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;

      if (input.toTurnCount === 0) {
        const emptyDiff = buildTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
          diff: "",
        });
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed full thread diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
      }

      const remoteDiff = yield* resolveRemoteThreadDiff(input.threadId, 0, input.toTurnCount);
      if (remoteDiff !== null) {
        if (!isTurnDiffResult(remoteDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed full thread diff result does not satisfy contract schema.",
          });
        }
        return remoteDiff satisfies OrchestrationGetFullThreadDiffResult;
      }

      const threadContext = yield* projectionSnapshotQuery.getFullThreadDiffContext(
        input.threadId,
        input.toTurnCount,
      );
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${threadContext.value.latestCheckpointTurnCount}.`,
        });
      }

      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread: {
          projectId: threadContext.value.projectId,
          envMode: threadContext.value.envMode,
          worktreePath: threadContext.value.worktreePath,
        },
        projects: [
          {
            id: threadContext.value.projectId,
            workspaceRoot: threadContext.value.workspaceRoot,
          },
        ],
      });
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing full thread diff.`,
        });
      }

      if (!threadContext.value.toCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef: checkpointRefForThreadTurn(input.threadId, 0),
        toCheckpointRef: threadContext.value.toCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      });

      const fullThreadDiff = buildTurnDiffResult({
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
        diff,
      });
      if (!isTurnDiffResult(fullThreadDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed full thread diff result does not satisfy contract schema.",
        });
      }

      return fullThreadDiff satisfies OrchestrationGetFullThreadDiffResult;
    });

  return {
    getTurnDiff,
    getFullThreadDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
