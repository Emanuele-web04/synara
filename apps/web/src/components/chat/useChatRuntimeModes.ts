import { useMutation } from "@tanstack/react-query";
import { changeComputerPermission } from "../../lib/changeComputerPermission";
import {
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { useCallback, useEffect, useRef } from "react";
import { newCommandId } from "~/lib/utils";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { useComposerDraftStore } from "../../composerDraftStore";
import { providerModelSupportsAutoRuntimeMode } from "../../lib/runtimeMode";
import { type Thread } from "../../types";
import {
  createRuntimeModePersistenceQueue,
  persistModelSelectionBeforeRuntimeMode,
} from "../ChatView.logic";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";
import { toastManager } from "../ui/toast";

interface ChatRuntimeModesInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  serverThread: Thread | undefined;
  isLocalDraftThread: boolean;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  selectedProvider: ProviderKind;
  selectedRuntimeModel: ReturnType<typeof resolveRuntimeModelDescriptor>;
  selectedModelSelection: ModelSelection;
  activeProviderStatus: ServerProviderStatus | null;
  scheduleComposerFocus: () => void;
}

export function useChatRuntimeModes({
  threadId,
  activeThread,
  serverThread,
  isLocalDraftThread,
  runtimeMode,
  interactionMode,
  selectedProvider,
  selectedRuntimeModel,
  selectedModelSelection,
  activeProviderStatus,
  scheduleComposerFocus,
}: ChatRuntimeModesInput) {
  const setComposerDraftComputerControl = useComposerDraftStore(
    (state) => state.setEnableComputerControl,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((state) => state.setRuntimeMode);
  const setDraftThreadContext = useComposerDraftStore((state) => state.setDraftThreadContext);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (state) => state.setInteractionMode,
  );
  const runtimeModePersistenceQueuesRef = useRef(
    new Map<ThreadId, ReturnType<typeof createRuntimeModePersistenceQueue>>(),
  );
  useEffect(() => {
    const existing = runtimeModePersistenceQueuesRef.current.get(threadId);
    if (existing) {
      existing.syncAcknowledgedMode(runtimeMode);
      return;
    }
    runtimeModePersistenceQueuesRef.current.set(
      threadId,
      createRuntimeModePersistenceQueue(runtimeMode),
    );
  }, [runtimeMode, threadId]);

  const persistRuntimeModeChange = useCallback(
    async (mode: RuntimeMode): Promise<boolean> => {
      let queue = runtimeModePersistenceQueuesRef.current.get(threadId);
      if (!queue) {
        queue = createRuntimeModePersistenceQueue(runtimeMode);
        runtimeModePersistenceQueuesRef.current.set(threadId, queue);
      }
      return queue.persist(mode, async (currentMode, nextMode) => {
        if (serverThread) {
          const api = readNativeApi();
          if (!api) {
            toastManager.add({
              type: "error",
              title: "Could not update access mode",
              description: "Synara is not connected to the server.",
            });
            return false;
          }
          const persistenceInput = {
            currentModelSelection: serverThread.modelSelection,
            ...(nextMode === "auto" ? { nextModelSelection: selectedModelSelection } : {}),
            currentRuntimeMode: currentMode,
            nextRuntimeMode: nextMode,
            persistModelSelection: (modelSelection: ModelSelection) =>
              api.orchestration.dispatchCommand({
                type: "thread.meta.update",
                commandId: newCommandId(),
                threadId,
                modelSelection,
              }),
            persistRuntimeMode: (runtimeMode: RuntimeMode) =>
              api.orchestration.dispatchCommand({
                type: "thread.runtime-mode.set",
                commandId: newCommandId(),
                threadId,
                runtimeMode,
                createdAt: new Date().toISOString(),
              }),
          };
          try {
            await persistModelSelectionBeforeRuntimeMode(persistenceInput);
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Could not update access mode",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            });
            return false;
          }
        }
        setComposerDraftRuntimeMode(threadId, nextMode);
        if (isLocalDraftThread) {
          setDraftThreadContext(threadId, { runtimeMode: nextMode });
        }
        scheduleComposerFocus();
        return true;
      });
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      selectedModelSelection,
      serverThread,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      void persistRuntimeModeChange(mode);
    },
    [persistRuntimeModeChange],
  );
  const computerPermissionChange = useMutation({
    mutationFn: (enabled: boolean) =>
      changeComputerPermission({
        threadId,
        enabled,
        establishedThread: serverThread !== undefined,
        change: (input) => ensureNativeApi().computer.changePermission(input),
        persist: setComposerDraftComputerControl,
      }),
    onSuccess: () => scheduleComposerFocus(),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Computer permission change failed",
        description: `${error.message} Access may remain blocked. Retry the change.`,
      }),
  });
  const handleComputerControlChange = useCallback(
    (enabled: boolean) => {
      if (!computerPermissionChange.isPending) computerPermissionChange.mutate(enabled);
    },
    [computerPermissionChange],
  );
  // "Enable" on a computer-control denial card: switch control on for this chat
  // and suggest a retry message when the composer is empty, so the user can just
  // hit send. Deliberately not auto-sent: the user should see and approve what
  // goes back to the agent.
  const handleEnableComputerControlFromDenial = useCallback(() => {
    handleComputerControlChange(true);
  }, [handleComputerControlChange]);

  useEffect(() => {
    if (
      activeThread &&
      runtimeMode === "auto" &&
      !providerModelSupportsAutoRuntimeMode(
        selectedProvider,
        selectedRuntimeModel,
        activeProviderStatus,
      )
    ) {
      handleRuntimeModeChange("approval-required");
    }
  }, [
    activeProviderStatus,
    activeThread,
    handleRuntimeModeChange,
    runtimeMode,
    selectedProvider,
    selectedRuntimeModel,
  ]);

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      if (serverThread) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.interaction-mode.set",
              commandId: newCommandId(),
              threadId,
              interactionMode: mode,
              createdAt: new Date().toISOString(),
            })
            .catch((error) => {
              toastManager.add({
                type: "error",
                title: "Could not update interaction mode",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              });
            });
        }
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      serverThread,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const resetInteractionMode = useCallback(() => {
    handleInteractionModeChange("default");
  }, [handleInteractionModeChange]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      await persistModelSelectionBeforeRuntimeMode({
        currentModelSelection: serverThread.modelSelection,
        ...(input.modelSelection !== undefined ? { nextModelSelection: input.modelSelection } : {}),
        currentRuntimeMode: serverThread.runtimeMode,
        nextRuntimeMode: input.runtimeMode,
        persistModelSelection: (modelSelection) =>
          api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: input.threadId,
            modelSelection,
          }),
        persistRuntimeMode: (runtimeMode) =>
          api.orchestration.dispatchCommand({
            type: "thread.runtime-mode.set",
            commandId: newCommandId(),
            threadId: input.threadId,
            runtimeMode,
            createdAt: input.createdAt,
          }),
      });

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThread],
  );
  return {
    computerPermissionChange,
    handleComputerControlChange,
    handleEnableComputerControlFromDenial,
    persistRuntimeModeChange,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    toggleInteractionMode,
    resetInteractionMode,
    persistThreadSettingsForNextTurn,
  };
}
