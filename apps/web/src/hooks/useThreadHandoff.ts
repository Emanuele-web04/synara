// FILE: useThreadHandoff.ts
// Purpose: Hands a thread to another provider, in place or in a new thread.
// Layer: Web hook
// Exports: useThreadHandoff

import { useNavigate } from "@tanstack/react-router";
import {
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderKind,
} from "@synara/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProviderStatusesForLocalConfig } from "./useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "./useProviderStatusRefresh";
import {
  buildThreadHandoffImportedActivities,
  buildThreadHandoffImportedMessages,
  canContinueThreadHandoff,
  canCreateThreadHandoff,
  type ProviderHandoffOutcome,
  resolveProviderHandoffOutcome,
  resolveThreadHandoffModelSelection,
  resolveThreadHandoffTitle,
} from "../lib/threadHandoff";
import { resolveProviderSendAvailabilityWithRefresh } from "../lib/providerAvailability";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { type Thread } from "../types";

// Provider startup (CLI spawn, auth, MCP) can take a while; past this the
// caller keeps the user's message and reports the handoff as still starting.
const PROVIDER_HANDOFF_OUTCOME_TIMEOUT_MS = 120_000;

function waitForProviderHandoffOutcome(
  threadId: Thread["id"],
  commandId: string,
): Promise<ProviderHandoffOutcome> {
  const read = () =>
    resolveProviderHandoffOutcome(getThreadFromState(useStore.getState(), threadId), commandId);
  const initial = read();
  if (initial.status !== "pending") {
    return Promise.resolve(initial);
  }
  return new Promise((resolve) => {
    const finish = (outcome: ProviderHandoffOutcome) => {
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = useStore.subscribe(() => {
      const outcome = read();
      if (outcome.status !== "pending") {
        finish(outcome);
      }
    });
    const timeout = window.setTimeout(
      () => finish({ status: "pending" }),
      PROVIDER_HANDOFF_OUTCOME_TIMEOUT_MS,
    );
  });
}

export function useThreadHandoff() {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();

  // Shared by both Hand off destinations: the same preconditions, target
  // availability check, and target model selection.
  const prepareThreadHandoff = async (
    thread: Thread,
    targetProvider: ProviderKind,
    targetProviderInstanceId?: ProviderInstanceId,
  ) => {
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
    const sourceProviderInstanceId =
      thread.session?.providerInstanceId ??
      thread.modelSelection.instanceId ??
      thread.modelSelection.provider;
    const targetInstanceId = targetProviderInstanceId ?? targetProvider;
    if (
      targetProvider === thread.modelSelection.provider &&
      targetInstanceId === sourceProviderInstanceId
    ) {
      throw new Error("This handoff target is not available for the current thread.");
    }
    const targetAvailability = await resolveProviderSendAvailabilityWithRefresh({
      provider: targetProvider,
      ...(targetProviderInstanceId ? { instanceId: targetProviderInstanceId } : {}),
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    });
    if (!targetAvailability.usable) {
      throw new Error(
        targetAvailability.usable
          ? "This handoff target is not available for the current thread."
          : targetAvailability.unavailableReason,
      );
    }

    const modelSelection = resolveThreadHandoffModelSelection({
      sourceThread: thread,
      targetProvider,
      targetProviderInstanceId,
      projectDefaultModelSelection: project.defaultModelSelection,
      stickyModelSelectionByProvider:
        useComposerDraftStore.getState().stickyModelSelectionByProvider,
    });
    return { api, modelSelection };
  };

  // Keeps the thread (id, transcript, project, worktree) and switches who runs
  // its next turn. The server starts the target session, records the handoff in
  // the timeline, and restores the source selection if the target cannot start.
  // Resolves once the target is up; throws when it failed or is still starting,
  // so a caller holding a message keeps it.
  const continueThreadHandoff = async (
    thread: Thread,
    targetProvider: ProviderKind,
    targetProviderInstanceId?: ProviderInstanceId,
    // The model picked in the composer; the header menu leaves it to the
    // same default the new-thread handoff uses.
    explicitModelSelection?: ModelSelection,
  ): Promise<void> => {
    if (
      !canContinueThreadHandoff({ sourceProvider: thread.modelSelection.provider, targetProvider })
    ) {
      throw new Error("Hand off to a new thread to switch between accounts of the same provider.");
    }
    const prepared = await prepareThreadHandoff(thread, targetProvider, targetProviderInstanceId);
    const modelSelection = explicitModelSelection ?? prepared.modelSelection;
    const commandId = newCommandId();
    // The composer shows the provider the next message goes to.
    useComposerDraftStore.getState().setModelSelectionAndSticky(thread.id, modelSelection);
    await prepared.api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId,
      threadId: thread.id,
      modelSelection,
      providerHandoff: true,
    });
    const outcome = await waitForProviderHandoffOutcome(thread.id, commandId);
    const targetName = PROVIDER_DISPLAY_NAMES[targetProvider] ?? targetProvider;
    if (outcome.status === "failed") {
      throw new Error(`${targetName} could not start: ${outcome.detail}`);
    }
    if (outcome.status === "pending") {
      throw new Error(`${targetName} is still starting. Try again once it is ready.`);
    }
  };

  const createThreadHandoff = async (
    thread: Thread,
    targetProvider: ProviderKind,
    targetProviderInstanceId?: ProviderInstanceId,
  ): Promise<Thread["id"]> => {
    const { api, modelSelection } = await prepareThreadHandoff(
      thread,
      targetProvider,
      targetProviderInstanceId,
    );

    const nextThreadId = newThreadId();
    const createdAt = new Date().toISOString();
    const importedMessages = buildThreadHandoffImportedMessages(thread);
    const importedActivities = buildThreadHandoffImportedActivities(thread);
    const { copyTransferableComposerState } = useComposerDraftStore.getState();

    await api.orchestration.dispatchCommand({
      type: "thread.handoff.create",
      commandId: newCommandId(),
      threadId: nextThreadId,
      sourceThreadId: thread.id,
      projectId: thread.projectId,
      title: resolveThreadHandoffTitle(thread),
      modelSelection,
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

  return {
    continueThreadHandoff,
    createThreadHandoff,
  };
}
