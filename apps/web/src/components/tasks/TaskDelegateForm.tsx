// FILE: TaskDelegateForm.tsx
// Purpose: The inspector's "Delegate to an agent" form — hands the to-do to an agent chat.
//          The user picks a new chat (provider/model/effort, project or folder, access)
//          or an existing chat; Start links the chat to the to-do and sends the prompt.
//          Model state rides on a scratch composer draft so the shared composer
//          pickers (real provider icons, effort, fast mode) work unchanged.
// Layer: Tasks UI component
// Exports: TaskDelegateForm

import type { ProjectId, ThreadId, Todo, TodoUpdateInput } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  getProviderStartOptions,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "~/appSettings";
import { RuntimeUsageControls } from "~/components/BranchToolbar";
import { ProjectMenuPicker } from "~/components/ProjectMenuPicker";
import { ProviderIcon } from "~/components/ProviderIcon";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import { SubmitShortcutKbd } from "~/components/ui/kbd";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { useScratchComposerDraft } from "~/hooks/useScratchComposerDraft";
import { useScratchModelCatalog } from "~/hooks/useScratchModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { ensureHomeChatProject } from "~/lib/chatProjects";
import { createAndDispatchDraftThread } from "~/lib/draftThreadCreate";
import { dispatchDraftThread, type DraftThreadDispatchResult } from "~/lib/draftThreadDispatch";
import { ChevronDownIcon, DelegateIcon, FolderIcon, LoaderCircleIcon } from "~/lib/icons";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { composerDraftHasUnsentContent } from "../../composerDraftDomain";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useLatestProjectStore } from "../../latestProjectStore";
import { readNativeApi } from "../../nativeApi";
import { buildModelSelection } from "../../providerModelOptions";
import { useStore } from "../../store";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { useWorkspacePathsStore } from "../../workspacePathsStore";
import { buildDelegationPrompt, folderLabel } from "./tasks.logic";
import { useTodoList } from "./useTodos";

const RECENT_CHAT_LIMIT = 12;

type DelegateTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "folder"; readonly path: string };

export function TaskDelegateForm({
  todo,
  onLinkChat,
  onDelegated,
  onCancel,
}: {
  todo: Todo;
  /** Records the chat on the to-do; runs before anything is sent, and throwing aborts. */
  onLinkChat: (input: TodoUpdateInput) => Promise<unknown>;
  onDelegated?: () => void;
  onCancel?: () => void;
}) {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const projects = useStore((state) => state.projects);
  const threadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const {
    scratchThreadId,
    prompt,
    setPrompt,
    selectedProvider,
    selectedModel,
    selectedProviderModelOptions,
    selectedModelSupportsAutoMode,
    handleProviderModelChange: setScratchProviderModel,
  } = useScratchComposerDraft({
    defaultProvider: settings.defaultProvider,
    initialPrompt: buildDelegationPrompt(todo),
  });

  const userProjects = useMemo(
    () => projects.filter((project) => project.kind === "project"),
    [projects],
  );
  const projectOptions = useMemo(
    () => userProjects.map((project) => ({ id: project.id, name: project.name })),
    [userProjects],
  );
  const [target, setTarget] = useState<DelegateTarget | null>(() => {
    const preferred = [todo.projectId, latestProjectId].find(
      (id) => id !== null && userProjects.some((project) => project.id === id),
    );
    const projectId = preferred ?? userProjects[0]?.id ?? null;
    return projectId ? { kind: "project", projectId } : null;
  });
  const targetProject =
    target?.kind === "project"
      ? (userProjects.find((project) => project.id === target.projectId) ?? null)
      : null;

  const { todos } = useTodoList();
  // A chat already working on another open to-do can't take this one too (the server
  // refuses it as well): both would read that chat's turns as theirs.
  const chatIdsOwnedElsewhere = useMemo(
    () =>
      new Set(
        todos.flatMap((other) =>
          other.id !== todo.id && other.threadId !== null && other.completedAt === null
            ? [other.threadId]
            : [],
        ),
      ),
    [todo.id, todos],
  );
  const recentChats = useMemo(
    () =>
      Object.values(threadSummaryById)
        .filter(
          (thread) =>
            !thread.archivedAt &&
            !thread.parentThreadId &&
            !thread.sidechatSourceThreadId &&
            !chatIdsOwnedElsewhere.has(thread.id),
        )
        .toSorted((left, right) =>
          (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt),
        )
        .slice(0, RECENT_CHAT_LIMIT),
    [chatIdsOwnedElsewhere, threadSummaryById],
  );
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const [existingChatId, setExistingChatId] = useState<ThreadId | null>(null);
  const existingChat = existingChatId ? (threadSummaryById[existingChatId] ?? null) : null;

  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  // Synchronous re-entry guard: a repeated ⌘↵ can land before React flushes isStarting.
  const isStartingRef = useRef(false);

  const {
    modelOptionsByProvider,
    loadingModelProviders,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    selectedRuntimeModel,
    selectedRuntimeAgents,
    runtimeMode,
    setRuntimeMode,
    selectedProviderStatus,
    runtimeModelForCapabilities,
    handleProviderModelChange,
  } = useScratchModelCatalog({
    scratchThreadId,
    selectedProvider,
    selectedModel,
    selectedModelSupportsAutoMode,
    setScratchProviderModel,
    providerStatuses,
    discoveryEnabled: isModelPickerOpen || isTraitsPickerOpen,
    discoveryCwd: resolveProviderDiscoveryCwd({
      activeThreadWorktreePath: null,
      activeProjectCwd: target?.kind === "folder" ? target.path : (targetProject?.cwd ?? null),
      serverCwd: serverConfigQuery.data?.cwd ?? null,
    }),
  });

  // The prompt follows the to-do's title and notes until the user edits it.
  const delegationPrompt = buildDelegationPrompt(todo);
  const seededPromptRef = useRef(delegationPrompt);
  useEffect(() => {
    if (delegationPrompt === seededPromptRef.current) return;
    const current = useComposerDraftStore.getState().draftsByThreadId[scratchThreadId]?.prompt;
    if (current === undefined || current === seededPromptRef.current) {
      seededPromptRef.current = delegationPrompt;
      setPrompt(delegationPrompt);
    }
  }, [delegationPrompt, scratchThreadId, setPrompt]);

  const handleChooseFolder = async () => {
    const path = await readNativeApi()?.dialogs.pickFolder();
    if (path) {
      setTarget({ kind: "folder", path });
    }
  };

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
  // Returns false when linking failed; the mutation already told the user why.
  const linkChat = (input: TodoUpdateInput) =>
    onLinkChat(input).then(
      () => true,
      () => false,
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

  const startInExistingChat = async (chatId: ThreadId) => {
    const thread = threadSummaryById[chatId];
    if (!thread) return false;
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
    composerStore.setPrompt(chatId, prompt);
    const result = await dispatchDraftThread({
      threadId: chatId,
      projectId: thread.projectId,
      thread,
      defaultProvider: settings.defaultProvider,
      assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
      providerOptions: getProviderStartOptions(settings),
    });
    const started = reportResult(result, chatId, thread.title);
    if (!started) {
      // The chat's composer was empty before; don't leave the delegation prompt in it.
      useComposerDraftStore.getState().setPrompt(chatId, "");
      await unlinkChat(chatId, false);
    }
    return started;
  };

  const startInNewChat = async () => {
    if (!target || selectedModel === null) return false;
    const availability = await resolveProviderSendAvailabilityWithRefresh({
      provider: selectedProvider,
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
    const storedSelection = scratch?.modelSelectionByProvider[selectedProvider];
    const modelSelection = buildModelSelection(
      selectedProvider,
      selectedModel,
      storedSelection?.options,
      selectedProvider === "claudeAgent"
        ? (runtimeModelForCapabilities?.supportsAutoMode ?? selectedModelSupportsAutoMode)
        : undefined,
    );
    // A to-do without a project picks up the one it was delegated into.
    const adoptsProject = todo.projectId === null && target.kind === "project";
    let linked = true;
    let created: Awaited<ReturnType<typeof createAndDispatchDraftThread>>;
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
        providerOptions: getProviderStartOptions(settings),
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
    prompt.trim().length > 0 &&
    !isStarting &&
    (existingChat !== null || (target !== null && selectedModel !== null));

  const handleStart = async () => {
    if (!canStart || isStartingRef.current) return;
    isStartingRef.current = true;
    setIsStarting(true);
    try {
      const started = existingChat
        ? await startInExistingChat(existingChat.id)
        : await startInNewChat();
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

  return (
    <div
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void handleStart();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <DelegateIcon className="size-3.5 shrink-0 text-status-merged" />
        <span className="text-ui font-medium text-foreground">Delegate to an agent</span>
      </div>

      <Textarea
        aria-label="Instructions for the agent"
        size="sm"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        className="text-ui"
      />

      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
        <span className="text-ui-sm text-muted-foreground">Chat</span>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="chrome"
                className="w-fit max-w-full justify-start gap-1.5 text-ui-sm"
              />
            }
          >
            {existingChat ? (
              <>
                <ProviderIcon
                  provider={existingChat.modelSelection.provider}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 truncate">{existingChat.title}</span>
              </>
            ) : (
              <span>New chat</span>
            )}
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="start" className="max-w-80 min-w-64">
            <MenuRadioGroup
              value={existingChatId ?? ""}
              onValueChange={(value) => setExistingChatId(value ? (value as ThreadId) : null)}
            >
              <MenuRadioItem value="" closeOnClick>
                New chat
              </MenuRadioItem>
              {recentChats.length > 0 ? (
                <MenuGroup>
                  <MenuGroupLabel>Recent chats</MenuGroupLabel>
                  {recentChats.map((thread) => (
                    <MenuRadioItem key={thread.id} value={thread.id} closeOnClick>
                      <span className="flex min-w-0 items-center gap-2">
                        <ProviderIcon
                          provider={thread.modelSelection.provider}
                          className="size-3.5 shrink-0"
                        />
                        <span className="min-w-0 truncate">{thread.title}</span>
                        <span className="shrink-0 text-ui-xs text-muted-foreground">
                          {projectNameById.get(thread.projectId) ?? ""}
                        </span>
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuGroup>
              ) : null}
            </MenuRadioGroup>
          </ComposerPickerMenuPopup>
        </Menu>

        {existingChat ? null : (
          <>
            <span className="text-ui-sm text-muted-foreground">Model</span>
            <div className="flex min-w-0 items-center gap-1">
              <ProviderModelPicker
                compact
                provider={selectedProvider}
                model={selectedModel ?? ""}
                lockedProvider={null}
                providers={providerStatuses}
                modelOptionsByProvider={modelOptionsByProvider}
                loadingModelProviders={loadingModelProviders}
                discoveryErrorsByProvider={discoveryErrorsByProvider}
                hiddenProviders={settings.hiddenProviders}
                providerOrder={settings.providerOrder}
                onProviderModelChange={handleProviderModelChange}
                onProviderModelRoleSelect={(model, options) =>
                  handleProviderModelChange("omp", model, options)
                }
                open={isModelPickerOpen}
                onOpenChange={setIsModelPickerOpen}
              />
              <TraitsPicker
                provider={selectedProvider}
                threadId={scratchThreadId}
                model={selectedModel}
                runtimeModel={selectedRuntimeModel}
                runtimeModels={runtimeModelsByProvider[selectedProvider]}
                runtimeAgents={selectedRuntimeAgents}
                modelOptions={selectedProviderModelOptions}
                prompt={prompt}
                onPromptChange={setPrompt}
                open={isTraitsPickerOpen}
                onOpenChange={setIsTraitsPickerOpen}
              />
            </div>

            <span className="text-ui-sm text-muted-foreground">Run in</span>
            <div className="flex min-w-0 items-center gap-1">
              <ProjectMenuPicker
                projectOptions={projectOptions}
                selectedProjectId={target?.kind === "project" ? target.projectId : null}
                onProjectIdChange={(projectId) => setTarget({ kind: "project", projectId })}
                closeOnSelect
                trigger={
                  <Button
                    size="xs"
                    variant="chrome"
                    className="min-w-0 max-w-44 justify-start gap-1.5 text-ui-sm"
                  />
                }
              >
                <FolderIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 truncate">
                  {target?.kind === "folder"
                    ? folderLabel(target.path)
                    : (targetProject?.name ?? "Choose a project")}
                </span>
                <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
              </ProjectMenuPicker>
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0 text-ui-sm text-muted-foreground"
                onClick={() => void handleChooseFolder()}
                title={target?.kind === "folder" ? target.path : undefined}
              >
                Folder…
              </Button>
            </div>

            <span className="text-ui-sm text-muted-foreground">Access</span>
            <RuntimeUsageControls
              provider={selectedProvider}
              runtimeModel={runtimeModelForCapabilities}
              providerStatus={selectedProviderStatus}
              runtimeMode={runtimeMode}
              onRuntimeModeChange={setRuntimeMode}
            />
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border pt-3">
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={!canStart}
          onClick={() => void handleStart()}
          className={cn("gap-2", isStarting && "cursor-progress")}
        >
          {isStarting ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
          Start
          <SubmitShortcutKbd className="bg-primary-foreground/15 text-primary-foreground/80" />
        </Button>
      </div>
    </div>
  );
}
