// FILE: useKanbanCardContextMenu.tsx
// Purpose: Right-click context menu for kanban cards, mirroring the sidebar thread
//          menu (rename / pin / copy path / copy id / archive / delete). Reuses the
//          same shared primitives the sidebar uses (native contextMenu, clipboard,
//          worktree cleanup, rename flow) instead of duplicating its action logic.
// Layer: Kanban UI hook
// Exports: useKanbanCardContextMenu

import { THREAD_GOAL_MAX_CHARS, type ThreadId } from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import { KANBAN_COLUMN_V2_LABELS } from "@synara/shared/kanban";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useState } from "react";

import {
  useAppSettings,
  getProviderStartOptions,
  getProviderInstanceOptions,
  resolveAssistantDeliveryMode,
} from "~/appSettings";
import { RenameThreadDialog } from "~/components/RenameThreadDialog";
import { useCopyPathToClipboard, useCopyThreadIdToClipboard } from "~/hooks/useCopyToClipboard";
import { deleteActiveThreadFromClient } from "~/lib/activeThreadDelete";
import {
  dispatchKanbanDraftCardAsGoal,
  kanbanDispatchFailureToast,
  resolveKanbanDraftDispatchTarget,
} from "~/lib/kanbanDispatch";
import { gitRemoveWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { contextMenuGroup } from "~/lib/contextMenuGroup";
import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";
import { pinActionLabel } from "~/lib/pin";
import { releaseOrphanedWorktreeAfterArchive } from "~/lib/archiveThreadWorktreeCleanup";
import { archiveThreadFromClient } from "~/lib/threadArchive";
import { dispatchThreadRename } from "~/lib/threadRename";
import { newCommandId } from "~/lib/utils";
import { dispatchThreadGoal } from "~/threadGoal";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useKanbanUiStore } from "../../kanbanUiStore";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import { getThreadFromState } from "../../threadDerivation";
import { toastManager } from "../ui/toast";
import {
  isKanbanDraftOnlyCard,
  resolveDraftDropAction,
  type KanbanCard,
  type KanbanColumnKey,
} from "./kanban.logic";
import { useTranslation } from "~/i18n";

interface RenameTarget {
  threadId: ThreadId;
  title: string;
}

export interface KanbanCardContextMenuController {
  /** Attach to each card's `onContextMenu`. */
  onCardContextMenu: (
    card: KanbanCard,
    event: MouseEvent,
    /** Valid destinations and their actions, owned by the project board's drop path. */
    moves?: readonly { column: KanbanColumnKey; onMove: () => void }[],
  ) => void;
  /** Render once near the board root. */
  renameDialog: React.ReactNode;
}

function resolveCardWorkspacePath(card: KanbanCard): string | null {
  const appState = useStore.getState();
  const project = appState.projects.find((candidate) => candidate.id === card.projectId) ?? null;
  return resolveThreadWorkspaceCwd({
    projectCwd: project?.cwd ?? null,
    envMode: card.envMode ?? undefined,
    worktreePath: card.worktreePath,
  });
}

async function archiveCardThread(
  threadId: ThreadId,
  worktreeRelease: Omit<
    Parameters<typeof releaseOrphanedWorktreeAfterArchive>[0],
    "threadId" | "archiveSequence"
  >,
) {
  const api = readNativeApi();
  if (!api) return;
  const thread = getThreadFromState(useStore.getState(), threadId);
  if (!thread) return;
  // Archived threads leave the board's thread feed, so a live optimistic
  // dispatch entry could never reconcile — drop it with the card.
  useKanbanUiStore.getState().clearOptimisticDispatch(threadId);
  const archiveSequence = await archiveThreadFromClient(api.orchestration, threadId);
  if (!worktreeRelease.enabled) return;
  // Kanban has no Undo toast. Give the asynchronous archive cleanup time to
  // stop the provider before asking the server to validate and remove anything.
  globalThis.setTimeout(() => {
    void releaseOrphanedWorktreeAfterArchive({
      threadId,
      archiveSequence,
      ...worktreeRelease,
    }).catch((error: unknown) => {
      console.error("Failed to release worktree after archiving thread", { threadId, error });
    });
  }, 8_000);
}

async function setThreadPinned(threadId: ThreadId, isPinned: boolean) {
  const api = readNativeApi();
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    isPinned,
  });
}

export function useKanbanCardContextMenu(): KanbanCardContextMenuController {
  const { t, formatLocale } = useTranslation();

  const { settings } = useAppSettings();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);

  const copyPathToClipboard = useCopyPathToClipboard();
  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();

  const deleteCardThread = async (card: KanbanCard) => {
    // A deleted thread can never reconcile its optimistic dispatch — drop the
    // entry first so no phantom In Progress card survives the deletion.
    useKanbanUiStore.getState().clearOptimisticDispatch(card.threadId);
    // Local-only draft (never promoted): just drop it from the draft store.
    if (card.thread === null) {
      clearDraftThread(card.threadId);
      return;
    }
    // A settled thread can have a separate draft card for its unsent composer prompt.
    if (isKanbanDraftOnlyCard(card)) {
      clearComposerContent(card.threadId);
      return;
    }
    await deleteActiveThreadFromClient({
      threadId: card.threadId,
      onDeleted: ({ thread }) => {
        clearDraftThread(card.threadId);
        clearProjectDraftThreadById(thread.projectId, thread.id);
        clearTerminalState(card.threadId);
      },
      removeWorktree: (worktree) => removeWorktreeMutation.mutateAsync(worktree),
      unknownWorktreeErrorMessage: "Unknown error.",
    });
  };

  const onCardContextMenu: KanbanCardContextMenuController["onCardContextMenu"] = (
    card,
    event,
    moves = [],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readNativeApi();
    if (!api) return;
    const position = { x: event.clientX, y: event.clientY };
    const isDraftOnlyCard = isKanbanDraftOnlyCard(card);
    const isThreadBacked = card.thread !== null;
    const deletesOnlyDraft = !isThreadBacked || isDraftOnlyCard;
    const isThreadActionCard = isThreadBacked && !isDraftOnlyCard;
    const isDispatchableDraft = resolveDraftDropAction(card) === "dispatch";
    // Live/done cards already have a thread: the goal can be written onto it
    // directly (no new turn). Draft-column cards keep the dispatch-path
    // "Send as goal" item instead, which starts the turn with the goal.
    const isSettableGoalCard = card.thread !== null && card.column !== "draft";
    const workspacePath = resolveCardWorkspacePath(card);

    void (async () => {
      const clicked = await api.contextMenu.show(
        [
          ...(isThreadActionCard
            ? [
                {
                  id: "rename",
                  label: t("workspace:contextMenu_renameThread"),
                  icon: THREAD_CONTEXT_MENU_ICONS.rename,
                },
                {
                  id: "toggle-pin",
                  label: pinActionLabel("thread", card.thread?.isPinned ?? false),
                  icon: THREAD_CONTEXT_MENU_ICONS.pin,
                },
              ]
            : []),
          ...contextMenuGroup(
            { id: "move-to", label: t("common:moveTo") },
            moves.map(({ column }) => ({
              id: `move-to-${column}`,
              label: KANBAN_COLUMN_V2_LABELS[column],
              standaloneLabel: t("workspace:moveTo", { value0: KANBAN_COLUMN_V2_LABELS[column] }),
            })),
          ),
          ...contextMenuGroup(
            {
              id: "copy",
              label: t("workspace:share_copy"),
              icon: THREAD_CONTEXT_MENU_ICONS.copy,
              separatorBefore: true,
            },
            [
              ...(workspacePath
                ? [
                    {
                      id: "copy-path",
                      label: t("workspace:path"),
                      standaloneLabel: t("workspace:copyPath"),
                      icon: THREAD_CONTEXT_MENU_ICONS.copy,
                    },
                  ]
                : []),
              ...(isThreadBacked
                ? [
                    {
                      id: "copy-thread-id",
                      label: t("workspace:searchPalette_threadId"),
                      standaloneLabel: t("workspace:copyThreadID"),
                      icon: THREAD_CONTEXT_MENU_ICONS.copy,
                    },
                  ]
                : []),
            ],
          ),
          ...(isThreadActionCard
            ? [
                {
                  id: "archive",
                  label: t("workspace:detail_archive"),
                  icon: THREAD_CONTEXT_MENU_ICONS.archive,
                  separatorBefore: true,
                },
              ]
            : []),
          ...(isDispatchableDraft
            ? [{ id: "send-as-goal", label: t("common:sendAsGoal"), separatorBefore: true }]
            : []),
          ...(isSettableGoalCard ? [{ id: "set-as-goal", label: t("common:setAsGoal") }] : []),
          {
            id: "delete",
            label: deletesOnlyDraft ? t("common:deleteDraft") : t("computer:detail_delete"),
            icon: THREAD_CONTEXT_MENU_ICONS.delete,
            destructive: true,
            separatorBefore: !isThreadActionCard && !isDispatchableDraft,
          },
        ],
        position,
      );

      const move = moves.find(({ column }) => clicked === `move-to-${column}`);
      if (move) {
        move.onMove();
        return;
      }
      if (clicked === "rename" && isThreadActionCard && card.thread) {
        setRenameTarget({ threadId: card.threadId, title: card.thread.title });
        return;
      }
      if (clicked === "toggle-pin" && isThreadActionCard && card.thread) {
        const next = !card.thread.isPinned;
        void setThreadPinned(card.threadId, next).catch(() => {
          toastManager.add({
            type: "error",
            title: next
              ? t("common:toast_unableToPinThread")
              : t("common:toast_unableToUnpinThread"),
          });
        });
        return;
      }
      if (clicked === "copy-path") {
        if (!workspacePath) return;
        copyPathToClipboard(workspacePath);
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(card.threadId);
        return;
      }
      if (clicked === "archive") {
        if (!isThreadActionCard) return;
        if (settings.confirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            [
              `Archive thread "${card.title}"?`,
              "Archived threads are hidden from the sidebar but can be restored later.",
            ].join("\n"),
          );
          if (!confirmed) return;
        }
        await archiveCardThread(card.threadId, {
          enabled: settings.archiveDeletesOrphanedWorktree,
          removeWorktree: (worktree) => removeWorktreeMutation.mutateAsync(worktree),
        });
        return;
      }
      if (clicked === "send-as-goal") {
        if (!isDispatchableDraft) return;
        const providerInstances = getProviderInstanceOptions(settings);
        const target = resolveKanbanDraftDispatchTarget({
          threadId: card.threadId,
          projectId: card.projectId,
          thread: card.thread,
          defaultProvider: settings.defaultProvider,
          providerInstances,
        });
        const result = await dispatchKanbanDraftCardAsGoal({
          card,
          defaultProvider: settings.defaultProvider,
          assistantDeliveryMode: resolveAssistantDeliveryMode(settings),
          providerOptions: getProviderStartOptions(settings, target.instanceId),
          providerInstances,
        });
        if (result.kind === "dispatched") {
          if (result.deferred) {
            toastManager.add({
              type: "info",
              title: t("workspace:chatSendInProgress"),
              description: t("workspace:theBoardStoodDownTheRunningChatSendOwns"),
            });
          } else if (result.warning) {
            toastManager.add({
              type: "warning",
              title: t("common:taskStarted"),
              description: result.warning,
            });
          } else {
            toastManager.add({
              type: "success",
              title: t("common:goalSet"),
              description: card.title,
            });
          }
          return;
        }
        if (result.kind === "open-thread") {
          toastManager.add(kanbanDispatchFailureToast(result, "Could not send as goal"));
          return;
        }
        toastManager.add(kanbanDispatchFailureToast(result, "Could not send as goal"));
        return;
      }
      if (clicked === "set-as-goal") {
        if (!isSettableGoalCard) return;
        // Prefer the live composer prompt (what Send-as-goal would send) over
        // the card title, which can be a fallback like "New thread".
        const livePrompt =
          useComposerDraftStore.getState().draftsByThreadId[card.threadId]?.prompt.trim() ?? "";
        const goal = (livePrompt.length > 0 ? livePrompt : card.title).trim();
        if (goal.length === 0) {
          toastManager.add({
            type: "error",
            title: t("common:couldNotSetGoal"),
            description: t("common:theThreadHasNoPromptOrTitleToSave"),
          });
          return;
        }
        // Same bound the other goal paths enforce — beyond the wire cap the
        // goal is rejected, never silently sliced.
        if (goal.length > THREAD_GOAL_MAX_CHARS) {
          toastManager.add({
            type: "error",
            title: t("common:couldNotSetGoal"),
            description: t("common:theGoalIsCharactersKeepItWithin", {
              value0: goal.length.toLocaleString(formatLocale),
              value1: THREAD_GOAL_MAX_CHARS.toLocaleString(formatLocale),
            }),
          });
          return;
        }
        try {
          // Mirrors the AsGoal dispatch's metadata write (goal + defer), but
          // starts no turn — the existing thread picks the goal up next run.
          // Oversized goals materialize server-side into a file reference.
          await dispatchThreadGoal(card.threadId, goal, {
            startBehavior: "defer",
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: t("common:couldNotSetGoal"),
            description: error instanceof Error ? error.message : t("common:unknownError"),
          });
          return;
        }
        toastManager.add({
          type: "success",
          title: t("common:goalSet"),
          description: card.title,
        });
        return;
      }
      if (clicked !== "delete") return;
      if (settings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          deletesOnlyDraft
            ? t("common:deleteThisDraftThisRemovesItsUnsentPrompt")
            : [
                `Delete thread "${card.title}"?`,
                "This permanently clears conversation history for this thread.",
              ].join("\n"),
        );
        if (!confirmed) return;
      }
      await deleteCardThread(card);
    })();
  };

  const renameDialog = (
    <RenameThreadDialog
      open={renameTarget !== null}
      currentTitle={renameTarget?.title ?? ""}
      onOpenChange={(open) => {
        if (!open) setRenameTarget(null);
      }}
      onSave={async (newTitle) => {
        if (!renameTarget) return;
        const outcome = await dispatchThreadRename({
          threadId: renameTarget.threadId,
          newTitle,
          unchangedTitles: [renameTarget.title],
        });
        if (outcome === "unavailable") {
          toastManager.add({
            type: "error",
            title: t("common:toast_notConnected"),
            description: t("common:reconnectToTheServerBeforeRenaming"),
          });
          return;
        }
        setRenameTarget(null);
      }}
    />
  );

  return { onCardContextMenu, renameDialog };
}
