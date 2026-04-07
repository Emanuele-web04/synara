import {
  type ModelSelection,
  type OrchestrationReadModel,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderNativeCommandDescriptor,
  type ProviderModelOptions,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveAssociatedWorktreeMetadata } from "@t3tools/shared/threadWorkspace";
import { useCallback, useState } from "react";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import type { Project, Thread } from "../types";
import type { ComposerTrigger } from "../composer-logic";
import {
  buildSlashReviewComposerPrompt,
  buildSubagentsPrompt,
  getAvailableComposerSlashCommands,
  hasProviderNativeSlashCommand,
  parseComposerSlashInvocationForCommands,
  parseFastSlashCommandAction,
  parseForkSlashCommandArgs,
  type ForkSlashCommandTarget,
} from "../composerSlashCommands";
import { buildThreadHandoffImportedMessages } from "../lib/threadHandoff";
import { toastManager } from "../components/ui/toast";
import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";
import { buildNextProviderOptions } from "../providerModelOptions";
import { resolveForkThreadEnvironment } from "../lib/threadEnvironment";

type ComposerSnapshot = {
  value: string;
  cursor: number;
  expandedCursor: number;
};

type SlashCommandItem = Extract<ComposerCommandItem, { type: "slash-command" }>;

export function useComposerSlashCommands(input: {
  activeProject: Project | undefined;
  activeThread: Thread | undefined;
  activeRootBranch: string | null;
  isServerThread: boolean;
  supportsFastSlashCommand: boolean;
  supportsTextNativeReviewCommand: boolean;
  fastModeEnabled: boolean;
  providerNativeCommands: readonly ProviderNativeCommandDescriptor[];
  providerCommandDiscoveryCwd: string | null;
  selectedProvider: ProviderKind;
  currentProviderModelOptions: ProviderModelOptions[ProviderKind] | undefined;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  threadId: ThreadId;
  syncServerReadModel: (snapshot: OrchestrationReadModel) => void;
  navigateToThread: (threadId: ThreadId) => Promise<void>;
  handleClearConversation: () => Promise<void> | void;
  handleInteractionModeChange: (mode: "default" | "plan") => Promise<void> | void;
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
      options?: { expectedText?: string },
    ) => boolean;
    extendReplacementRangeForTrailingSpace: (
      text: string,
      rangeEnd: number,
      replacement: string,
    ) => number;
    clearComposerSlashDraft: () => void;
    setComposerPromptValue: (nextPrompt: string) => void;
    scheduleComposerFocus: () => void;
    setComposerHighlightedItemId: (id: string | null) => void;
  };
}) {
  const [isSlashStatusDialogOpen, setIsSlashStatusDialogOpen] = useState(false);
  const providerNativeCommandNames = (input.providerNativeCommands ?? []).map(
    (command) => command.name,
  );
  const availableBuiltInSlashCommands = getAvailableComposerSlashCommands({
    provider: input.selectedProvider,
    supportsFastSlashCommand: input.supportsFastSlashCommand,
    canOfferReviewCommand: true,
    canOfferForkCommand: true,
    providerNativeCommandNames,
  });

  const setFastModeFromSlashCommand = useCallback(
    (enabled: boolean) => {
      input.setComposerDraftProviderModelOptions(
        input.threadId,
        input.selectedProvider,
        buildNextProviderOptions(input.selectedProvider, input.currentProviderModelOptions, {
          fastMode: enabled,
        }),
        {
          persistSticky: true,
        },
      );
    },
    [
      input.currentProviderModelOptions,
      input.selectedProvider,
      input.setComposerDraftProviderModelOptions,
      input.threadId,
    ],
  );

  const runFastSlashCommand = useCallback(
    (text: string) => {
      const action = parseFastSlashCommandAction(text);
      if (action === null) {
        return false;
      }
      if (!input.supportsFastSlashCommand) {
        toastManager.add({
          type: "warning",
          title: "Fast mode is unavailable",
          description: "The selected model does not support Fast mode.",
        });
        return true;
      }
      if (action === "invalid") {
        toastManager.add({
          type: "warning",
          title: "Invalid /fast command",
          description: "Use /fast, /fast on, /fast off, or /fast status.",
        });
        return true;
      }
      if (action === "status") {
        toastManager.add({
          type: "info",
          title: `Fast mode is ${input.fastModeEnabled ? "on" : "off"}`,
        });
        return true;
      }
      const nextEnabled =
        action === "on" ? true : action === "off" ? false : !input.fastModeEnabled;
      setFastModeFromSlashCommand(nextEnabled);
      toastManager.add({
        type: "success",
        title: `Fast mode ${nextEnabled ? "enabled" : "disabled"}`,
      });
      return true;
    },
    [input.fastModeEnabled, input.supportsFastSlashCommand, setFastModeFromSlashCommand],
  );

  const createForkThreadFromSlashCommand = useCallback(
    async (inputOptions?: { target?: ForkSlashCommandTarget }) => {
      const api = readNativeApi();
      if (!api || !input.activeProject || !input.activeThread || !input.isServerThread) {
        toastManager.add({
          type: "warning",
          title: "Fork is unavailable",
          description: "Only existing server-backed threads can be forked right now.",
        });
        return true;
      }

      const importedMessages = buildThreadHandoffImportedMessages(input.activeThread);

      const nextThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      // Fork first, then let the normal first-send worktree bootstrap create the cwd if needed.
      const resolvedTarget = resolveForkThreadEnvironment({
        target: inputOptions?.target ?? "local",
        activeRootBranch: input.activeRootBranch,
        sourceThread: input.activeThread,
      });

      await api.orchestration.dispatchCommand({
        type: "thread.fork.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        sourceThreadId: input.activeThread.id,
        projectId: input.activeProject.id,
        title: input.activeThread.title,
        modelSelection: input.selectedModelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        envMode: resolvedTarget.envMode,
        branch: resolvedTarget.branch,
        worktreePath: resolvedTarget.worktreePath,
        associatedWorktreePath: resolvedTarget.associatedWorktreePath,
        associatedWorktreeBranch: resolvedTarget.associatedWorktreeBranch,
        associatedWorktreeRef: resolvedTarget.associatedWorktreeRef,
        importedMessages: [...importedMessages],
        createdAt,
      });
      const snapshot = await api.orchestration.getSnapshot();
      input.syncServerReadModel(snapshot);
      await input.navigateToThread(nextThreadId);
      return true;
    },
    [
      input.activeProject,
      input.activeRootBranch,
      input.activeThread,
      input.interactionMode,
      input.isServerThread,
      input.navigateToThread,
      input.runtimeMode,
      input.selectedModelSelection,
      input.syncServerReadModel,
    ],
  );

  const runCodexReviewStart = useCallback(
    async (target: "changes" | "base-branch") => {
      const api = readNativeApi();
      if (!api || !input.isServerThread || !input.activeThread || !input.activeProject) {
        toastManager.add({
          type: "warning",
          title: "Review is unavailable",
          description: "Only existing server-backed threads can start a native review right now.",
        });
        return false;
      }

      if (target === "base-branch" && !input.activeRootBranch) {
        toastManager.add({
          type: "warning",
          title: "Base branch unavailable",
          description: "Select or detect a base branch before starting this review.",
        });
        return false;
      }

      const messageText =
        target === "base-branch" && input.activeRootBranch
          ? `Review against base branch ${input.activeRootBranch}`
          : "Review current changes";

      const nextThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const nextThreadTitle =
        target === "base-branch"
          ? `${input.activeThread.title} Review`
          : `${input.activeThread.title} Review`;
      const associatedWorktree = deriveAssociatedWorktreeMetadata({
        branch: input.activeThread.branch,
        worktreePath: input.activeThread.worktreePath,
        associatedWorktreePath: input.activeThread.associatedWorktreePath ?? null,
        associatedWorktreeBranch: input.activeThread.associatedWorktreeBranch ?? null,
        associatedWorktreeRef: input.activeThread.associatedWorktreeRef ?? null,
      });

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: nextThreadId,
          projectId: input.activeProject.id,
          title: nextThreadTitle,
          modelSelection: input.selectedModelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          envMode:
            input.activeThread.envMode ?? (input.activeThread.worktreePath ? "worktree" : "local"),
          branch: input.activeThread.branch,
          worktreePath: input.activeThread.worktreePath,
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
          modelSelection: input.selectedModelSelection,
          reviewTarget:
            target === "base-branch"
              ? {
                  type: "baseBranch",
                  branch: input.activeRootBranch!,
                }
              : {
                  type: "uncommittedChanges",
                },
          dispatchMode: "queue",
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          createdAt,
        });
        const snapshot = await api.orchestration.getSnapshot();
        input.syncServerReadModel(snapshot);
        await input.navigateToThread(nextThreadId);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not start review",
          description:
            error instanceof Error ? error.message : "An error occurred while starting review.",
        });
        return false;
      }
    },
    [
      input.activeProject,
      input.activeRootBranch,
      input.activeThread,
      input.interactionMode,
      input.isServerThread,
      input.navigateToThread,
      input.runtimeMode,
      input.selectedModelSelection,
      input.syncServerReadModel,
      input.threadId,
    ],
  );

  const handleReviewTargetSelection = useCallback(
    async (target: "changes" | "base-branch") => {
      if (input.selectedProvider === "codex") {
        await runCodexReviewStart(target);
      } else {
        const replacement = buildSlashReviewComposerPrompt(target === "base-branch" ? "base" : "");
        input.editorActions.setComposerPromptValue(replacement);
      }
      input.editorActions.scheduleComposerFocus();
    },
    [input.editorActions, input.selectedProvider, runCodexReviewStart],
  );

  const handleForkTargetSelection = useCallback(
    async (target: ForkSlashCommandTarget) => {
      try {
        await createForkThreadFromSlashCommand({ target });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not fork thread",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while creating the forked thread.",
        });
      }
    },
    [createForkThreadFromSlashCommand],
  );

  const checkClaudeFastSlashCommandAvailability = useCallback(async (): Promise<boolean> => {
    const api = readNativeApi();
    if (!api || !input.providerCommandDiscoveryCwd) {
      input.editorActions.clearComposerSlashDraft();
      toastManager.add({
        type: "warning",
        title: "Fast mode could not be checked",
        description: "Claude command discovery is unavailable right now.",
      });
      return false;
    }

    try {
      const result = await api.provider.listCommands({
        provider: "claudeAgent",
        cwd: input.providerCommandDiscoveryCwd,
        threadId: input.threadId,
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
      input.editorActions.clearComposerSlashDraft();
      toastManager.add({
        type: "warning",
        title: "Fast mode could not be checked",
        description: "Claude command discovery failed. Please try again.",
      });
      return false;
    }

    input.editorActions.clearComposerSlashDraft();
    toastManager.add({
      type: "info",
      title: "Fast mode is unavailable",
      description: "Claude did not expose /fast for this account or environment.",
    });
    return false;
  }, [input.editorActions, input.providerCommandDiscoveryCwd, input.threadId]);

  const handleStandaloneSlashCommand = useCallback(
    async (trimmed: string): Promise<boolean> => {
      const fastSlashAction = parseFastSlashCommandAction(trimmed);
      if (input.selectedProvider === "claudeAgent" && fastSlashAction !== null) {
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
      if (slashInvocation.command === "clear") {
        input.editorActions.clearComposerSlashDraft();
        await input.handleClearConversation();
        return true;
      }
      if (slashInvocation.command === "plan" || slashInvocation.command === "default") {
        await input.handleInteractionModeChange(
          slashInvocation.command === "plan" ? "plan" : "default",
        );
        input.editorActions.clearComposerSlashDraft();
        return true;
      }
      if (slashInvocation.command === "status") {
        input.editorActions.clearComposerSlashDraft();
        setIsSlashStatusDialogOpen(true);
        return true;
      }
      if (slashInvocation.command === "subagents") {
        input.editorActions.setComposerPromptValue(buildSubagentsPrompt(slashInvocation.args));
        return true;
      }
      if (slashInvocation.command === "review") {
        if (input.selectedProvider === "codex") {
          const normalizedArgs = slashInvocation.args.trim().toLowerCase();
          if (normalizedArgs.length === 0) {
            input.editorActions.clearComposerSlashDraft();
            input.openReviewTargetPicker();
            return true;
          }
          const target =
            normalizedArgs === "base" || normalizedArgs.startsWith("base ") ? "base-branch" : null;
          if (!target) {
            toastManager.add({
              type: "warning",
              title: "Invalid /review command",
              description: "Use /review and then choose a review target.",
            });
            return true;
          }
          input.editorActions.clearComposerSlashDraft();
          await runCodexReviewStart(target);
          return true;
        }
        if (input.supportsTextNativeReviewCommand && slashInvocation.args.length === 0) {
          return false;
        }
        if (slashInvocation.args.length === 0) {
          input.editorActions.clearComposerSlashDraft();
          input.openReviewTargetPicker();
          return true;
        }
        input.editorActions.setComposerPromptValue(
          buildSlashReviewComposerPrompt(slashInvocation.args),
        );
        return true;
      }
      if (slashInvocation.command === "fast") {
        input.editorActions.clearComposerSlashDraft();
        runFastSlashCommand(trimmed);
        return true;
      }
      if (slashInvocation.command === "fork") {
        const { target, invalid } = parseForkSlashCommandArgs(slashInvocation.args);
        if (invalid) {
          toastManager.add({
            type: "warning",
            title: "Invalid /fork command",
            description: "Use /fork and then choose Local or New Worktree.",
          });
          return true;
        }
        try {
          if (!target) {
            input.editorActions.clearComposerSlashDraft();
            input.openForkTargetPicker();
            return true;
          }
          await createForkThreadFromSlashCommand({
            target,
          });
          input.editorActions.clearComposerSlashDraft();
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not fork thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the forked thread.",
          });
        }
        return true;
      }
      return false;
    },
    [
      availableBuiltInSlashCommands,
      checkClaudeFastSlashCommandAvailability,
      createForkThreadFromSlashCommand,
      input.editorActions,
      input.handleClearConversation,
      input.handleInteractionModeChange,
      input.openForkTargetPicker,
      input.openReviewTargetPicker,
      input.selectedProvider,
      input.supportsTextNativeReviewCommand,
      runCodexReviewStart,
      runFastSlashCommand,
    ],
  );

  const handleSlashCommandSelection = useCallback(
    (item: SlashCommandItem) => {
      const { snapshot, trigger } = input.editorActions.resolveActiveComposerTrigger();
      if (!trigger) {
        return;
      }

      if (item.command === "model") {
        const replacement = "/model ";
        const replacementRangeEnd = input.editorActions.extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = input.editorActions.applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          input.editorActions.setComposerHighlightedItemId(null);
        }
        return;
      }

      const clearSlashCommandFromComposer = () =>
        input.editorActions.applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });

      if (item.command === "clear") {
        const applied = clearSlashCommandFromComposer();
        if (applied) {
          input.editorActions.setComposerHighlightedItemId(null);
        }
        void input.handleClearConversation();
        return;
      }

      if (item.command === "plan" || item.command === "default") {
        void input.handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = clearSlashCommandFromComposer();
        if (applied) {
          input.editorActions.setComposerHighlightedItemId(null);
        }
        return;
      }

      if (item.command === "subagents") {
        const replacement = buildSubagentsPrompt("");
        const applied = input.editorActions.applyPromptReplacement(
          trigger.rangeStart,
          trigger.rangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd) },
        );
        if (applied) {
          input.editorActions.setComposerHighlightedItemId(null);
        }
        return;
      }

      if (item.command === "status") {
        const applied = clearSlashCommandFromComposer();
        if (applied) {
          input.editorActions.setComposerHighlightedItemId(null);
          setIsSlashStatusDialogOpen(true);
          input.editorActions.scheduleComposerFocus();
        }
        return;
      }

      if (item.command === "fast") {
        const applied = clearSlashCommandFromComposer();
        if (!applied) {
          return;
        }
        input.editorActions.setComposerHighlightedItemId(null);
        void runFastSlashCommand("/fast");
        input.editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "review") {
        if (input.supportsTextNativeReviewCommand) {
          const replacement = "/review";
          const replacementRangeEnd = input.editorActions.extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = input.editorActions.applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            input.editorActions.setComposerHighlightedItemId(null);
          }
          return;
        }
        const applied = clearSlashCommandFromComposer();
        if (!applied) {
          return;
        }
        input.editorActions.setComposerHighlightedItemId(null);
        input.openReviewTargetPicker();
        input.editorActions.scheduleComposerFocus();
        return;
      }

      if (item.command === "fork") {
        const applied = clearSlashCommandFromComposer();
        if (!applied) {
          return;
        }
        input.editorActions.setComposerHighlightedItemId(null);
        input.openForkTargetPicker();
        input.editorActions.scheduleComposerFocus();
      }
    },
    [
      createForkThreadFromSlashCommand,
      input.editorActions,
      input.handleClearConversation,
      input.fastModeEnabled,
      input.handleInteractionModeChange,
      input.openForkTargetPicker,
      input.openReviewTargetPicker,
      input.selectedProvider,
      input.supportsTextNativeReviewCommand,
      runCodexReviewStart,
      runFastSlashCommand,
    ],
  );

  return {
    handleForkTargetSelection,
    handleReviewTargetSelection,
    isSlashStatusDialogOpen,
    setIsSlashStatusDialogOpen,
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
  };
}
