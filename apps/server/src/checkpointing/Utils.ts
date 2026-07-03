import { Encoding } from "effect";
import { CheckpointRef, MessageId, ProjectId, type ThreadId, TurnId } from "@t3tools/contracts";
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

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly envMode?: "local" | "worktree" | undefined;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly kind?: "project" | "chat" | undefined;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const project = input.projects.find((entry) => entry.id === input.thread.projectId);
  const projectCwd =
    project?.kind === "chat" && !input.thread.worktreePath
      ? null
      : (project?.workspaceRoot ?? null);
  return (
    resolveSharedThreadWorkspaceCwd({
      projectCwd,
      envMode: input.thread.envMode,
      worktreePath: input.thread.worktreePath,
    }) ?? undefined
  );
}
