// FILE: useThreadHandoff.ts
// Purpose: Creates provider-to-provider handoff threads from the active web state.
// Layer: Web hook
// Exports: useThreadHandoff

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { type ProviderKind } from "@synara/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProviderStatusesForLocalConfig } from "./useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "./useProviderStatusRefresh";
import {
  buildThreadHandoffImportedActivities,
  buildThreadHandoffImportedMessages,
  canCreateThreadHandoff,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffModelSelection,
  resolveThreadHandoffTitle,
} from "../lib/threadHandoff";
import { resolveProviderSendAvailabilityWithRefresh } from "../lib/providerAvailability";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { type Thread } from "../types";

export function useThreadHandoff() {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();

  const createThreadHandoff = useCallback(
    async (thread: Thread, targetProvider: ProviderKind): Promise<Thread["id"]> => {
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
      if (
        !resolveAvailableHandoffTargetProviders(thread.modelSelection.provider).includes(
          targetProvider,
        )
      ) {
        throw new Error("This handoff target is not available for the current thread.");
      }
      const targetAvailability = await resolveProviderSendAvailabilityWithRefresh({
        provider: targetProvider,
        statuses: providerStatuses,
        refreshStatuses: () => refreshProviderStatuses({ silent: true }),
      });
      if (!targetAvailability.usable) {
        throw new Error(targetAvailability.unavailableReason);
      }

      const nextThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const importedMessages = buildThreadHandoffImportedMessages(thread);
      const importedActivities = buildThreadHandoffImportedActivities(thread);
      const { copyTransferableComposerState, stickyModelSelectionByProvider } =
        useComposerDraftStore.getState();

      await api.orchestration.dispatchCommand({
        type: "thread.handoff.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        sourceThreadId: thread.id,
        projectId: thread.projectId,
        title: resolveThreadHandoffTitle(thread),
        modelSelection: resolveThreadHandoffModelSelection({
          sourceThread: thread,
          targetProvider,
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
          thread.associatedWorktreeRef ?? thread.associatedWorktreeBranch ?? thread.branch ?? null,
        createBranchFlowCompleted: thread.createBranchFlowCompleted ?? false,
        importedMessages: [...importedMessages],
        createdAt,
      });

      for (const activity of importedActivities) {
        await api.orchestration.dispatchCommand({
          type: "thread.activity.append",
          commandId: newCommandId(),
          threadId: nextThreadId,
          activity,
          createdAt,
        });
      }

      copyTransferableComposerState(thread.id, nextThreadId);

      const snapshot = await api.orchestration.getShellSnapshot();
      syncServerShellSnapshot(snapshot);
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });

      return nextThreadId;
    },
    [navigate, projects, providerStatuses, refreshProviderStatuses, syncServerShellSnapshot],
  );

  return {
    createThreadHandoff,
  };
}
