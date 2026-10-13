import {
  PROVIDER_DISPLAY_NAMES,
  THREAD_GOAL_MAX_CHARS,
  type MessageId,
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderNativeCommandDescriptor,
  type ProviderModelOptions,
  type RuntimeMode,
  type ThreadId,
} from "@synara/contracts";
import { deriveAssociatedWorktreeMetadata } from "@synara/shared/threadWorkspace";
import { useCallback, useEffect, useRef, useState } from "react";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import type { Project, Thread } from "../types";
import type { ComposerTrigger } from "../composer-logic";
import { extendReplacementRangeForTrailingSpace } from "../composerTriggerInsertion";
import {
  buildGoalSlashCommandPrompt,
  buildSlashReviewComposerPrompt,
  buildSubagentsPrompt,
  getAvailableComposerSlashCommands,
  hasProviderNativeSlashCommand,
  parseComposerSlashInvocationForCommands,
  parseFastSlashCommandAction,
  parseForkSlashCommandArgs,
  parseGoalSlashCommandArgs,
  parseSideSlashCommandArgs,
  type ForkSlashCommandTarget,
} from "../composerSlashCommands";
import { resolveThreadHandoffModelSelection } from "../lib/threadHandoff";
import { toastManager } from "../components/ui/toast";
import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";
import { buildNextProviderOptions } from "../providerModelOptions";
import { dispatchThreadFork } from "../lib/threadFork";
import { type SplitViewId } from "../splitViewStore";
import { useRightDockStore } from "../rightDockStore";
import { registerSidechatCreator } from "../lib/sidechatCreatorRegistry";
import { downloadUrlAsBlob } from "../lib/browserDownload";
import { resolveWsHttpUrl } from "../lib/wsHttpUrl";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { dispatchThreadGoal, dispatchThreadGoalPaused } from "../threadGoal";
import {
  buildDraftThreadRenameCreateInput,
  dispatchThreadRename,
  dispatchThreadTitleRegeneration,
} from "../lib/threadRename";
import {
  createOrJoinSidechat,
  createSidechatThread,
  sendSidechatPrompt,
  type SidechatCreationFlight,
} from "../lib/sidechatCreation";
import { isSidechatThread } from "@synara/shared/sidechatThread";
import { useTranslation } from "~/i18n";

type ComposerSnapshot = {
  value: string;
  cursor: number;
  expandedCursor: number;
};

type SlashCommandItem = Extract<ComposerCommandItem, { type: "slash-command" }>;

function wasPromptReplacementApplied(result: number | false): boolean {
  return result !== false;
}

export function useComposerSlashCommands(input: {
  activeProject: Project | undefined;
  activeThread: Thread | undefined;
  activeRootBranch: string | null;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  supportsFastSlashCommand: boolean;
  canOfferCompactCommand: boolean;
  canExecuteSideCommand: boolean;
  sidechatTargetProviders: ReadonlyArray<ProviderKind>;
  canOfferExportCommand: boolean;
  supportsTextNativeReviewCommand: boolean;
  fastModeEnabled: boolean;
  providerNativeCommands: readonly ProviderNativeCommandDescriptor[];
  providerCommandDiscoveryCwd: string | null;
  selectedProvider: ProviderKind;
  currentProviderModelOptions: ProviderModelOptions[ProviderKind] | undefined;
  selectedModelSelection: ModelSelection;
  environmentMode: string | null;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  threadId: ThreadId;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  navigateToThread: (threadId: ThreadId, options?: { splitViewId?: SplitViewId }) => Promise<void>;
  handleClearConversation: () => Promise<void> | void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => Promise<void> | void;
  openForkTargetPicker: () => void;
  openReviewTargetPicker: () => void;
  setComposerDraftProviderModelOptions: (
    threadId: ThreadId,
    provider: ProviderKind,
    nextProviderOptions: ProviderModelOptions[ProviderKind],
    options?: { persistSticky?: boolean },
  ) => void;
  editorActions: {
    resolveActiveComposerTrigger: () => {
      snapshot: ComposerSnapshot;
      trigger: ComposerTrigger | null;
    };
    applyPromptReplacement: (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; cursorOffset?: number },
    ) => number | false;
    clearComposerSlashDraft: () => void;
    setComposerPromptValue: (nextPrompt: string) => void;
    scheduleComposerFocus: () => void;
    setComposerHighlightedItemId: (id: string | null) => void;
  };
}) {
  const { t, formatLocale } = useTranslation();

  const [isSlashStatusDialogOpen, setIsSlashStatusDialogOpen] = useState(false);
  const openGlobalFeedbackDialog = useFeedbackDialogStore((state) => state.openDialog);
  const {
    activeProject,
    activeThread,
    activeRootBranch,
    isServerThread,
    isLocalDraftThread,
    supportsFastSlashCommand,
    canOfferCompactCommand,
    canExecuteSideCommand,
    sidechatTargetProviders,
    canOfferExportCommand,
    supportsTextNativeReviewCommand,
    fastModeEnabled,
    providerNativeCommands,
    providerCommandDiscoveryCwd,
    selectedProvider,
    currentProviderModelOptions,
    selectedModelSelection,
    environmentMode,
    runtimeMode,
    interactionMode,
    threadId,
    syncServerShellSnapshot,
    navigateToThread,
    handleClearConversation,
    handleInteractionModeChange,
    openForkTargetPicker,
    openReviewTargetPicker,
    setComposerDraftProviderModelOptions,
    editorActions,
  } = input;
  const providerNativeCommandNames = providerNativeCommands.map((command) => command.name);
  const availableBuiltInSlashCommands = getAvailableComposerSlashCommands({
    provider: selectedProvider,
    supportsFastSlashCommand,
    canOfferCompactCommand,
    canOfferReviewCommand: true,
    canOfferForkCommand: true,
    canOfferSideCommand: true,
    canOfferExportCommand,
    providerNativeCommandNames,
  });

  const compactProviderThread = useCallback(async (): Promise<boolean> => {
    const api = readNativeApi();
    if (
      !api ||
      !canOfferCompactCommand ||
      !isServerThread ||
      !activeThread?.session ||
      activeThread.session.status === "closed"
    ) {
      toastManager.add({
        type: "warning",
        title: t("Compact is unavailable"),
        description: t("Open an active supported server thread before compacting context."),
      });
      return false;
    }

    try {
      void api.provider
        .compactThread({
          threadId: activeThread.id,
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: t("Could not compact thread"),
            description:
              error instanceof Error
                ? error.message
                : t("An error occurred while compacting context."),
          });
        });
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("Could not compact thread"),
        description:
          error instanceof Error ? error.message : t("An error occurred while compacting context."),
      });
      return false;
    }
  }, [activeThread, canOfferCompactCommand, isServerThread, t]);

  const setFastModeFromSlashCommand = useCallback(
    (enabled: boolean) => {
      setComposerDraftProviderModelOptions(
        threadId,
        selectedProvider,
        buildNextProviderOptions(selectedProvider, currentProviderModelOptions, {
          fastMode: enabled,
        }),
        {
          persistSticky: true,
        },
      );
    },
    [currentProviderModelOptions, selectedProvider, setComposerDraftProviderModelOptions, threadId],
  );

  const runFastSlashCommand = useCallback(
    (text: string) => {
      const action = parseFastSlashCommandAction(text);
      if (action === null) {
        return false;
      }
      if (!supportsFastSlashCommand) {
        toastManager.add({
          type: "warning",
          title: t("Fast mode is unavailable"),
          description: t("The selected model does not support Fast mode."),
        });
        return true;
      }
      if (action === "invalid") {
        toastManager.add({
          type: "warning",
          title: t("Invalid /fast command"),
          description: t("Use /fast, /fast on, /fast off, or /fast status."),
        });
        return true;
      }
      if (action === "status") {
        toastManager.add({
          type: "info",
          title: fastModeEnabled ? t("Fast mode is on") : t("Fast mode is off"),
        });
        return true;
      }
      const nextEnabled = action === "on" ? true : action === "off" ? false : !fastModeEnabled;
      setFastModeFromSlashCommand(nextEnabled);
      toastManager.add({
        type: "success",
        title: nextEnabled ? t("Fast mode enabled") : t("Fast mode disabled"),
      });
      return true;
    },
    [fastModeEnabled, supportsFastSlashCommand, setFastModeFromSlashCommand, t],
  );

  const persistThreadGoal = useCallback(
    async (goal: string): Promise<boolean> => {
      if (!isServerThread && activeThread) {
        // Draft threads have no server row yet: stage the goal locally so the
        // header shows it immediately, then the first send persists it right
        // after `thread.create` promotes the draft.
        const draftStore = useComposerDraftStore.getState();
        if (draftStore.getDraftThread(activeThread.id)) {
          draftStore.setDraftThreadContext(activeThread.id, { goal });
          return true;
        }
      }
      if (!isServerThread || !activeThread) {
        toastManager.add({
          type: "warning",
          title: t("Thread goal is unavailable"),
          description: t("Open a thread before setting a goal."),
        });
        return false;
      }

      try {
        await dispatchThreadGoal(activeThread.id, goal);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("Could not update thread goal"),
          description:
            error instanceof Error
              ? error.message
              : t("An error occurred while updating the goal."),
        });
        return false;
      }
    },
    [activeThread, isServerThread, t],
  );

  const clearThreadGoal = useCallback(async () => {
    if (await persistThreadGoal("")) {
      toastManager.add({ type: "success", title: t("Thread goal cleared") });
    }
  }, [persistThreadGoal, t]);

  const setThreadGoalPaused = useCallback(
    async (paused: boolean): Promise<boolean> => {
      if (!isServerThread || !activeThread) {
        return false;
      }
      try {
        await dispatchThreadGoalPaused(activeThread.id, paused);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: paused
            ? t("Could not pause the thread goal")
            : t("Could not resume the thread goal"),
          description:
            error instanceof Error
              ? error.message
              : t("An error occurred while updating the goal."),
        });
        return false;
      }
    },
    [activeThread, isServerThread, t],
  );

  const runGoalSlashCommand = useCallback(
    async (args: string) => {
      const action = parseGoalSlashCommandArgs(args);
      if (action.action === "show") {
        const currentGoal = activeThread?.goal?.trim();
        toastManager.add(
          currentGoal
            ? { type: "info", title: t("Thread goal"), description: currentGoal }
            : { type: "info", title: t("No thread goal is set") },
        );
        return;
      }
      if (action.action === "too-long") {
        toastManager.add({
          type: "warning",
          title: t("Thread goal is too long"),
          description: t("Keep the goal within {{value0}} characters.", {
            value0: THREAD_GOAL_MAX_CHARS.toLocaleString(formatLocale),
          }),
        });
        return;
      }
      if (action.action === "clear") {
        await clearThreadGoal();
        return;
      }
      if (action.action === "pause" || action.action === "resume") {
        const paused = action.action === "pause";
        if (await setThreadGoalPaused(paused)) {
          toastManager.add({
            type: "success",
            title: paused ? t("Thread goal paused") : t("Thread goal resumed"),
          });
        }
        return;
      }
      if (action.action === "edit") {
        const currentGoal = activeThread?.goal?.trim() ?? "";
        editorActions.setComposerPromptValue(buildGoalSlashCommandPrompt(currentGoal));
        editorActions.scheduleComposerFocus();
        return;
      }
      if (await persistThreadGoal(action.goal)) {
        toastManager.add({ type: "success", title: t("Thread goal updated") });
      }
    },
    [
      activeThread?.goal,
      clearThreadGoal,
      editorActions,
      persistThreadGoal,
      setThreadGoalPaused,
      t,
      formatLocale,
    ],
  );

  const runRenameSlashCommand = useCallback(
    async (args: string) => {
      if (!activeThread) {
        toastManager.add({
          type: "warning",
          title: t("Rename is unavailable"),
          description: t("Open a thread before renaming it."),
        });
        return;
      }
      if (args.length > 0) {
        if (!isServerThread && !isLocalDraftThread) {
          toastManager.add({ type: "warning", title: t("Rename is unavailable") });
          return;
        }
        const outcome = await dispatchThreadRename({
          threadId: activeThread.id,
          newTitle: args,
          unchangedTitles: [],
          createIfMissing: isLocalDraftThread
            ? buildDraftThreadRenameCreateInput(activeThread)
            : undefined,
        });
        if (outcome === "renamed") {
          toastManager.add({ type: "success", title: t("Thread renamed") });
        } else if (outcome === "unavailable") {
          toastManager.add({ type: "warning", title: t("Rename is unavailable") });
        } else {
          toastManager.add({ type: "info", title: t("Thread title is unchanged") });
        }
        return;
      }

      if (!isServerThread) {
        toastManager.add({
          type: "warning",
          title: t("Nothing to rename yet"),
          description: t("Send a message before generating a thread title."),
        });
        return;
      }

      const outcome = await dispatchThreadTitleRegeneration(activeThread.id);
      if (outcome.status === "renamed") {
        toastManager.add({
          type: "success",
          title: t("Thread renamed"),
          description: outcome.title,
        });
      } else if (outcome.status === "no-context") {
        toastManager.add({
          type: "warning",
          title: t("Nothing to rename yet"),
          description: t("Send a message before generating a thread title."),
        });
      } else if (outcome.status === "stale") {
        toastManager.add({
          type: "info",
          title: t("Newer thread title kept"),
          description: t("The generated title was discarded because the title changed."),
        });
      } else if (outcome.status === "unavailable") {
        toastManager.add({ type: "warning", title: t("Rename is unavailable") });
      } else {
        toastManager.add({ type: "info", title: t("Thread title is unchanged") });
      }
    },
    [activeThread, isLocalDraftThread, isServerThread, t],
  );

  const createForkThreadFromSlashCommand = useCallback(
    async (inputOptions?: {
      target?: ForkSlashCommandTarget;
      /** Fork from a specific turn: imports the transcript up to (and including) this message. */
      throughMessageId?: MessageId | null;
    }) => {
      const api = readNativeApi();
      if (!api || !activeProject || !activeThread || !isServerThread) {
        toastManager.add({
          type: "warning",
          title: t("Fork is unavailable"),
          description: t("Only existing server-backed threads can be forked right now."),
        });
        return true;
      }

      const nextThreadId = await dispatchThreadFork({
        api,
        sourceThread: activeThread,
        target: inputOptions?.target ?? "local",
        rootBranch: activeRootBranch,
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
        throughMessageId: inputOptions?.throughMessageId ?? null,
      });
      const snapshot = await api.orchestration.getShellSnapshot();
      syncServerShellSnapshot(snapshot);
      await navigateToThread(nextThreadId);
      return true;
    },
    [
      activeProject,
      activeRootBranch,
      activeThread,
      interactionMode,
      isServerThread,
      navigateToThread,
      runtimeMode,
      selectedModelSelection,
      syncServerShellSnapshot,
      t,
    ],
  );

  const sidechatCreationByKeyRef = useRef(new Map<string, SidechatCreationFlight>());
  const createSidechatFromSlashCommand = useCallback(
    (inputOptions?: { initialPrompt?: string; targetProvider?: ProviderKind }): Promise<true> => {
      const api = readNativeApi();
      if (
        !api ||
        !activeProject ||
        !activeThread ||
        !isServerThread ||
        // No sidechat of a sidechat, forked or standalone.
        isSidechatThread(activeThread)
      ) {
        toastManager.add({
          type: "warning",
          title: t("Side is unavailable"),
          description: t("Open a server-backed main thread before starting Side."),
        });
        return Promise.resolve(true);
      }

      const targetProvider = inputOptions?.targetProvider ?? null;
      const sidechatModelSelection =
        targetProvider && targetProvider !== selectedModelSelection.provider
          ? resolveThreadHandoffModelSelection({
              sourceThread: activeThread,
              targetProvider,
              projectDefaultModelSelection: activeProject.defaultModelSelection,
              stickyModelSelectionByProvider:
                useComposerDraftStore.getState().stickyModelSelectionByProvider,
            })
          : selectedModelSelection;

      return createOrJoinSidechat({
        inFlightByKey: sidechatCreationByKeyRef.current,
        flightKey: `${activeThread.id}:${sidechatModelSelection.provider}`,
        initialPrompt: inputOptions?.initialPrompt,
        startCreation: (initialPrompt) =>
          createSidechatThread({
            api,
            project: activeProject,
            sourceThread: activeThread,
            selectedModelSelection: sidechatModelSelection,
            runtimeMode,
            initialPrompt,
            openSidechat: (sidechatThreadId) => {
              useRightDockStore.getState().openPane(activeThread.id, {
                kind: "sidechat",
                threadId: sidechatThreadId,
              });
            },
            syncServerShellSnapshot,
          }),
        sendQueuedPrompt: (sidechatThreadId, prompt) =>
          sendSidechatPrompt({
            api,
            threadId: sidechatThreadId,
            selectedModelSelection: sidechatModelSelection,
            runtimeMode:
              useComposerDraftStore.getState().draftsByThreadId[sidechatThreadId]?.runtimeMode ??
              getThreadFromState(useStore.getState(), sidechatThreadId)?.runtimeMode ??
              runtimeMode,
            prompt,
          }),
        onCreationResult: (result) => {
          if (result.promptError) {
            toastManager.add({
              type: "warning",
              title: t("Side chat started without the prompt"),
              description: t(
                "The side chat is open. Send the prompt again when it finishes loading.",
              ),
            });
          } else if (result.snapshotError) {
            toastManager.add({
              type: "warning",
              title: t("Side chat is still syncing"),
              description: t(
                "The fork succeeded and will appear as soon as the thread list refreshes.",
              ),
            });
          }
        },
        onQueuedPromptError: () => {
          toastManager.add({
            type: "warning",
            title: t("Side chat prompt was not sent"),
            description: t(
              "The side chat is open. Send the prompt again when it finishes loading.",
            ),
          });
        },
      });
    },
    [
      activeProject,
      activeThread,
      isServerThread,
      runtimeMode,
      selectedModelSelection,
      syncServerShellSnapshot,
      t,
    ],
  );

  // Publish a stable host capability. Composer drafts, attachments, and modes only
  // affect whether `/side` is offered; they must not make the dock action disappear.
  useEffect(() => {
    if (!activeProject || !activeThread || !isServerThread || isSidechatThread(activeThread)) {
      return;
    }
    return registerSidechatCreator(threadId, createSidechatFromSlashCommand);
  }, [activeProject, activeThread, createSidechatFromSlashCommand, isServerThread, threadId]);

  const runCodexReviewStart = useCallback(
    async (target: "changes" | "base-branch") => {
      const api = readNativeApi();
      if (!api || !activeThread || !activeProject) {
        toastManager.add({
          type: "warning",
          title: t("Review is unavailable"),
          description: t("Open a project thread before starting a native review."),
        });
        return false;
      }

      if (target === "base-branch" && !activeRootBranch) {
        toastManager.add({
          type: "warning",
          title: t("Base branch unavailable"),
          description: t("Select or detect a base branch before starting this review."),
        });
        return false;
      }

      const messageText =
        target === "base-branch" && activeRootBranch
          ? `Review against base branch ${activeRootBranch}`
          : "Review current changes";

      const nextThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const nextThreadTitle =
        target === "base-branch"
          ? t("{{value0}} Review", { value0: activeThread.title })
          : t("{{value0}} Review", { value0: activeThread.title });
      const associatedWorktree = deriveAssociatedWorktreeMetadata({
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        associatedWorktreePath: activeThread.associatedWorktreePath ?? null,
        associatedWorktreeBranch: activeThread.associatedWorktreeBranch ?? null,
        associatedWorktreeRef: activeThread.associatedWorktreeRef ?? null,
      });

      // Hoisted out of the `try` below: React Compiler cannot lower `??`/`?:` inside a try block and
      // would skip this whole hook, so the composer would lose its memoization on every keystroke.
      const nextEnvMode =
        activeThread.envMode ?? (activeThread.worktreePath ? "worktree" : "local");
      const nextWorkingDirectory = activeThread.workingDirectory ?? null;
      const nextLastKnownPr = activeThread.lastKnownPr ?? null;
      const reviewTarget =
        target === "base-branch"
          ? ({ type: "baseBranch", branch: activeRootBranch! } as const)
          : ({ type: "uncommittedChanges" } as const);

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: nextThreadId,
          projectId: activeProject.id,
          title: nextThreadTitle,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode: "default",
          envMode: nextEnvMode,
          branch: activeThread.branch,
          worktreePath: activeThread.worktreePath,
          workingDirectory: nextWorkingDirectory,
          lastKnownPr: nextLastKnownPr,
          ...associatedWorktree,
          createdAt,
        });
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: messageText,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          reviewTarget,
          dispatchMode: "queue",
          runtimeMode,
          interactionMode: "default",
          createdAt,
        });
        const snapshot = await api.orchestration.getShellSnapshot();
        syncServerShellSnapshot(snapshot);
        await navigateToThread(nextThreadId);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("Could not start review"),
          description:
            error instanceof Error ? error.message : t("An error occurred while starting review."),
        });
        return false;
      }
    },
    [
      activeProject,
      activeRootBranch,
      activeThread,
      navigateToThread,
      runtimeMode,
      selectedModelSelection,
      syncServerShellSnapshot,
      t,
    ],
  );

  const handleReviewTargetSelection = useCallback(
    async (target: "changes" | "base-branch") => {
      if (selectedProvider === "codex") {
        await runCodexReviewStart(target);
      } else {
        const replacement = buildSlashReviewComposerPrompt(target === "base-branch" ? "base" : "");
        editorActions.setComposerPromptValue(replacement);
      }
      editorActions.scheduleComposerFocus();
    },
    [editorActions, selectedProvider, runCodexReviewStart],
  );

  const runForkThread = useCallback(
    async (inputOptions: {
      target: ForkSlashCommandTarget;
      throughMessageId?: MessageId | null;
    }) => {
      try {
        await createForkThreadFromSlashCommand(inputOptions);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("Could not fork thread"),
          description:
            error instanceof Error
              ? error.message
              : t("An error occurred while creating the forked thread."),
        });
      }
    },
    [createForkThreadFromSlashCommand, t],
  );

  const handleForkTargetSelection = useCallback(
    async (target: ForkSlashCommandTarget) => {
      await runForkThread({ target });
    },
    [runForkThread],
  );

  // Footer fork action: stays in the current environment (a worktree-backed thread
  // reuses its worktree) and carries the transcript up to the clicked turn.
  const handleForkFromMessage = useCallback(
    (messageId: MessageId) => {
      void runForkThread({ target: "local", throughMessageId: messageId });
    },
    [runForkThread],
  );

  const checkClaudeFastSlashCommandAvailability = useCallback(async (): Promise<boolean> => {
    const api = readNativeApi();
    if (!api || !providerCommandDiscoveryCwd) {
      editorActions.clearComposerSlashDraft();
      toastManager.add({
        type: "warning",
        title: t("Fast mode could not be checked"),
        description: t("Claude command discovery is unavailable right now."),
      });
      return false;
    }

    try {
      const result = await api.provider.listCommands({
        provider: "claudeAgent",
        cwd: providerCommandDiscoveryCwd,
        threadId,
        forceReload: true,
      });
      if (
        hasProviderNativeSlashCommand(
          "claudeAgent",
          result.commands.map((command) => command.name),
          "fast",
        )
      ) {
        return true;
      }
    } catch {
      editorActions.clearComposerSlashDraft();
      toastManager.add({
        type: "warning",
        title: t("Fast mode could not be checked"),
        description: t("Claude command discovery failed. Please try again."),
      });
      return false;
    }

    editorActions.clearComposerSlashDraft();
    toastManager.add({
      type: "info",
      title: t("Fast mode is unavailable"),
      description: t("Claude did not expose /fast for this account or environment."),
    });
    return false;
  }, [editorActions, providerCommandDiscoveryCwd, threadId, t]);

  const runExportSlashCommand = useCallback(() => {
    // Re-validate at call time (mirrors /compact): menu selections and stale
    // highlights can outlive the availability computed at render time.
    if (!canOfferExportCommand) {
      toastManager.add({
        type: "warning",
        title: t("Export is unavailable"),
        description: t(
          "Open a server-backed thread and wait for the current turn to finish before exporting.",
        ),
      });
      return;
    }
    const params = new URLSearchParams({ threadId: threadId });
    void downloadUrlAsBlob({
      url: resolveWsHttpUrl(`/api/thread-export?${params.toString()}`),
      filename: `synara-thread-${threadId}.zip`,
    }).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: t("Could not export thread"),
        description:
          error instanceof Error
            ? error.message
            : t("An error occurred while exporting the thread."),
      });
    });
  }, [canOfferExportCommand, threadId, t]);

  const openFeedbackDialog = useCallback(() => {
    openGlobalFeedbackDialog({
      provider: selectedProvider,
      model: selectedModelSelection.model,
      projectKind: activeProject?.kind ?? null,
      environmentMode,
      runtimeMode,
      interactionMode,
      sessionStatus: activeThread?.session?.status ?? null,
      latestTurnState: activeThread?.latestTurn?.state ?? null,
      messageCount: activeThread?.messages.length ?? 0,
      activityCount: activeThread?.activities.length ?? 0,
      hasPendingApproval: activeThread?.hasPendingApprovals === true,
      hasPendingUserInput: activeThread?.hasPendingUserInput === true,
      hasThreadError: Boolean(activeThread?.error),
    });
  }, [
    activeProject?.kind,
    activeThread,
    environmentMode,
    interactionMode,
    openGlobalFeedbackDialog,
    runtimeMode,
    selectedModelSelection.model,
    selectedProvider,
  ]);

  const handleStandaloneSlashCommand = useCallback(
    async (trimmed: string): Promise<boolean> => {
      const fastSlashAction = parseFastSlashCommandAction(trimmed);
      if (selectedProvider === "claudeAgent" && fastSlashAction !== null) {
        if (await checkClaudeFastSlashCommandAvailability()) {
          return false;
        }
        return true;
      }

      const slashInvocation = parseComposerSlashInvocationForCommands(
        trimmed,
        availableBuiltInSlashCommands,
      );
      if (!slashInvocation || slashInvocation.command === "model") {
        return false;
      }
      if (slashInvocation.command === "computer-use") {
        if (slashInvocation.args) return false; // The normal send freezes one-turn activation.
        toastManager.add({
          type: "info",
          title: t("Add a task after /computer-use"),
          description: t("For example: /computer-use open Calculator and calculate 123 × 45."),
        });
        editorActions.scheduleComposerFocus();
        return true;
      }
      if (slashInvocation.command === "clear") {
        editorActions.clearComposerSlashDraft();
        await handleClearConversation();
        return true;
      }
      if (slashInvocation.command === "compact") {
        editorActions.clearComposerSlashDraft();
        await compactProviderThread();
        return true;
      }
      if (
        slashInvocation.command === "plan" ||
        slashInvocation.command === "debug" ||
        slashInvocation.command === "default"
      ) {
        await handleInteractionModeChange(slashInvocation.command);
        editorActions.clearComposerSlashDraft();
        return true;
      }
      if (slashInvocation.command === "status") {
        editorActions.clearComposerSlashDraft();
        setIsSlashStatusDialogOpen(true);
        return true;
      }
      if (slashInvocation.command === "goal") {
        editorActions.clearComposerSlashDraft();
        await runGoalSlashCommand(slashInvocation.args);
        return true;
      }
      if (slashInvocation.command === "rename") {
        editorActions.clearComposerSlashDraft();
        void runRenameSlashCommand(slashInvocation.args).catch((error) => {
          toastManager.add({
            type: "error",
            title: t("Could not rename thread"),
            description:
              error instanceof Error
                ? error.message
                : t("An error occurred while renaming the thread."),
          });
        });
        return true;
      }
      if (slashInvocation.command === "subagents") {
        editorActions.setComposerPromptValue(buildSubagentsPrompt(slashInvocation.args));
        return true;
      }
      if (slashInvocation.command === "export") {
        editorActions.clearComposerSlashDraft();
        runExportSlashCommand();
        return true;
      }
      if (slashInvocation.command === "feedback") {
        editorActions.clearComposerSlashDraft();
        openFeedbackDialog();
        return true;
      }
      if (slashInvocation.command === "review") {
        if (selectedProvider === "codex") {
          const normalizedArgs = slashInvocation.args.trim().toLowerCase();
          if (normalizedArgs.length === 0) {
            editorActions.clearComposerSlashDraft();
            openReviewTargetPicker();
            return true;
          }
          const target =
            normalizedArgs === "base" || normalizedArgs.startsWith("base ") ? "base-branch" : null;
          if (!target) {
            toastManager.add({
              type: "warning",
              title: t("Invalid /review command"),
              description: t("Use /review and then choose a review target."),
            });
            return true;
          }
          editorActions.clearComposerSlashDraft();
          await runCodexReviewStart(target);
          return true;
        }
        if (supportsTextNativeReviewCommand && slashInvocation.args.length === 0) {
          return false;
        }
        if (slashInvocation.args.length === 0) {
          editorActions.clearComposerSlashDraft();
          openReviewTargetPicker();
          return true;
        }
        editorActions.setComposerPromptValue(buildSlashReviewComposerPrompt(slashInvocation.args));
        return true;
      }
      if (slashInvocation.command === "fast") {
        editorActions.clearComposerSlashDraft();
        runFastSlashCommand(trimmed);
        return true;
      }
      if (slashInvocation.command === "fork") {
        const { target, invalid } = parseForkSlashCommandArgs(slashInvocation.args);
        if (invalid) {
          toastManager.add({
            type: "warning",
            title: t("Invalid /fork command"),
            description: t("Use /fork and then choose Local or New Worktree."),
          });
          return true;
        }
        try {
          if (!target) {
            editorActions.clearComposerSlashDraft();
            openForkTargetPicker();
            return true;
          }
          await createForkThreadFromSlashCommand({
            target,
          });
          editorActions.clearComposerSlashDraft();
        } catch (error) {
          toastManager.add({
            type: "error",
            title: t("Could not fork thread"),
            description:
              error instanceof Error
                ? error.message
                : t("An error occurred while creating the forked thread."),
          });
        }
        return true;
      }
      if (slashInvocation.command === "side") {
        // Execute allows `/side <provider> [prompt]` even though the menu offer still
        // requires an otherwise-empty composer (the args are meaningful prompt text).
        if (!canExecuteSideCommand) {
          toastManager.add({
            type: "warning",
            title: t("Side is unavailable"),
            description: t("Remove composer attachments or context before using /side."),
          });
          return true;
        }
        const { targetProvider, prompt, unavailableProvider } = parseSideSlashCommandArgs(
          slashInvocation.args,
          {
            currentProvider: selectedModelSelection.provider,
            availableTargetProviders: sidechatTargetProviders,
          },
        );
        if (unavailableProvider) {
          toastManager.add({
            type: "warning",
            title: t("{{value0}} is unavailable for Side", {
              value0: PROVIDER_DISPLAY_NAMES[unavailableProvider],
            }),
            description: t("Enable and sign in to that provider, then run /side again."),
          });
          return true;
        }
        // Hoisted out of the `try` below: React Compiler cannot lower `?:` inside
        // a try block and would bail out of compiling this whole hook.
        const sidechatOptions = targetProvider
          ? { initialPrompt: prompt, targetProvider }
          : { initialPrompt: prompt };
        try {
          editorActions.clearComposerSlashDraft();
          await createSidechatFromSlashCommand(sidechatOptions);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: t("Could not start Side"),
            description:
              error instanceof Error ? error.message : t("An error occurred while creating Side."),
          });
        }
        return true;
      }
      return false;
    },
    [
      availableBuiltInSlashCommands,
      canExecuteSideCommand,
      checkClaudeFastSlashCommandAvailability,
      compactProviderThread,
      createForkThreadFromSlashCommand,
      createSidechatFromSlashCommand,
      editorActions,
      handleClearConversation,
      handleInteractionModeChange,
      openForkTargetPicker,
      openFeedbackDialog,
      openReviewTargetPicker,
      selectedProvider,
      selectedModelSelection.provider,
      sidechatTargetProviders,
      supportsTextNativeReviewCommand,
      runCodexReviewStart,
      runExportSlashCommand,
      runFastSlashCommand,
      runGoalSlashCommand,
      runRenameSlashCommand,
      t,
    ],
  );

  const handleSlashCommandSelection = useCallback(
    (item: SlashCommandItem) => {
      const { snapshot, trigger } = editorActions.resolveActiveComposerTrigger();
      if (!trigger) {
        return;
      }

      if (
        item.command === "model" ||
        item.command === "goal" ||
        item.command === "rename" ||
        item.command === "automation"
      ) {
        const replacement = `/${item.command} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = editorActions.applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (wasPromptReplacementApplied(applied)) {
          editorActions.setComposerHighlightedItemId(null);
          if (item.command !== "model") {
            editorActions.scheduleComposerFocus();
          }
        }
        return;
      }

      const clearSlashCommandFromComposer = () =>
        editorActions.applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });

      if (item.command === "clear") {
        const applied = clearSlashCommandFromComposer();
        if (wasPromptReplacementApplied(applied)) {
          editorActions.setComposerHighlightedItemId(null);
        }
        void handleClearConversation();
        return;
      }

      if (item.command === "compact") {
        const applied = clearSlashCommandFromComposer();
        if (!wasPromptReplacementApplied(applied)) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        void compactProviderThread();
        editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "plan" || item.command === "debug" || item.command === "default") {
        void handleInteractionModeChange(item.command);
        const applied = clearSlashCommandFromComposer();
        if (wasPromptReplacementApplied(applied)) {
          editorActions.setComposerHighlightedItemId(null);
        }
        return;
      }

      if (item.command === "subagents") {
        const replacement = buildSubagentsPrompt("");
        const applied = editorActions.applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd) },
        );
        if (wasPromptReplacementApplied(applied)) {
          editorActions.setComposerHighlightedItemId(null);
        }
        return;
      }

      if (item.command === "computer-use") {
        const replacement = "/computer-use ";
        const applied = editorActions.applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd) },
        );
        if (wasPromptReplacementApplied(applied)) {
          editorActions.setComposerHighlightedItemId(null);
          editorActions.scheduleComposerFocus();
        }
        return;
      }

      if (item.command === "status") {
        const applied = clearSlashCommandFromComposer();
        if (wasPromptReplacementApplied(applied)) {
          editorActions.setComposerHighlightedItemId(null);
          setIsSlashStatusDialogOpen(true);
          editorActions.scheduleComposerFocus();
        }
        return;
      }

      if (item.command === "fast") {
        const applied = clearSlashCommandFromComposer();
        if (!wasPromptReplacementApplied(applied)) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        void runFastSlashCommand("/fast");
        editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "export") {
        const applied = clearSlashCommandFromComposer();
        if (!wasPromptReplacementApplied(applied)) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        runExportSlashCommand();
        editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "feedback") {
        const applied = clearSlashCommandFromComposer();
        if (!wasPromptReplacementApplied(applied)) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        openFeedbackDialog();
        return;
      }

      if (item.command === "review") {
        if (selectedProvider === "codex") {
          const applied = clearSlashCommandFromComposer();
          if (!wasPromptReplacementApplied(applied)) {
            return;
          }
          editorActions.setComposerHighlightedItemId(null);
          openReviewTargetPicker();
          editorActions.scheduleComposerFocus();
          return;
        }
        if (supportsTextNativeReviewCommand) {
          const replacement = "/review";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = editorActions.applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (wasPromptReplacementApplied(applied)) {
            editorActions.setComposerHighlightedItemId(null);
          }
          return;
        }
        const applied = clearSlashCommandFromComposer();
        if (!wasPromptReplacementApplied(applied)) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        openReviewTargetPicker();
        editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "fork") {
        const applied = clearSlashCommandFromComposer();
        if (!wasPromptReplacementApplied(applied)) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        openForkTargetPicker();
        editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "side") {
        const applied = clearSlashCommandFromComposer();
        if (!wasPromptReplacementApplied(applied)) {
          return;
        }
        editorActions.setComposerHighlightedItemId(null);
        void createSidechatFromSlashCommand().catch((error) => {
          toastManager.add({
            type: "error",
            title: t("Could not start Side"),
            description:
              error instanceof Error ? error.message : t("An error occurred while creating Side."),
          });
        });
      }
    },
    [
      compactProviderThread,
      createSidechatFromSlashCommand,
      editorActions,
      handleClearConversation,
      handleInteractionModeChange,
      openForkTargetPicker,
      openFeedbackDialog,
      openReviewTargetPicker,
      selectedProvider,
      supportsTextNativeReviewCommand,
      runExportSlashCommand,
      runFastSlashCommand,
      t,
    ],
  );

  return {
    handleForkFromMessage,
    handleForkTargetSelection,
    handleReviewTargetSelection,
    isSlashStatusDialogOpen,
    setIsSlashStatusDialogOpen,
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
    clearThreadGoal,
    setThreadGoalPaused,
  };
}
