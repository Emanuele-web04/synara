// Purpose: Branch/worktree picker for the chat toolbar.
// Coordinates branch checkout/create actions and decorates rows with git metadata.
// Depends on: git React Query helpers, native API mutations, and toolbar selection rules.
// Note: the "Create branch" footer row uses raw <button> because it is a
// menu-item-style affordance inside a ComboboxPopup, not a generic action.
import type { GitBranch, GitStashInfoResult, GitStatusResult, NativeApi } from "@t3tools/contracts";
import { pluralize } from "@t3tools/shared/text";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon, PlusIcon } from "~/lib/icons";
import { CentralIcon } from "~/lib/central-icons";
import {
  type CSSProperties,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  gitBranchesQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { parsePullRequestReference } from "../pullRequestReference";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  EnvMode,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  shouldSyncLocalThreadBranch,
} from "./BranchToolbar.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./chat/environment/EnvironmentRow";
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "./chat/composerPickerStyles";
import type { ThreadWorkspacePatch } from "../types";

/**
 * Where the selector is rendered. `toolbar` keeps the compact composer-footer pill;
 * `panel` makes the trigger a full-width Environment panel row and drops its menu
 * downward instead of upward.
 */
export type BranchSelectorVariant = "toolbar" | "panel";

interface BranchToolbarBranchSelectorProps {
  activeProjectCwd: string;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  hasServerThread: boolean;
  onSetThreadWorkspace: (patch: ThreadWorkspacePatch) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  variant?: BranchSelectorVariant;
}

type StashDiscardDialogState = {
  cwd: string;
  error: string | null;
  info: GitStashInfoResult | null;
  loading: boolean;
};

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

const DIRTY_WORKTREE_ERROR_PATTERN =
  /Uncommitted changes block checkout to ([^:\n]+):\s*\n((?:\s*-\s*.+(?:\n|$))+)/;
const STASH_CONFLICT_PATTERN = /Stash could not be applied|Stash applied with merge conflicts/;
const UNRESOLVED_INDEX_PATTERN = /you need to resolve your current index/i;
const GIT_INDEX_LOCK_PATTERN =
  /(?:Unable to create '([^']*\.git\/index\.lock)'|Another git process seems to be running|\.git\/index\.lock.*File exists)/i;
const GIT_INDEX_WRITE_PATTERN = /could not write index/i;
let activeBranchRecoveryToastId: ReturnType<typeof toastManager.add> | null = null;

function closeActiveBranchRecoveryToast(): void {
  if (!activeBranchRecoveryToastId) return;
  toastManager.close(activeBranchRecoveryToastId);
  activeBranchRecoveryToastId = null;
}

function addBranchRecoveryToast(input: Parameters<typeof toastManager.add>[0]) {
  closeActiveBranchRecoveryToast();
  activeBranchRecoveryToastId = toastManager.add(input);
  return activeBranchRecoveryToastId;
}

function parseDirtyWorktreeError(error: unknown): { branch: string; files: string[] } | null {
  const detail = error instanceof Error ? error.message : String(error);
  const match = DIRTY_WORKTREE_ERROR_PATTERN.exec(detail);
  if (!match?.[1] || !match[2]) return null;
  const files = match[2]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => line.length > 0);
  if (files.length === 0) return null;
  return {
    branch: match[1].trim(),
    files,
  };
}

function isStashConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return STASH_CONFLICT_PATTERN.test(message);
}

function isUnresolvedIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return UNRESOLVED_INDEX_PATTERN.test(message);
}

function parseGitIndexLockError(error: unknown): { lockPath: string | null } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = GIT_INDEX_LOCK_PATTERN.exec(message);
  if (!match) return null;
  return {
    lockPath: match[1]?.trim() || null,
  };
}

function isGitIndexWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GIT_INDEX_WRITE_PATTERN.test(message);
}

function formatDirtyWorktreeDescription(files: string[], t: TFunction<"translation">): string {
  const basenames = files.map((file) => file.split("/").pop() ?? file);
  if (basenames.length <= 3) {
    return `${basenames.join(", ")} ${t("branch.hasUncommitted_other", { count: basenames.length })}`;
  }
  const remaining = basenames.length - 2;
  return `${basenames.slice(0, 2).join(", ")} ${t("branch.hasUncommitted_other", { count: remaining })}`;
}

function handleCheckoutError(
  error: unknown,
  input: {
    api: NativeApi;
    branch: string;
    cwd: string;
    fallbackTitle: string;
    onSuccess: () => void;
    queryClient: QueryClient;
    runBranchAction: (action: () => Promise<void>) => void;
    onRequestDiscardStash: (input: { cwd: string }) => void;
    t: TFunction<"translation">;
  },
): void {
  const retryStashAndCheckout = async (): Promise<void> => {
    await input.api.git.stashAndCheckout({ cwd: input.cwd, branch: input.branch });
    await invalidateGitQueries(input.queryClient);
    input.onSuccess();
  };

  const addGitIndexLockToast = (error: unknown): void => {
    const lockError = parseGitIndexLockError(error);
    if (!lockError) return;
    const lockFileLabel = lockError.lockPath
      ? lockError.lockPath.split("/").slice(-2).join("/")
      : ".git/index.lock";
    addBranchRecoveryToast({
      type: "error",
      title: input.t("branch.gitIndexLocked"),
      description: input.t("branch.gitIndexLockedDescription", { lockFile: lockFileLabel }),
      data: { copyText: toBranchActionErrorMessage(error) },
      actionProps: {
        children: input.t("branch.lockRemoveRetry"),
        onClick: () => {
          input.runBranchAction(async () => {
            try {
              await input.api.git.removeIndexLock({ cwd: input.cwd });
              await retryStashAndCheckout();
            } catch (retryError) {
              handleCheckoutError(retryError, input);
            }
          });
        },
      },
    });
  };

  const addGitIndexWriteToast = (error: unknown): void => {
    addBranchRecoveryToast({
      type: "error",
      title: input.t("branch.gitIndexWriteFailed"),
      description: input.t("branch.gitIndexWriteDescription"),
      data: { copyText: toBranchActionErrorMessage(error) },
      actionProps: {
        children: input.t("branch.retryStashSwitch"),
        onClick: () => {
          input.runBranchAction(async () => {
            try {
              await retryStashAndCheckout();
            } catch (retryError) {
              handleCheckoutError(retryError, input);
            }
          });
        },
      },
    });
  };

  const dirtyWorktree = parseDirtyWorktreeError(error);
  if (dirtyWorktree) {
    const copyText = toBranchActionErrorMessage(error);
    const dirtyToastId = addBranchRecoveryToast({
      type: "warning",
      title: input.t("branch.dirtyWorktreeBlocked"),
      description: formatDirtyWorktreeDescription(dirtyWorktree.files, input.t),
      data: { copyText },
      actionProps: {
        children: input.t("branch.dirtyWorktreeSwitch"),
        onClick: () => {
          closeActiveBranchRecoveryToast();
          input.runBranchAction(async () => {
            try {
              await retryStashAndCheckout();
            } catch (stashError) {
              if (parseGitIndexLockError(stashError)) {
                addGitIndexLockToast(stashError);
                return;
              }
              if (isGitIndexWriteError(stashError)) {
                addGitIndexWriteToast(stashError);
                return;
              }
              if (isStashConflictError(stashError)) {
                await invalidateGitQueries(input.queryClient);
                input.onSuccess();
                const stashConflictToastId = addBranchRecoveryToast({
                  type: "warning",
                  title: input.t("branch.changesNotReapplied"),
                  description: input.t("branch.changesNotReappliedDescription"),
                  data: { copyText: toBranchActionErrorMessage(stashError) },
                  actionProps: {
                    children: input.t("branch.discardStash"),
                    className:
                      "border-destructive bg-destructive text-white shadow-destructive/24 hover:bg-destructive/90",
                    onClick: () => {
                      closeActiveBranchRecoveryToast();
                      input.onRequestDiscardStash({ cwd: input.cwd });
                    },
                  },
                });
                return;
              }
              if (parseDirtyWorktreeError(stashError)) {
                addBranchRecoveryToast({
                  type: "error",
                  title: input.t("branch.failedStashSwitch"),
                  description: input.t("branch.detachConflictFiles"),
                  data: { copyText: toBranchActionErrorMessage(stashError) },
                });
                return;
              }
              addBranchRecoveryToast({
                type: "error",
                title: input.t("branch.failedStashSwitch"),
                description: toBranchActionErrorMessage(stashError),
                data: { copyText: toBranchActionErrorMessage(stashError) },
              });
            }
          });
        },
      },
    });
    return;
  }

  if (parseGitIndexLockError(error)) {
    addGitIndexLockToast(error);
    return;
  }
  if (isGitIndexWriteError(error)) {
    addGitIndexWriteToast(error);
    return;
  }

  addBranchRecoveryToast({
    type: "error",
    title: isUnresolvedIndexError(error)
      ? input.t("branch.unresolvedConflicts")
      : input.fallbackTitle,
    description: toBranchActionErrorMessage(error),
    data: { copyText: toBranchActionErrorMessage(error) },
  });
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
  t: TFunction<"translation">;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveBranch, t } = input;
  if (!resolvedActiveBranch) {
    return t("branch.selectBranch");
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return t("branch.selectFromBranch", { branch: resolvedActiveBranch });
  }
  return resolvedActiveBranch;
}

function getCreateBranchActionLabel(
  trimmedBranchQuery: string,
  t: TFunction<"translation">,
): string {
  return trimmedBranchQuery.length > 0
    ? t("branch.createAndCheckout", { name: trimmedBranchQuery })
    : t("branch.createAndCheckoutNew");
}

function getCurrentBranchChangeSummary(
  branch: GitBranch,
  branchStatus: GitStatusResult | null | undefined,
): {
  fileCount: number;
  insertions: number;
  deletions: number;
} | null {
  if (!branch.current || !branchStatus?.hasWorkingTreeChanges) {
    return null;
  }

  return {
    fileCount: branchStatus.workingTree.files.length,
    insertions: branchStatus.workingTree.insertions,
    deletions: branchStatus.workingTree.deletions,
  };
}

export function BranchToolbarBranchSelector({
  activeProjectCwd,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
  effectiveEnvMode,
  envLocked,
  hasServerThread,
  onSetThreadWorkspace,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  variant = "toolbar",
}: BranchToolbarBranchSelectorProps) {
  const { t } = useTranslation();
  const isPanel = variant === "panel";
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [isCreateBranchDialogOpen, setIsCreateBranchDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const branchesQuery = useQuery(gitBranchesQueryOptions(branchCwd));
  const branchStatusQuery = useQuery(gitStatusQueryOptions(branchCwd));
  const branches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.branches ?? []),
    [branchesQuery.data?.branches],
  );
  const hasOriginRemote = branchesQuery.data?.hasOriginRemote ?? false;
  const currentGitBranch =
    branchStatusQuery.data?.branch ?? branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = useMemo(() => branches.map((branch) => branch.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((branch) => [branch.name, branch] as const)),
    [branches],
  );
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();
  const normalizedDeferredBranchQuery = deferredTrimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    prReference && onCheckoutPullRequestRequest ? `__checkout_pull_request__:${prReference}` : null;
  const canPrefillCreateBranch = !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const branchPickerItems = useMemo(() => {
    const items = [...branchNames];
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  }, [branchNames, checkoutPullRequestItemValue]);
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedDeferredBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) =>
            itemValue.toLowerCase().includes(normalizedDeferredBranchQuery),
          ),
    [branchPickerItems, normalizedDeferredBranchQuery],
  );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const [stashDiscardDialog, setStashDiscardDialog] = useState<StashDiscardDialogState | null>(
    null,
  );
  const [isDroppingStash, setIsDroppingStash] = useState(false);
  const shouldVirtualizeBranchList = filteredBranchPickerItems.length > 40;

  useEffect(() => {
    if (
      !shouldSyncLocalThreadBranch({
        envMode: effectiveEnvMode,
        activeWorktreePath,
        activeThreadBranch,
        currentGitBranch,
        hasServerThread,
        isBranchActionPending,
      })
    ) {
      return;
    }

    onSetThreadWorkspace({ branch: currentGitBranch, worktreePath: null });
  }, [
    activeThreadBranch,
    activeWorktreePath,
    currentGitBranch,
    effectiveEnvMode,
    hasServerThread,
    isBranchActionPending,
    onSetThreadWorkspace,
  ]);

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitQueries(queryClient).catch(() => undefined);
    });
  };

  const openCreateBranchDialog = useCallback(() => {
    setCreateBranchName(canPrefillCreateBranch && !hasExactBranchMatch ? trimmedBranchQuery : "");
    setIsBranchMenuOpen(false);
    setIsCreateBranchDialogOpen(true);
  }, [canPrefillCreateBranch, hasExactBranchMatch, trimmedBranchQuery]);

  const openStashDiscardDialog = useCallback(
    (input: { cwd: string }) => {
      const api = readNativeApi();
      setStashDiscardDialog({
        cwd: input.cwd,
        error: api ? null : t("branch.nativeApiUnavailable"),
        info: null,
        loading: Boolean(api),
      });
      if (!api) return;
      void api.git.stashInfo({ cwd: input.cwd }).then(
        (info) => {
          setStashDiscardDialog((current) =>
            current?.cwd === input.cwd
              ? { ...current, error: null, info, loading: false }
              : current,
          );
        },
        (error) => {
          setStashDiscardDialog((current) =>
            current?.cwd === input.cwd
              ? {
                  ...current,
                  error: toBranchActionErrorMessage(error),
                  info: null,
                  loading: false,
                }
              : current,
          );
        },
      );
    },
    [t],
  );

  const discardStashFromDialog = useCallback(() => {
    const dialog = stashDiscardDialog;
    const api = readNativeApi();
    if (!dialog || !api || isDroppingStash) return;
    setIsDroppingStash(true);
    runBranchAction(async () => {
      try {
        await api.git.stashDrop({ cwd: dialog.cwd });
        setStashDiscardDialog(null);
      } finally {
        setIsDroppingStash(false);
      }
    });
  }, [isDroppingStash, runBranchAction, stashDiscardDialog]);

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !branchCwd || isBranchActionPending) return;

    // In new-worktree mode, selecting a branch sets the base branch.
    if (isSelectingWorktreeBase) {
      onSetThreadWorkspace({ branch: branch.name, worktreePath: null });
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      branch,
    });

    // If the branch already lives in a worktree, point the thread there.
    if (selectionTarget.reuseExistingWorktree) {
      onSetThreadWorkspace({
        branch: branch.name,
        worktreePath: selectionTarget.nextWorktreePath,
      });
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = branch.isRemote
      ? deriveLocalBranchNameFromRemoteRef(branch.name)
      : branch.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(selectedBranchName);
      try {
        await api.git.checkout({ cwd: selectionTarget.checkoutCwd, branch: branch.name });
        await invalidateGitQueries(queryClient);
      } catch (error) {
        handleCheckoutError(error, {
          api,
          branch: branch.name,
          cwd: selectionTarget.checkoutCwd,
          fallbackTitle: t("branch.failedCheckout"),
          onSuccess: () => {
            setOptimisticBranch(selectedBranchName);
            onSetThreadWorkspace({
              branch: selectedBranchName,
              worktreePath: selectionTarget.nextWorktreePath,
            });
          },
          queryClient,
          runBranchAction,
          onRequestDiscardStash: openStashDiscardDialog,
          t,
        });
        return;
      }

      let nextBranchName = selectedBranchName;
      if (branch.isRemote) {
        const status = await api.git.status({ cwd: branchCwd }).catch(() => null);
        if (status?.branch) {
          nextBranchName = status.branch;
        }
      }

      setOptimisticBranch(nextBranchName);
      onSetThreadWorkspace({
        branch: nextBranchName,
        worktreePath: selectionTarget.nextWorktreePath,
      });
    });
  };

  const createBranch = (rawName: string) => {
    const name = rawName.trim();
    const api = readNativeApi();
    if (!api || !branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(name);

      try {
        await api.git.createBranch({ cwd: branchCwd, branch: name, publish: hasOriginRemote });
        try {
          await api.git.checkout({ cwd: branchCwd, branch: name });
        } catch (error) {
          handleCheckoutError(error, {
            api,
            branch: name,
            cwd: branchCwd,
            fallbackTitle: t("branch.failedCheckout"),
            onSuccess: () => {
              setOptimisticBranch(name);
              onSetThreadWorkspace({
                branch: name,
                worktreePath: activeWorktreePath,
              });
              setBranchQuery("");
              setCreateBranchName("");
            },
            queryClient,
            runBranchAction,
            onRequestDiscardStash: openStashDiscardDialog,
            t,
          });
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("branch.createBranchFailed"),
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      setOptimisticBranch(name);
      onSetThreadWorkspace({
        branch: name,
        worktreePath: activeWorktreePath,
      });
      setBranchQuery("");
      setCreateBranchName("");
    });
  };

  useEffect(() => {
    if (
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !currentGitBranch
    ) {
      return;
    }
    onSetThreadWorkspace({ branch: currentGitBranch, worktreePath: null });
  }, [
    activeThreadBranch,
    activeWorktreePath,
    currentGitBranch,
    effectiveEnvMode,
    onSetThreadWorkspace,
  ]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsBranchMenuOpen(open);
      if (!open) {
        setBranchQuery("");
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.branches(branchCwd),
      });
    },
    [branchCwd, queryClient],
  );

  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);
  const branchListVirtualizer = useVirtualizer({
    count: filteredBranchPickerItems.length,
    estimateSize: (index) => {
      const itemValue = filteredBranchPickerItems[index];
      if (!itemValue) return 28;
      if (itemValue === checkoutPullRequestItemValue) return 44;
      const branch = branchByName.get(itemValue);
      return branch && getCurrentBranchChangeSummary(branch, branchStatusQuery.data) ? 48 : 28;
    },
    getScrollElement: () => branchListScrollElementRef.current,
    overscan: 12,
    enabled: isBranchMenuOpen && shouldVirtualizeBranchList,
    initialRect: {
      height: 224,
      width: 0,
    },
  });
  const virtualBranchRows = branchListVirtualizer.getVirtualItems();
  const setBranchListRef = useCallback(
    (element: HTMLDivElement | null) => {
      branchListScrollElementRef.current =
        (element?.parentElement as HTMLDivElement | null) ?? null;
      if (element) {
        branchListVirtualizer.measure();
      }
    },
    [branchListVirtualizer],
  );

  useEffect(() => {
    if (!isBranchMenuOpen || !shouldVirtualizeBranchList) return;
    queueMicrotask(() => {
      branchListVirtualizer.measure();
    });
  }, [
    branchListVirtualizer,
    branchStatusQuery.data,
    filteredBranchPickerItems.length,
    isBranchMenuOpen,
    shouldVirtualizeBranchList,
  ]);

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    t,
  });

  function renderPickerItem(itemValue: string, index: number, style?: CSSProperties) {
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => {
            if (!prReference || !onCheckoutPullRequestRequest) {
              return;
            }
            setIsBranchMenuOpen(false);
            setBranchQuery("");
            onComposerFocusRequest?.();
            onCheckoutPullRequestRequest(prReference);
          }}
        >
          <div className="flex min-w-0 flex-col items-start py-1">
            <span className="truncate font-medium">{t("branch.checkoutPullRequest")}</span>
            <span className="truncate text-muted-foreground text-xs">{prReference}</span>
          </div>
        </ComboboxItem>
      );
    }

    const branch = branchByName.get(itemValue);
    if (!branch) return null;

    const hasSecondaryWorktree = branch.worktreePath && branch.worktreePath !== activeProjectCwd;
    const currentBranchChangeSummary = getCurrentBranchChangeSummary(
      branch,
      branchStatusQuery.data,
    );
    const badge = branch.current
      ? t("branch.currentLabel")
      : hasSecondaryWorktree
        ? t("branch.worktreeLabel")
        : branch.isRemote
          ? t("branch.remoteLabel")
          : branch.isDefault
            ? t("branch.defaultLabel")
            : null;
    return (
      <ComboboxItem
        hideIndicator
        key={itemValue}
        index={index}
        value={itemValue}
        className={
          itemValue === resolvedActiveBranch
            ? "bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)]"
            : undefined
        }
        style={style}
        onClick={() => selectBranch(branch)}
      >
        <div className="flex w-full items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{itemValue}</span>
              {badge && (
                <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>
              )}
            </div>
            {currentBranchChangeSummary ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4">
                <span className="text-muted-foreground">
                  {t("branch.dirtyWorktreeFileCount_other", {
                    count: currentBranchChangeSummary.fileCount,
                  })}
                </span>
                <span className="font-mono tabular-nums text-success">
                  +{currentBranchChangeSummary.insertions.toLocaleString()}
                </span>
                <span className="font-mono tabular-nums text-destructive">
                  -{currentBranchChangeSummary.deletions.toLocaleString()}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </ComboboxItem>
    );
  }

  return (
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      virtualized={shouldVirtualizeBranchList}
      onItemHighlighted={(_value, eventDetails) => {
        if (!isBranchMenuOpen || eventDetails.index < 0) return;
        branchListVirtualizer.scrollToIndex(eventDetails.index, { align: "auto" });
      }}
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      <ComboboxTrigger
        className={
          isPanel
            ? ENVIRONMENT_ROW_CLASS_NAME
            : `${COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME} disabled:cursor-not-allowed disabled:opacity-50`
        }
        disabled={(branchesQuery.isLoading && branches.length === 0) || isBranchActionPending}
      >
        {isPanel ? (
          <EnvironmentRowBody
            icon={<CentralIcon name="branch" className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
            label={triggerLabel}
            trailing={<EnvironmentRowChevron />}
          />
        ) : (
          <>
            <CentralIcon name="branch" className="size-3.5 shrink-0" />
            <span className="max-w-[240px] truncate">{triggerLabel}</span>
            <ChevronDownIcon className="size-3 opacity-60" />
          </>
        )}
      </ComboboxTrigger>
      <ComboboxPopup align="end" side={isPanel ? "bottom" : "top"} className="w-80">
        <div className="border-b p-1">
          <ComboboxInput
            className="rounded-xl border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] shadow-none before:hidden has-focus-visible:border-[color:var(--color-border-focus)] has-focus-visible:ring-0 [&_input]:font-sans"
            inputClassName="ring-0"
            placeholder={t("branch.searchBranches")}
            showTrigger={false}
            size="sm"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>{t("branch.noBranchesFound")}</ComboboxEmpty>

        <ComboboxList ref={setBranchListRef} className="max-h-56">
          {shouldVirtualizeBranchList ? (
            <div
              className="relative"
              style={{
                height: `${branchListVirtualizer.getTotalSize()}px`,
              }}
            >
              {virtualBranchRows.map((virtualRow) => {
                const itemValue = filteredBranchPickerItems[virtualRow.index];
                if (!itemValue) return null;
                return renderPickerItem(itemValue, virtualRow.index, {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                });
              })}
            </div>
          ) : (
            filteredBranchPickerItems.map((itemValue, index) => renderPickerItem(itemValue, index))
          )}
        </ComboboxList>
        {!isSelectingWorktreeBase ? (
          <div className="border-t border-[color:var(--color-border-light)] p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isBranchActionPending}
              onClick={openCreateBranchDialog}
            >
              <PlusIcon className="size-3.5 shrink-0" />
              <span className="truncate">{getCreateBranchActionLabel(trimmedBranchQuery, t)}</span>
            </button>
          </div>
        ) : null}
      </ComboboxPopup>
      <Dialog
        open={isCreateBranchDialogOpen}
        onOpenChange={(open) => {
          setIsCreateBranchDialogOpen(open);
          if (!open) {
            setCreateBranchName("");
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("branch.createBranch")}</DialogTitle>
            <DialogDescription>
              {t("branch.createBranchDescription", {
                branch: resolvedActiveBranch ?? currentGitBranch ?? t("branch.currentHead"),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const nextName = createBranchName.trim();
                if (!nextName || branchByName.has(nextName)) {
                  return;
                }
                setIsCreateBranchDialogOpen(false);
                createBranch(nextName);
              }}
            >
              <div className="space-y-1.5">
                <label className="block font-medium text-sm" htmlFor="branch-create-name">
                  {t("branch.branchName")}
                </label>
                <Input
                  autoFocus
                  id="branch-create-name"
                  placeholder="feature/我的修改"
                  value={createBranchName}
                  onChange={(event) => setCreateBranchName(event.target.value)}
                />
              </div>
              {branchByName.has(createBranchName.trim()) ? (
                <p className="text-destructive text-sm">{t("branch.branchAlreadyExists")}</p>
              ) : null}
              <DialogFooter variant="bare">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setIsCreateBranchDialogOpen(false);
                    setCreateBranchName("");
                  }}
                >
                  {t("branch.cancel")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    createBranchName.trim().length === 0 ||
                    branchByName.has(createBranchName.trim())
                  }
                >
                  {t("branch.createAndSwitch")}
                </Button>
              </DialogFooter>
            </form>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={stashDiscardDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setStashDiscardDialog(null);
            setIsDroppingStash(false);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("branch.discardStashConfirm")}</DialogTitle>
            <DialogDescription>{t("branch.discardStashDescription")}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {stashDiscardDialog?.loading ? (
              <p className="text-muted-foreground text-sm">{t("branch.loadingStashDetails")}</p>
            ) : stashDiscardDialog?.error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
                {stashDiscardDialog.error}
              </p>
            ) : stashDiscardDialog?.info ? (
              <>
                <div className="grid gap-2 rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] p-3 text-sm">
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {t("branch.fromRowLabel")}
                    </span>
                    <span className="min-w-0 truncate font-medium">
                      {stashDiscardDialog.info.branch ?? currentGitBranch ?? t("branch.detachHead")}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {t("branch.worktreeRowLabel")}
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs">
                      {stashDiscardDialog.info.cwd}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {t("branch.stashLabel")}
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs">
                      {stashDiscardDialog.info.stashRef}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {t("branch.nameLabel")}
                    </span>
                    <span className="min-w-0 truncate">{stashDiscardDialog.info.message}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="font-medium text-sm">
                    {t("branch.changeCount", { count: stashDiscardDialog.info.files.length })}
                  </p>
                  {stashDiscardDialog.info.files.length > 0 ? (
                    <ul className="max-h-48 overflow-auto rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-control-opaque)] py-1">
                      {stashDiscardDialog.info.files.map((file) => (
                        <li
                          className="truncate px-3 py-1 font-mono text-muted-foreground text-xs"
                          key={file}
                          title={file}
                        >
                          {file}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border border-[color:var(--color-border-light)] px-3 py-2 text-muted-foreground text-sm">
                      {t("branch.gitNoFileNames")}
                    </p>
                  )}
                </div>
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setStashDiscardDialog(null);
                setIsDroppingStash(false);
              }}
            >
              {t("branch.keepStash")}
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={!stashDiscardDialog?.info || isDroppingStash}
              onClick={discardStashFromDialog}
            >
              {isDroppingStash ? t("branch.discarding") : t("branch.discardStash")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Combobox>
  );
}
