// FILE: useTaskDelegation.ts
// Purpose: Starts the delegation for the Tasks delegate form: links a chat to the to-do,
//          sends the prompt (in an existing chat or a freshly created one), reports the
//          outcome, and undoes the link when the send fails. Owns the busy state and the
//          double-submit guard.
// Layer: Tasks UI hook
// Exports: useTaskDelegation

import type { ServerProviderStatus, ThreadId, Todo, TodoUpdateInput } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import {
  getProviderStartOptions,
  getProviderInstanceOptions,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "~/appSettings";
import { toastManager } from "~/components/ui/toast";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import type { ScratchModelDraft } from "~/hooks/useScratchComposerDraft";
import type { ScratchModelCatalog } from "~/hooks/useScratchModelCatalog";
import { ensureHomeChatProject } from "~/lib/chatProjects";
import { createAndDispatchDraftThread } from "~/lib/draftThreadCreate";
import {
  dispatchDraftThread,
  resolveDraftThreadDispatchTarget,
  type DraftThreadDispatchResult,
} from "~/lib/draftThreadDispatch";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { isRequestOutcomeUnknown } from "~/lib/requestOutcome";
import { composerDraftHasUnsentContent } from "../../composerDraftDomain";
import { providerInstanceModelSelectionKey, useComposerDraftStore } from "../../composerDraftStore";
import { ensureNativeApi } from "../../nativeApi";
import { buildModelSelection } from "../../providerModelOptions";
import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../../types";
import { useWorkspacePathsStore } from "../../workspacePathsStore";
import type { DelegateTarget } from "./useTaskDelegateTarget";

export function useTaskDelegation(options: {
  readonly todo: Todo;
  /** Records the chat on the to-do; runs before anything is sent, and throwing aborts. */
  readonly onLinkChat: (input: TodoUpdateInput) => Promise<unknown>;
  readonly onDelegated: (() => void) | undefined;
  /** What the agent gets, read when Start is pressed so an edit saved by that press counts. */
  readonly readPrompt: () => string;
  readonly draft: ScratchModelDraft;
  readonly catalog: ScratchModelCatalog;
  readonly providerStatuses: readonly ServerProviderStatus[];
  readonly target: DelegateTarget | null;
  /** The chosen existing chat; null starts a new chat in `target`. */
  readonly existingChat: SidebarThreadSummary | null;
}) {
  const {
    todo,
    onLinkChat,
    onDelegated,
    readPrompt,
    draft,
    catalog,
    providerStatuses,
    target,
    existingChat,
  } = options;
  const {
    scratchThreadId,
    selectedProvider,
    selectedProviderInstanceId,
    selectedModel,
    selectedModelSupportsAutoMode,
  } = draft;
  const { modelOptionsByProvider, runtimeMode, runtimeModelForCapabilities } = catalog;
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const [isStarting, setIsStarting] = useState(false);
  // Synchronous re-entry guard: a repeated ⌘↵ can land before React flushes isStarting.
  const isStartingRef = useRef(false);

  const reportResult = (
    result: DraftThreadDispatchResult,
    threadId: ThreadId,
    agentLabel: string,
  ): boolean => {
    if (result.kind === "error" && result.outcomeUnknown) {
      // The server may have started the agent: keep the link and the chat rather than
      // orphan live work. If nothing arrives, the task's menu can unlink it.
      toastManager.add({
        type: "warning",
        title: "Couldn't confirm the agent started",
        description: "The connection dropped while sending. Check the chat.",
      });
      return true;
    }
    if (result.kind === "dispatched") {
      toastManager.add({
        type: "success",
        title: `Delegated to ${agentLabel}`,
        description: todo.title,
      });
      return true;
    }
    if (result.kind === "open-thread") {
      toastManager.add({
        type: "info",
        title: "Finish delegating in the chat",
        description:
          result.reason === "worktree-pending"
            ? "Worktree setup runs from the chat composer."
            : "The chat has nothing to send yet.",
      });
      void navigate({ to: "/$threadId", params: { threadId } });
      return true;
    }
    toastManager.add({
      type: "error",
      title: "Couldn't start the agent",
      description: result.kind === "error" ? result.message : "The server is not reachable.",
    });
    return false;
  };

  // The link is written before anything is sent, so a send that fails must undo it:
  // otherwise the to-do stays on "Starting" for a chat that never got its prompt.
  // Returns false when linking failed; the mutation already told the user why. A link
  // whose reply was lost with the connection may still have been stored, so re-read the
  // to-do before deciding.
  const linkChat = (input: TodoUpdateInput) =>
    onLinkChat(input).then(
      () => true,
      async (error: unknown) => {
        if (!isRequestOutcomeUnknown(error) || input.threadId === undefined) return false;
        try {
          const { todos } = await ensureNativeApi().todo.list();
          return todos.find((stored) => stored.id === input.id)?.threadId === input.threadId;
        } catch {
          return false;
        }
      },
    );
  // Awaited so Start stays busy until the to-do is back to "To do"; if the server can't
  // store that either, the mutation's toast says so and the row's menu can unlink later.
  const unlinkChat = async (linkedChatId: ThreadId, clearProject: boolean) => {
    await linkChat({
      id: todo.id,
      threadId: null,
      // Only undo our own link, never one another window made meanwhile.
      expectedThreadId: linkedChatId,
      ...(clearProject ? { projectId: null } : {}),
    });
  };

  const startInExistingChat = async (thread: SidebarThreadSummary, prompt: string) => {
    const chatId = thread.id;
    const composerStore = useComposerDraftStore.getState();
    const chatDraft = composerStore.draftsByThreadId[chatId];
    // The dispatch sends the chat's composer and clears it, so anything unsent would ride
    // along or be lost.
    if (chatDraft && composerDraftHasUnsentContent(chatDraft)) {
      toastManager.add({
        type: "error",
        title: "That chat has an unsent message",
        description: "Send or clear it first, then delegate again.",
      });
      return false;
    }
    // expectedThreadId makes the link a claim: it fails if another window delegated first.
    // The base turn keeps the chat's earlier work from reading as this to-do's until the
    // delegated turn appears, in every window.
    const linked = await linkChat({
      id: todo.id,
      threadId: chatId,
      delegationBaseTurnId: thread.latestTurn?.turnId ?? null,
      expectedThreadId: todo.threadId,
    });
    if (!linked) return false;
    const providerInstances = getProviderInstanceOptions(settings);
    const dispatchTarget = resolveDraftThreadDispatchTarget({
      threadId: chatId,
      projectId: thread.projectId,
      thread,
      defaultProvider: settings.defaultProvider,
      providerInstances,
    });
    composerStore.setPrompt(chatId, prompt);
    const result = await dispatchDraftThread({
      threadId: chatId,
      projectId: thread.projectId,
      thread,
      defaultProvider: settings.defaultProvider,
      assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
      providerOptions: getProviderStartOptions(settings, dispatchTarget.instanceId),
      providerInstances,
    });
    const started = reportResult(result, chatId, thread.title);
    if (!started) {
      // The chat's composer was empty before; don't leave the delegation prompt in it.
      useComposerDraftStore.getState().setPrompt(chatId, "");
      await unlinkChat(chatId, false);
    }
    return started;
  };

  const startInNewChat = async (prompt: string) => {
    if (!target || selectedModel === null) return false;
    const availability = await resolveProviderSendAvailabilityWithRefresh({
      provider: selectedProvider,
      instanceId: selectedProviderInstanceId,
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    });
    if (!availability.usable) {
      toastManager.add({ type: "error", title: availability.unavailableReason });
      return false;
    }
    const workspacePaths = useWorkspacePathsStore.getState();
    const projectId =
      target.kind === "project"
        ? target.projectId
        : await ensureHomeChatProject({
            homeDir: workspacePaths.homeDir,
            chatWorkspaceRoot: workspacePaths.chatWorkspaceRoot,
          });
    if (!projectId) {
      toastManager.add({ type: "error", title: "Couldn't prepare a chat for that folder" });
      return false;
    }
    const scratch = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId];
    const storedSelection =
      scratch?.modelSelectionByProvider[
        providerInstanceModelSelectionKey(selectedProvider, selectedProviderInstanceId)
      ];
    const modelSelection = buildModelSelection(
      selectedProvider,
      selectedModel,
      storedSelection?.options,
      selectedProvider === "claudeAgent"
        ? (runtimeModelForCapabilities?.supportsAutoMode ?? selectedModelSupportsAutoMode)
        : undefined,
      { instanceId: selectedProviderInstanceId },
    );
    // A to-do without a project picks up the one it was delegated into.
    const adoptsProject = todo.projectId === null && target.kind === "project";
    let linked = true;
    let created: Awaited<ReturnType<typeof createAndDispatchDraftThread>>;
    // The new chat copies the scratch draft (traits and all) rather than `prompt`.
    useComposerDraftStore.getState().setPrompt(scratchThreadId, prompt);
    try {
      created = await createAndDispatchDraftThread({
        projectId,
        prompt,
        sourceComposerThreadId: scratchThreadId,
        modelSelection,
        runtimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        envMode: "local",
        workingDirectory: target.kind === "folder" ? target.path : null,
        defaultProvider: settings.defaultProvider,
        assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
        providerOptions: getProviderStartOptions(settings, selectedProviderInstanceId),
        providerInstances: getProviderInstanceOptions(settings),
        beforeDispatch: async (newThreadId) => {
          linked = await linkChat({
            id: todo.id,
            threadId: newThreadId,
            expectedThreadId: todo.threadId,
            ...(adoptsProject ? { projectId } : {}),
          });
          // Throwing makes createAndDispatchDraftThread drop the draft unsent.
          if (!linked) throw new Error("The task could not be linked to the chat.");
        },
      });
    } catch (error) {
      if (!linked) return false;
      throw error;
    }
    const { threadId, result } = created;
    const agentLabel =
      modelOptionsByProvider[selectedProvider].find((option) => option.slug === selectedModel)
        ?.name ?? selectedModel;
    const started = reportResult(result, threadId, agentLabel);
    if (!started) {
      useComposerDraftStore.getState().clearDraftThread(threadId);
      await unlinkChat(threadId, adoptsProject);
    }
    return started;
  };

  const canStart =
    !isStarting && (existingChat !== null || (target !== null && selectedModel !== null));

  const handleStart = async () => {
    if (!canStart || isStartingRef.current) return;
    const prompt = readPrompt();
    if (prompt.trim().length === 0) return;
    isStartingRef.current = true;
    setIsStarting(true);
    try {
      const started = existingChat
        ? await startInExistingChat(existingChat, prompt)
        : await startInNewChat(prompt);
      if (started) onDelegated?.();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't delegate the task",
        description: error instanceof Error ? error.message : "Unexpected error.",
      });
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
    }
  };

  return { isStarting, canStart, handleStart };
}
