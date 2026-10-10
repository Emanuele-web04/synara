import { Encoding } from "effect";
import {
  CheckpointRef,
  MessageId,
  ProjectId,
  type ProjectKind,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import { resolveThreadWorkspaceCwd as resolveSharedThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";

export const CHECKPOINT_REFS_PREFIX = "refs/synara/checkpoints";

const MANAGED_CHECKPOINT_REF_PATTERN =
  /^refs\/([A-Za-z0-9._-]+)\/checkpoints\/([A-Za-z0-9_-]+)\/(turn|message-start|turn-start|turn-live|revert-rescue)\/([A-Za-z0-9_-]+)$/;

export interface ManagedCheckpointRefParts {
  readonly namespace: string;
  readonly threadToken: string;
  readonly kind: "turn" | "message-start" | "turn-start" | "turn-live" | "revert-rescue";
  readonly valueToken: string;
  readonly familyPrefix: string;
}

export function parseManagedCheckpointRef(value: string): ManagedCheckpointRefParts | null {
  const match = MANAGED_CHECKPOINT_REF_PATTERN.exec(value);
  if (!match) return null;
  const [, namespace, threadToken, kind, valueToken] = match;
  if (!namespace || !threadToken || !kind || !valueToken) return null;
  if (kind === "turn" && !/^\d+$/.test(valueToken)) return null;
  return {
    namespace,
    threadToken,
    kind: kind as ManagedCheckpointRefParts["kind"],
    valueToken,
    familyPrefix: `refs/${namespace}/checkpoints/${threadToken}`,
  };
}

export function isManagedCheckpointRefForThread(value: string, threadId: ThreadId): boolean {
  const parsed = parseManagedCheckpointRef(value);
  return parsed?.threadToken === Encoding.encodeBase64Url(threadId);
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function checkpointRefForThreadTurnInManagedFamily(
  managedRef: string,
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef | null {
  const parsed = parseManagedCheckpointRef(managedRef);
  if (parsed?.threadToken !== Encoding.encodeBase64Url(threadId)) return null;
  return CheckpointRef.makeUnsafe(`${parsed.familyPrefix}/turn/${turnCount}`);
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

export function checkpointRefForThreadTurnStartInManagedFamily(
  managedRef: string,
  threadId: ThreadId,
  turnId: TurnId,
): CheckpointRef | null {
  const parsed = parseManagedCheckpointRef(managedRef);
  if (parsed?.threadToken !== Encoding.encodeBase64Url(threadId)) return null;
  return CheckpointRef.makeUnsafe(
    `${parsed.familyPrefix}/turn-start/${Encoding.encodeBase64Url(turnId)}`,
  );
}

// throwaway ref: captured, diffed, deleted on every live recompute — never a durable checkpoint
export function checkpointRefForThreadTurnLive(threadId: ThreadId, turnId: TurnId): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn-live/${Encoding.encodeBase64Url(turnId)}`,
  );
}

// pre-revert worktree snapshot — a revert mutates two systems that can't commit together; random token so concurrent reverts never share it
export function checkpointRefForThreadRevertRescue(
  threadId: ThreadId,
  token: string,
): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/revert-rescue/${token}`,
  );
}

/** `chat` projects have no real cwd until a worktree is materialized — suppress workspaceRoot until then; `studio` and others use it as-is */
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
    readonly workingDirectory?: string | null | undefined;
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
      workingDirectory: input.thread.workingDirectory,
    }) ?? undefined
  );
}
