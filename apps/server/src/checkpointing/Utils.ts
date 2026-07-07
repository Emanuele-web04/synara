import { Encoding } from "effect";
import {
  CheckpointRef,
  MessageId,
  ProjectId,
  type ProjectKind,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveThreadWorkspaceCwd as resolveSharedThreadWorkspaceCwd } from "@t3tools/shared/threadEnvironment";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function checkpointRefForThreadMessageStart(
  threadId: ThreadId,
  messageId: MessageId,
): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/message-start/${Encoding.encodeBase64Url(messageId)}`,
  );
}

export function checkpointRefForThreadTurnStart(threadId: ThreadId, turnId: TurnId): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn-start/${Encoding.encodeBase64Url(turnId)}`,
  );
}

// Throwaway ref used to snapshot the working tree mid-turn so a live diff can be
// computed against the turn-start baseline. It is captured, diffed, and deleted
// on every live recompute; it never becomes a durable checkpoint.
export function checkpointRefForThreadTurnLive(threadId: ThreadId, turnId: TurnId): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn-live/${Encoding.encodeBase64Url(turnId)}`,
  );
}

/**
 * Decide whether a project's `workspaceRoot` should be treated as a thread's
 * real, usable working directory.
 *
 * - `chat` projects are throwaway sandboxes with no durable working
 *   directory of their own: their `workspaceRoot` is not a real cwd until a
 *   worktree has actually been materialized for the thread, so it must be
 *   suppressed (treated as absent) until then.
 * - `studio` projects always have a real, durable cwd (the Studio root), so
 *   their `workspaceRoot` is used as-is, exactly like every other kind.
 * - Every other kind (including the default `project` kind, and an
 *   unresolved/undefined project) treats `workspaceRoot` as the real cwd.
 */
export function resolveProjectCwdForKind(input: {
  readonly kind: ProjectKind | string | null | undefined;
  readonly workspaceRoot: string | null;
  readonly worktreePath: string | null | undefined;
}): string | null {
  if (input.kind === "chat" && !input.worktreePath) {
    return null;
  }
  return input.workspaceRoot;
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly envMode?: "local" | "worktree" | undefined;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly kind?: ProjectKind | undefined;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const project = input.projects.find((entry) => entry.id === input.thread.projectId);
  const projectCwd = resolveProjectCwdForKind({
    kind: project?.kind,
    workspaceRoot: project?.workspaceRoot ?? null,
    worktreePath: input.thread.worktreePath,
  });
  return (
    resolveSharedThreadWorkspaceCwd({
      projectCwd,
      envMode: input.thread.envMode,
      worktreePath: input.thread.worktreePath,
    }) ?? undefined
  );
}
