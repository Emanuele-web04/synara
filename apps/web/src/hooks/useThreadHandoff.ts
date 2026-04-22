import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { type ProviderKind } from "@t3tools/contracts";
import { getCustomBinaryPathForProvider, useAppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import {
  buildThreadHandoffImportedActivities,
  buildThreadHandoffImportedMessages,
  canCreateThreadHandoff,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffModelSelection,
} from "../lib/threadHandoff";
import {
  isProviderUsable,
  normalizeProviderStatusForLocalConfig,
} from "../lib/providerAvailability";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { type Thread } from "../types";

export function useThreadHandoff() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const projects = useStore((store) => store.projects);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());

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
      const targetStatus = normalizeProviderStatusForLocalConfig({
        provider: targetProvider,
        status:
          serverConfigQuery.data?.providers.find((entry) => entry.provider === targetProvider) ??
          null,
        customBinaryPath: getCustomBinaryPathForProvider(settings, targetProvider),
      });
      if (!isProviderUsable(targetStatus)) {
        throw new Error("This provider is not available yet.");
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
        title: thread.title,
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

      const snapshot = await api.orchestration.getSnapshot();
      syncServerReadModel(snapshot);
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });

      return nextThreadId;
    },
    [
      navigate,
      projects,
      serverConfigQuery.data?.providers,
      settings,
      syncServerReadModel,
    ],
  );

  return {
    createThreadHandoff,
  };
}
