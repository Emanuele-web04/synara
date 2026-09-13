// FILE: useThreadHandoff.ts
// Purpose: Creates provider-to-provider handoff threads from the active web state.
// Layer: Web hook
// Exports: useThreadHandoff

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ProviderKind } from "@synara/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useAppSettings } from "../appSettings";
import { useProviderStatusesForLocalConfig } from "./useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "./useProviderStatusRefresh";
import {
  buildThreadHandoffImportedActivities,
  buildThreadHandoffImportedMessages,
  canCreateThreadHandoff,
  isEligibleHandoffTargetProvider,
  resolveThreadHandoffModelSelection,
  resolveThreadHandoffTitle,
} from "../lib/threadHandoff";
import { resolveProviderSendAvailabilityWithRefresh } from "../lib/providerAvailability";
import { resolveProviderDiscoveryCwd } from "../lib/providerDiscovery";
import { providerModelsPrefetchQueryOptions } from "../lib/providerModelPrefetch";
import { serverConfigQueryOptions, serverSettingsQueryOptions } from "../lib/serverReactQuery";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { type Thread } from "../types";

export function useThreadHandoff() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const projects = useStore((store) => store.projects);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const serverConfigQuery = useQuery(serverConfigQueryOptions());

  const resolveTargetModelSelection = async (
    thread: Thread,
    targetProvider: ProviderKind,
    projectDefaultModelSelection: Thread["modelSelection"] | null | undefined,
    stickyModelSelectionByProvider: Partial<Record<ProviderKind, Thread["modelSelection"]>>,
  ): Promise<Thread["modelSelection"]> => {
    const hasKnownPiSelection =
      targetProvider !== "pi" ||
      stickyModelSelectionByProvider.pi?.provider === "pi" ||
      projectDefaultModelSelection?.provider === "pi";
    let discoveredFallbackModel: string | null = null;

    if (!hasKnownPiSelection) {
      const project = projects.find((entry) => entry.id === thread.projectId);
      const cwd = resolveProviderDiscoveryCwd({
        activeThreadWorktreePath: thread.worktreePath ?? null,
        activeProjectCwd: project?.cwd ?? null,
        serverCwd: serverConfigQuery.data?.cwd ?? null,
      });
      const discovered = await queryClient.fetchQuery(
        providerModelsPrefetchQueryOptions({
          provider: "pi",
          settings,
          cwd,
          priority: "prefetch",
        }),
      );
      discoveredFallbackModel = discovered.models[0]?.slug ?? null;
    }

    return resolveThreadHandoffModelSelection({
      sourceThread: thread,
      targetProvider,
      projectDefaultModelSelection,
      stickyModelSelectionByProvider,
      discoveredFallbackModel,
    });
  };

  const createThreadHandoff = async (
    thread: Thread,
    targetProvider: ProviderKind,
  ): Promise<Thread["id"]> => {
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
    const targetAvailability = await resolveProviderSendAvailabilityWithRefresh({
      provider: targetProvider,
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    });
    if (
      !isEligibleHandoffTargetProvider({
        sourceProvider: thread.modelSelection.provider,
        targetProvider,
        targetProviderEnabled: serverSettingsQuery.data?.providers[targetProvider].enabled,
        targetProviderStatus: targetAvailability.status,
      })
    ) {
      throw new Error(
        targetAvailability.usable
          ? "This handoff target is not available for the current thread."
          : targetAvailability.unavailableReason,
      );
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
      modelSelection: await resolveTargetModelSelection(
        thread,
        targetProvider,
        project.defaultModelSelection,
        stickyModelSelectionByProvider,
      ),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      envMode: thread.envMode ?? (thread.worktreePath ? "worktree" : "local"),
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      workingDirectory: thread.workingDirectory ?? null,
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
  };

  const continueThreadWithProvider = async (
    thread: Thread,
    targetProvider: ProviderKind,
  ): Promise<Thread["id"]> => {
    const api = readNativeApi();
    if (!api) {
      throw new Error("Native API not found");
    }

    const project = projects.find((entry) => entry.id === thread.projectId);
    if (!project) {
      throw new Error("Project not found for provider handoff.");
    }
    if (!canCreateThreadHandoff({ thread })) {
      throw new Error("This thread cannot switch providers yet.");
    }

    const targetAvailability = await resolveProviderSendAvailabilityWithRefresh({
      provider: targetProvider,
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    });
    if (
      !isEligibleHandoffTargetProvider({
        sourceProvider: thread.modelSelection.provider,
        targetProvider,
        targetProviderEnabled: serverSettingsQuery.data?.providers[targetProvider].enabled,
        targetProviderStatus: targetAvailability.status,
      })
    ) {
      throw new Error(
        targetAvailability.usable
          ? "This provider is not available for the current thread."
          : targetAvailability.unavailableReason,
      );
    }

    const { stickyModelSelectionByProvider } = useComposerDraftStore.getState();
    await api.orchestration.dispatchCommand({
      type: "thread.provider.handoff",
      commandId: newCommandId(),
      threadId: thread.id,
      expectedSourceProvider: thread.modelSelection.provider,
      targetModelSelection: await resolveTargetModelSelection(
        thread,
        targetProvider,
        project.defaultModelSelection,
        stickyModelSelectionByProvider,
      ),
      createdAt: new Date().toISOString(),
    });

    return thread.id;
  };

  return {
    createThreadHandoff,
    continueThreadWithProvider,
  };
}
