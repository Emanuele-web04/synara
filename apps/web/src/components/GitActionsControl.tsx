// FILE: GitActionsControl.tsx
// Purpose: Render the chat-header git action control, commit dialog, and action toasts.
// Layer: Header action control
// Depends on: git React Query hooks, native shell bridges, and shared picker/menu primitives.

import type { GitStackedAction, GitStatusResult, ThreadId } from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import type { GitPickerMenuItem } from "./GitActionsControl.Glyphs";
import {
  CommitDialog,
  CreateBranchDialog,
  DefaultBranchActionDialog,
} from "./GitActionsControl.Dialogs";
import { GitActionsHeaderControl } from "./GitActionsControl.HeaderControl";
import {
  buildGitActionProgressStages,
  buildGitPickerMenuItems,
  buildMenuItems,
  type GitActionMenuItem,
  type DefaultBranchConfirmableAction,
  requiresFeatureBranchForDefaultBranchAction,
  requiresDefaultBranchConfirmation,
  resolveLiveThreadBranchUpdate,
  resolveDefaultCreateBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveCreatePrActionAvailability,
  resolveQuickAction,
  shouldOfferCreateBranchPrompt,
  summarizeGitResult,
} from "./GitActionsControl.logic";
import { useGitActionProgressToast } from "./GitActionsControl.useProgressToast";
import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import {
  CHAT_HEADER_CONTROL_CLASS_NAME,
  CHAT_HEADER_ICON_STRENGTH_CLASS_NAME,
} from "./chat/chatHeaderControls";
import { toastManager } from "~/components/ui/toast";
import { openInPreferredEditor } from "~/editorPreferences";
import {
  gitBranchesQueryOptions,
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";
import { createThreadSelector } from "~/storeSelectors";
import { useStore } from "~/store";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadId: ThreadId | null;
  variant?: "default" | "environment" | "panel";
  hideQuickActionLabel?: boolean;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  forcePushOnlyProgress: boolean;
  onConfirmed?: () => void;
  filePaths?: string[];
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  forcePushOnlyProgress?: boolean;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: GitStatusResult | null;
  featureBranch?: boolean;
  isDefaultBranchOverride?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
}

export default function GitActionsControl({
  gitCwd,
  activeThreadId,
  variant: _variant,
  hideQuickActionLabel = false,
}: GitActionsControlProps) {
  const { settings } = useAppSettings();
  const providerOptions = useMemo(() => getProviderStartOptions(settings), [settings]);
  const activeThread = useStore(
    useMemo(() => createThreadSelector(activeThreadId), [activeThreadId]),
  );
  const setThreadWorkspaceAction = useStore((store) => store.setThreadWorkspace);
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const [isCreateBranchDialogOpen, setIsCreateBranchDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const { activeGitActionProgressRef, updateActiveProgressToast } = useGitActionProgressToast({
    gitCwd,
    threadToastData,
  });

  const { data: gitStatus = null, error: gitStatusError } = useQuery(gitStatusQueryOptions(gitCwd));

  const { data: branchList = null } = useQuery(gitBranchesQueryOptions(gitCwd));
  // Default to true while loading so we don't flash init controls.
  const isRepo = branchList?.isRepo ?? true;
  const hasOriginRemote = branchList?.hasOriginRemote ?? false;
  const currentBranch = branchList?.branches.find((branch) => branch.current)?.name ?? null;
  const liveThreadBranchUpdate = useMemo(
    () =>
      resolveLiveThreadBranchUpdate({
        threadBranch: currentBranch,
        gitStatus,
      }),
    [currentBranch, gitStatus],
  );
  const isGitStatusOutOfSync = liveThreadBranchUpdate !== null;

  useEffect(() => {
    if (!isGitStatusOutOfSync) return;
    void invalidateGitQueries(queryClient);
  }, [isGitStatusOutOfSync, queryClient]);

  const gitStatusForActions = isGitStatusOutOfSync ? null : gitStatus;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initMutation = useMutation(gitInitMutationOptions({ cwd: gitCwd, queryClient }));

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      cwd: gitCwd,
      queryClient,
      codexHomePath: settings.codexHomePath || null,
      model: settings.textGenerationModel ?? null,
      ...(providerOptions ? { providerOptions } : {}),
    }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ cwd: gitCwd, queryClient }));
  const persistThreadPr = useCallback(
    async (pr: {
      number: number;
      title: string;
      url: string;
      baseBranch: string;
      headBranch: string;
      state: "open" | "closed" | "merged";
    }) => {
      if (!activeThreadId) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: activeThreadId,
        lastKnownPr: pr,
      });
    },
    [activeThreadId],
  );

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd) }) > 0;
  const isPullRunning = useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;
  const isDefaultBranch = useMemo(() => {
    const branchName = gitStatusForActions?.branch;
    if (!branchName) return false;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [branchList?.branches, gitStatusForActions?.branch]);
  const defaultBranchName = useMemo(
    () => branchList?.branches.find((branch) => !branch.isRemote && branch.isDefault)?.name ?? null,
    [branchList?.branches],
  );
  const shouldOfferCreateBranch = useMemo(() => {
    return shouldOfferCreateBranchPrompt({
      activeWorktreePath: activeThread?.worktreePath ?? null,
      gitStatus: gitStatusForActions
        ? {
            branch: gitStatusForActions.branch,
            hasUpstream: gitStatusForActions.hasUpstream,
          }
        : null,
      createBranchFlowCompleted: activeThread?.createBranchFlowCompleted ?? false,
    });
  }, [activeThread?.createBranchFlowCompleted, activeThread?.worktreePath, gitStatusForActions]);
  const currentBranchName =
    gitStatusForActions?.branch ?? currentBranch ?? activeThread?.branch ?? null;
  const existingBranchNames = useMemo(
    () => (branchList?.branches ?? []).map((branch) => branch.name),
    [branchList?.branches],
  );
  const branchNames = useMemo(
    () => new Set(existingBranchNames.map((branchName) => branchName.toLowerCase())),
    [existingBranchNames],
  );
  const suggestedCreateBranchName = useMemo(
    () =>
      resolveDefaultCreateBranchName(
        existingBranchNames,
        activeThread?.associatedWorktreeBranch ?? activeThread?.title,
      ),
    [activeThread?.associatedWorktreeBranch, activeThread?.title, existingBranchNames],
  );

  const quickAction = useMemo(
    () =>
      resolveQuickAction(
        gitStatusForActions,
        isGitActionRunning,
        isDefaultBranch,
        hasOriginRemote,
        shouldOfferCreateBranch,
        defaultBranchName,
      ),
    [
      defaultBranchName,
      gitStatusForActions,
      hasOriginRemote,
      isDefaultBranch,
      isGitActionRunning,
      shouldOfferCreateBranch,
    ],
  );
  const gitActionMenuItems = useMemo(
    () =>
      buildMenuItems(
        gitStatusForActions,
        isGitActionRunning,
        hasOriginRemote,
        isDefaultBranch,
        defaultBranchName,
      ),
    [defaultBranchName, gitStatusForActions, hasOriginRemote, isDefaultBranch, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    });
  }, [gitStatusForActions, threadToastData]);

  const runSyncWithRemote = useCallback(() => {
    const promise = pullMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Syncing with remote...", data: threadToastData },
      success: (result) => ({
        title: result.status === "pulled" ? "Remote synced" : "Already up to date",
        description:
          result.status === "pulled"
            ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
            : `${result.branch} is already synchronized.`,
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Sync failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [pullMutation, threadToastData]);

  const runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      forcePushOnlyProgress = false,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      isDefaultBranchOverride,
      progressToastId,
      filePaths,
    }: RunGitActionWithToastInput) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.branch ?? null;
      const actionIsDefaultBranch =
        isDefaultBranchOverride ?? (featureBranch ? false : isDefaultBranch);
      const includesCommit =
        !forcePushOnlyProgress &&
        action !== "push" &&
        action !== "create_pr" &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges);
      const shouldPushBeforePr =
        action === "create_pr" &&
        (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          forcePushOnlyProgress,
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      if (action === "create_pr" && !featureBranch) {
        const createPrAvailability = resolveCreatePrActionAvailability({
          gitStatus: actionStatus,
          isDefaultBranch: actionIsDefaultBranch,
          hasOriginRemote,
          defaultBranchName,
        });
        if (!createPrAvailability.canRun) {
          toastManager.add({
            type: "info",
            title: "Create PR unavailable",
            description: createPrAvailability.hint ?? "No branch changes to include in a PR.",
            data: threadToastData,
          });
          return;
        }
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        forcePushOnly: forcePushOnlyProgress,
        featureBranch,
        shouldPushBeforePr,
      });
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: threadToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: threadToastData,
        });
      }

      const promise = runImmediateGitActionMutation.mutateAsync({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
      });

      try {
        const result = await promise;
        activeGitActionProgressRef.current = null;
        const resultToast = summarizeGitResult(result);
        const persistedPr =
          result.pr.status === "created" || result.pr.status === "opened_existing"
            ? result.pr.number &&
              result.pr.title &&
              result.pr.url &&
              result.pr.baseBranch &&
              result.pr.headBranch
              ? {
                  number: result.pr.number,
                  title: result.pr.title,
                  url: result.pr.url,
                  baseBranch: result.pr.baseBranch,
                  headBranch: result.pr.headBranch,
                  state: "open" as const,
                }
              : null
            : actionStatus?.pr?.state === "open"
              ? actionStatus.pr
              : null;
        if (persistedPr) {
          void persistThreadPr(persistedPr).catch(() => undefined);
        }

        const existingOpenPrUrl =
          actionStatus?.pr?.state === "open" ? actionStatus.pr.url : undefined;
        const prUrl = result.pr.url ?? existingOpenPrUrl;
        const shouldOfferPushCta = action === "commit" && result.commit.status === "created";
        const shouldOfferOpenPrCta =
          (action === "push" ||
            action === "create_pr" ||
            action === "commit_push" ||
            action === "commit_push_pr") &&
          !!prUrl &&
          (!actionIsDefaultBranch ||
            result.pr.status === "created" ||
            result.pr.status === "opened_existing");
        const postPushStatus = actionStatus
          ? {
              ...actionStatus,
              hasUpstream: true,
              upstreamBranch:
                actionStatus.upstreamBranch ??
                (!actionStatus.hasUpstream ? (result.push.branch ?? actionStatus.branch) : null),
              aheadCount: 0,
            }
          : null;
        const shouldOfferCreatePrCta =
          (action === "push" || action === "commit_push") &&
          !prUrl &&
          result.push.status === "pushed" &&
          !actionIsDefaultBranch &&
          resolveCreatePrActionAvailability({
            gitStatus: postPushStatus,
            isDefaultBranch: actionIsDefaultBranch,
            hasOriginRemote,
            defaultBranchName,
          }).canRun;
        const closeResultToast = () => {
          toastManager.close(resolvedProgressToastId);
        };

        toastManager.update(resolvedProgressToastId, {
          type: "success",
          title: resultToast.title,
          description: resultToast.description,
          timeout: 0,
          data: {
            ...threadToastData,
            dismissAfterVisibleMs: 10_000,
          },
          ...(shouldOfferPushCta
            ? {
                actionProps: {
                  children: "Push",
                  onClick: () => {
                    void runGitActionWithToast({
                      action: "push",
                      onConfirmed: closeResultToast,
                      statusOverride: actionStatus,
                      isDefaultBranchOverride: actionIsDefaultBranch,
                    });
                  },
                },
              }
            : shouldOfferOpenPrCta
              ? {
                  actionProps: {
                    children: "View PR",
                    onClick: () => {
                      const api = readNativeApi();
                      if (!api) return;
                      closeResultToast();
                      void api.shell.openExternal(prUrl);
                    },
                  },
                }
              : shouldOfferCreatePrCta
                ? {
                    actionProps: {
                      children: "Create PR",
                      onClick: () => {
                        closeResultToast();
                        void runGitActionWithToast({
                          action: "create_pr",
                          statusOverride: postPushStatus,
                          isDefaultBranchOverride: actionIsDefaultBranch,
                        });
                      },
                    },
                  }
                : {}),
        });
      } catch (err) {
        activeGitActionProgressRef.current = null;
        toastManager.update(resolvedProgressToastId, {
          type: "error",
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
  );

  const continuePendingDefaultBranchAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      ...(requiresFeatureBranchForDefaultBranchAction(action) ? { featureBranch: true } : {}),
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction]);

  const checkoutFeatureBranchAndContinuePendingAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction]);

  const runDialogActionOnNewBranch = useCallback(() => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  }, [allSelected, isCommitDialogOpen, dialogCommitMessage, selectedFiles]);

  const openCreateBranchDialog = useCallback(() => {
    setCreateBranchName(suggestedCreateBranchName);
    setIsCreateBranchDialogOpen(true);
  }, [suggestedCreateBranchName]);

  const runQuickAction = useCallback(() => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      runSyncWithRemote();
      return;
    }
    if (quickAction.kind === "create_branch") {
      openCreateBranchDialog();
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  }, [openCreateBranchDialog, openExistingPr, quickAction, runSyncWithRemote, threadToastData]);

  const openCommitDialog = useCallback(() => {
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setIsCommitDialogOpen(true);
  }, []);

  const closeCommitDialog = useCallback(() => {
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
  }, []);

  const closeCreateBranchDialog = useCallback(() => {
    setIsCreateBranchDialogOpen(false);
    setCreateBranchName("");
  }, []);

  const normalizedCurrentBranchName = currentBranchName?.trim().toLowerCase() ?? "";
  const normalizedCreateBranchName = createBranchName.trim().toLowerCase();
  const createBranchNameConflicts =
    normalizedCreateBranchName.length > 0 &&
    normalizedCreateBranchName !== normalizedCurrentBranchName &&
    branchNames.has(normalizedCreateBranchName);

  const createAndCheckoutBranch = useCallback(
    async (branchName: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) return;

      const trimmedName = branchName.trim();
      if (!trimmedName) return;

      setIsCreateBranchDialogOpen(false);
      setCreateBranchName("");

      if (trimmedName.toLowerCase() === normalizedCurrentBranchName) {
        if (activeThreadId) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadId,
              createBranchFlowCompleted: true,
            })
            .catch(() => {
              setThreadWorkspaceAction(activeThreadId, {
                createBranchFlowCompleted: false,
              });
            });
          setThreadWorkspaceAction(activeThreadId, {
            createBranchFlowCompleted: true,
          });
        }
        toastManager.add({
          type: "success",
          title: `Keeping ${trimmedName}`,
          description: "Branch name confirmed.",
          data: threadToastData,
        });
        return;
      }

      const toastId = toastManager.add({
        type: "loading",
        title: "Creating branch...",
        timeout: 0,
        data: threadToastData,
      });

      try {
        await api.git.createBranch({ cwd: gitCwd, branch: trimmedName, publish: hasOriginRemote });
        await api.git.checkout({ cwd: gitCwd, branch: trimmedName });
        if (activeThreadId) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadId,
              branch: trimmedName,
              worktreePath: activeThread?.worktreePath ?? null,
              associatedWorktreeBranch: trimmedName,
              associatedWorktreeRef: trimmedName,
              createBranchFlowCompleted: true,
            })
            .catch(() => {
              setThreadWorkspaceAction(activeThreadId, {
                createBranchFlowCompleted: false,
              });
            });
          setThreadWorkspaceAction(activeThreadId, {
            branch: trimmedName,
            associatedWorktreeBranch: trimmedName,
            associatedWorktreeRef: trimmedName,
            createBranchFlowCompleted: true,
          });
        }
        await invalidateGitQueries(queryClient);

        toastManager.update(toastId, {
          type: "success",
          title: `Switched to ${trimmedName}`,
          description: "Branch created and checked out.",
          data: threadToastData,
        });
      } catch (error) {
        toastManager.update(toastId, {
          type: "error",
          title: "Failed to create branch",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [
      activeThread?.worktreePath,
      activeThreadId,
      gitCwd,
      hasOriginRemote,
      normalizedCurrentBranchName,
      queryClient,
      setThreadWorkspaceAction,
      threadToastData,
    ],
  );

  const openDialogForMenuItem = useCallback(
    (item: GitActionMenuItem) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (item.dialogAction === "push") {
        void runGitActionWithToast({ action: "push" });
        return;
      }
      if (item.dialogAction === "commit_push") {
        void runGitActionWithToast({ action: "commit_push" });
        return;
      }
      if (item.dialogAction === "create_pr") {
        void runGitActionWithToast({ action: "create_pr" });
        return;
      }
      openCommitDialog();
    },
    [openCommitDialog, openExistingPr],
  );

  const gitPickerMenuItems = useMemo<GitPickerMenuItem[]>(
    () =>
      buildGitPickerMenuItems({
        gitActionMenuItems,
        gitStatus: gitStatusForActions,
        isBusy: isGitActionRunning,
        hasOriginRemote,
        openDialogForMenuItem,
        openCreateBranchDialog,
      }),
    [
      gitActionMenuItems,
      gitStatusForActions,
      hasOriginRemote,
      isGitActionRunning,
      openCreateBranchDialog,
      openDialogForMenuItem,
    ],
  );

  const runDialogAction = useCallback(() => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  }, [
    allSelected,
    dialogCommitMessage,
    isCommitDialogOpen,
    selectedFiles,
    setDialogCommitMessage,
    setIsCommitDialogOpen,
  ]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [gitCwd, threadToastData],
  );

  if (!gitCwd) return null;

  return (
    <>
      {!isRepo ? (
        <Button
          variant="chrome-outline"
          size="xs"
          className={cn(CHAT_HEADER_CONTROL_CLASS_NAME, CHAT_HEADER_ICON_STRENGTH_CLASS_NAME)}
          disabled={initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? "Initializing..." : "Initialize Git"}
        </Button>
      ) : (
        <GitActionsHeaderControl
          quickAction={quickAction}
          quickActionDisabledReason={quickActionDisabledReason}
          hideQuickActionLabel={hideQuickActionLabel}
          isGitActionRunning={isGitActionRunning}
          runQuickAction={runQuickAction}
          onMenuOpen={() => void invalidateGitQueries(queryClient)}
          gitPickerMenuItems={gitPickerMenuItems}
          gitStatusForActions={gitStatusForActions}
          isGitStatusOutOfSync={isGitStatusOutOfSync}
          gitStatusError={gitStatusError}
        />
      )}

      <CommitDialog
        open={isCommitDialogOpen}
        onClose={closeCommitDialog}
        gitStatusForActions={gitStatusForActions}
        isDefaultBranch={isDefaultBranch}
        allFiles={allFiles}
        selectedFiles={selectedFiles}
        excludedFiles={excludedFiles}
        setExcludedFiles={setExcludedFiles}
        allSelected={allSelected}
        noneSelected={noneSelected}
        isEditingFiles={isEditingFiles}
        setIsEditingFiles={setIsEditingFiles}
        dialogCommitMessage={dialogCommitMessage}
        setDialogCommitMessage={setDialogCommitMessage}
        openChangedFileInEditor={openChangedFileInEditor}
        onCommit={runDialogAction}
        onCommitOnNewBranch={runDialogActionOnNewBranch}
      />

      <DefaultBranchActionDialog
        pendingAction={pendingDefaultBranchAction}
        copy={pendingDefaultBranchActionCopy}
        onAbort={() => setPendingDefaultBranchAction(null)}
        onContinue={continuePendingDefaultBranchAction}
        onCheckoutFeatureBranch={checkoutFeatureBranchAndContinuePendingAction}
      />

      <CreateBranchDialog
        open={isCreateBranchDialogOpen}
        onClose={closeCreateBranchDialog}
        createBranchName={createBranchName}
        setCreateBranchName={setCreateBranchName}
        createBranchNameConflicts={createBranchNameConflicts}
        onSubmit={(branchName) => void createAndCheckoutBranch(branchName)}
      />
    </>
  );
}
