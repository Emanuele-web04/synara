import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildThreadHandoffImportedMessages,
  canCreateThreadHandoff,
  resolveThreadHandoffModelSelection,
} from "../lib/threadHandoff";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { type Thread } from "../types";

export function useThreadHandoff() {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);

  const createThreadHandoff = useCallback(
    async (thread: Thread): Promise<Thread["id"]> => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API not found");
      }

      const project = projects.find((entry) => entry.id === thread.projectId);
      if (!project) {
        throw new Error("Project not found for handoff thread.");
      }

      if (!canCreateThreadHandoff({ thread })) {
        throw new Error("This thread cannot be handed off yet.");
      }

      const nextThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const importedMessages = buildThreadHandoffImportedMessages(thread);
      const { stickyModelSelectionByProvider } = useComposerDraftStore.getState();

      await api.orchestration.dispatchCommand({
        type: "thread.handoff.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        sourceThreadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: resolveThreadHandoffModelSelection({
          sourceThread: thread,
          projectDefaultModelSelection: project.defaultModelSelection,
          stickyModelSelectionByProvider,
        }),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        envMode: thread.envMode ?? (thread.worktreePath ? "worktree" : "local"),
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        associatedWorktreePath: thread.associatedWorktreePath ?? thread.worktreePath ?? null,
        associatedWorktreeBranch: thread.associatedWorktreeBranch ?? thread.branch ?? null,
        associatedWorktreeRef:
          thread.associatedWorktreeRef ??
          thread.associatedWorktreeBranch ??
          thread.branch ??
          null,
        importedMessages: [...importedMessages],
        createdAt,
      });

      const snapshot = await api.orchestration.getSnapshot();
      syncServerReadModel(snapshot);
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });

      return nextThreadId;
    },
    [navigate, projects, syncServerReadModel],
  );

  return {
    createThreadHandoff,
  };
}
