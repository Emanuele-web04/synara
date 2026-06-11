import type {
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";

export function createShellSnapshotFromFixtureSnapshot(
  snapshot: OrchestrationReadModel,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => ({
        id: project.id,
        kind: project.kind,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModelSelection: project.defaultModelSelection,
        scripts: project.scripts,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
    threads: snapshot.threads
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        interactionMode: thread.interactionMode,
        runtimeMode: thread.runtimeMode,
        envMode: thread.envMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        associatedWorktreePath: thread.associatedWorktreePath ?? null,
        associatedWorktreeBranch: thread.associatedWorktreeBranch ?? null,
        associatedWorktreeRef: thread.associatedWorktreeRef ?? null,
        parentThreadId: thread.parentThreadId ?? null,
        subagentAgentId: thread.subagentAgentId ?? null,
        subagentNickname: thread.subagentNickname ?? null,
        subagentRole: thread.subagentRole ?? null,
        forkSourceThreadId: thread.forkSourceThreadId ?? null,
        sidechatSourceThreadId: thread.sidechatSourceThreadId ?? null,
        latestTurn: thread.latestTurn,
        latestUserMessageAt: thread.latestUserMessageAt ?? null,
        hasPendingApprovals: thread.hasPendingApprovals ?? false,
        hasPendingUserInput: thread.hasPendingUserInput ?? false,
        hasActionableProposedPlan: thread.hasActionableProposedPlan ?? false,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt ?? null,
        handoff: thread.handoff ?? null,
        session: thread.session,
      })),
    updatedAt: snapshot.updatedAt,
  };
}

export function getThreadDetailFromFixtureSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread {
  const thread = snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Missing thread fixture for ${threadId}`);
  }
  return thread;
}
