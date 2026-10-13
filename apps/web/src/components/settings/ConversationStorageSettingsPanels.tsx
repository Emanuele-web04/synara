// FILE: ConversationStorageSettingsPanels.tsx
// Purpose: Own settings panels for managed worktrees and archived conversations.
// Layer: Settings UI components
// Exports: WorktreesSettingsPanel, ArchivedSettingsPanel

import type { ThreadId } from "@synara/contracts";
import { pluralize } from "~/i18n/pluralize";
import { collectSubagentDescendants } from "@synara/shared/threadHierarchy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { gitRemoveWorktreeMutationOptions } from "~/lib/gitReactQuery";
import { ArchiveIcon } from "~/lib/icons";
import { deleteArchivedThreadsFromClient } from "~/lib/archivedThreadDelete";
import { formatRelativeTime } from "~/lib/relativeTime";
import { serverQueryKeys, serverWorktreesQueryOptions } from "~/lib/serverReactQuery";
import { unarchiveThreadFromClient } from "~/lib/threadArchive";
import { cn } from "~/lib/utils";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME } from "~/settingsPanelStyles";
import { useStore } from "~/store";
import { createThreadShellsSelector } from "~/storeSelectors";
import { formatWorktreePathForDisplay, isThreadAssociatedWithWorktree } from "~/worktreeCleanup";
import { toastManager } from "../ui/toast";
import { SettingsEmptyState, SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

type ArchivedSortableThread = {
  id: string;
  archivedAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  createdAt: string;
};

function compareArchivedThreads(left: ArchivedSortableThread, right: ArchivedSortableThread) {
  const leftKey = left.archivedAt ?? left.updatedAt ?? left.createdAt;
  const rightKey = right.archivedAt ?? right.updatedAt ?? right.createdAt;
  return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
}

function WorktreesStatus(props: { children: string; error?: boolean }) {
  return (
    <SettingsEmptyState layout="status" tone={props.error ? "destructive" : "muted"}>
      {props.children}
    </SettingsEmptyState>
  );
}

export function WorktreesSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const worktreesQuery = useQuery(serverWorktreesQueryOptions());
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const removeDeletedThreadFromClientState = useStore(
    (store) => store.removeDeletedThreadFromClientState,
  );
  // Shell metadata is enough for association labels and avoids rerendering on transcript ticks.
  const threadShells = useStore(useMemo(() => createThreadShellsSelector(), []));

  const worktreesByWorkspaceRoot = useMemo(() => {
    type WorktreeGroup = {
      workspaceRoot: string;
      worktrees: Array<{
        path: string;
        linkedThreads: typeof threadShells;
      }>;
    };
    const groups: WorktreeGroup[] = [];
    const groupByRoot = new Map<string, WorktreeGroup>();
    for (const worktree of worktreesQuery.data?.worktrees ?? []) {
      const nextWorktree = {
        path: worktree.path,
        linkedThreads: threadShells.filter((thread) =>
          isThreadAssociatedWithWorktree(thread, worktree.path),
        ),
      };
      const existingGroup = groupByRoot.get(worktree.workspaceRoot);
      if (existingGroup) {
        existingGroup.worktrees.push(nextWorktree);
        continue;
      }
      const group: WorktreeGroup = {
        workspaceRoot: worktree.workspaceRoot,
        worktrees: [nextWorktree],
      };
      groups.push(group);
      groupByRoot.set(worktree.workspaceRoot, group);
    }
    return groups;
  }, [threadShells, worktreesQuery.data?.worktrees]);

  const deleteManagedWorktree = useCallback(
    async (input: { workspaceRoot: string; worktreePath: string }) => {
      const api = readNativeApi() ?? ensureNativeApi();
      const displayName = formatWorktreePathForDisplay(input.worktreePath);
      const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
      if (snapshot === null) {
        toastManager.add({
          type: "error",
          title: t("Could not verify linked conversations"),
          description: t("Retry once the app reconnects to the server."),
        });
        return;
      }

      const linkedThreads = snapshot.threads.filter((thread) =>
        isThreadAssociatedWithWorktree(thread, input.worktreePath),
      );
      const linkedArchivedThreadIds = linkedThreads
        .filter((thread) => (thread.archivedAt ?? null) !== null)
        .map((thread) => thread.id);
      const linkedActiveThreadCount = linkedThreads.length - linkedArchivedThreadIds.length;
      const linkedConversationCount = linkedThreads.length;
      const confirmed = await api.dialogs.confirm(
        linkedConversationCount > 0
          ? [
              `Delete worktree "${displayName}"?`,
              "",
              `${linkedActiveThreadCount} active and ${linkedArchivedThreadIds.length} archived ${pluralize(linkedConversationCount, "conversation is", "conversations are")} linked to this worktree.`,
              linkedArchivedThreadIds.length > 0
                ? "Archived conversations will be deleted first."
                : "Deleting it can break reopening those chats in the same workspace.",
              "",
              "Delete the worktree anyway?",
            ].join("\n")
          : [`Delete worktree "${displayName}"?`, "This removes the Git worktree from disk."].join(
              "\n",
            ),
      );
      if (!confirmed) return;

      try {
        await deleteArchivedThreadsFromClient({
          api: api.orchestration,
          threadIds: linkedArchivedThreadIds,
          removeDeletedThreadFromClientState,
        });
        await removeWorktreeMutation.mutateAsync({
          cwd: input.workspaceRoot,
          path: input.worktreePath,
          force: true,
        });
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.worktrees() });
        toastManager.add({
          type: "success",
          title: t("Worktree deleted"),
          description:
            linkedArchivedThreadIds.length > 0
              ? t("{{value0}} was removed and {{value1}} archived {{value2}} were deleted.", {
                  value0: displayName,
                  value1: linkedArchivedThreadIds.length,
                  value2: pluralize(linkedArchivedThreadIds.length, "conversation"),
                })
              : t("{{value0}} was removed.", { value0: displayName }),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("Could not delete worktree"),
          description: error instanceof Error ? error.message : t("Unable to delete the worktree."),
        });
      }
    },
    [queryClient, removeDeletedThreadFromClientState, removeWorktreeMutation, t],
  );

  if (!active) return null;

  if (worktreesQuery.isLoading) {
    return <WorktreesStatus>{t("Loading managed worktrees...")}</WorktreesStatus>;
  }
  if (worktreesQuery.isError) {
    return (
      <WorktreesStatus error>
        {worktreesQuery.error instanceof Error
          ? worktreesQuery.error.message
          : t("Unable to load worktrees.")}
      </WorktreesStatus>
    );
  }
  if (worktreesByWorkspaceRoot.length === 0) {
    return <WorktreesStatus>{t("No app-managed worktrees found yet.")}</WorktreesStatus>;
  }

  return (
    <div className="space-y-6">
      {worktreesByWorkspaceRoot.map((group) => (
        <SettingsSection key={group.workspaceRoot} title={group.workspaceRoot}>
          {group.worktrees.map((worktree) => (
            <SettingsListRow
              key={worktree.path}
              align="start"
              title="Worktree"
              description={
                <div className="space-y-2">
                  <div
                    className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "truncate font-mono")}
                  >
                    {worktree.path}
                  </div>
                  <div className="space-y-1">
                    <div className="text-ui-sm font-medium text-muted-foreground">
                      {t("Conversations")}
                    </div>
                    {worktree.linkedThreads.length > 0 ? (
                      <div className="space-y-1">
                        {worktree.linkedThreads.map((thread) => (
                          <div
                            key={thread.id}
                            className={cn(
                              SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
                              "text-foreground",
                            )}
                          >
                            {thread.title}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
                        {t("No conversations linked to this worktree.")}
                      </div>
                    )}
                  </div>
                </div>
              }
              actions={
                <div className="flex flex-col items-end gap-2">
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={removeWorktreeMutation.isPending}
                    onClick={() =>
                      void deleteManagedWorktree({
                        workspaceRoot: group.workspaceRoot,
                        worktreePath: worktree.path,
                      })
                    }
                  >
                    {t("Delete")}
                  </Button>
                  {worktree.linkedThreads.length > 0 ? (
                    <p
                      className={cn(
                        SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
                        "max-w-40 text-right",
                      )}
                    >
                      {t("Linked conversations exist. Deleting will ask for confirmation.")}
                    </p>
                  ) : null}
                </div>
              }
            />
          ))}
        </SettingsSection>
      ))}
    </div>
  );
}

export function ArchivedSettingsPanel({ active }: { readonly active: boolean }) {
  const { t, formatLocale } = useTranslation();

  const removeDeletedThreadFromClientState = useStore(
    (store) => store.removeDeletedThreadFromClientState,
  );
  const threadShells = useStore(useMemo(() => createThreadShellsSelector(), []));
  const projects = useStore((store) => store.projects);
  const archivedGroups = useMemo(() => {
    // Represent each archived subtree once. Normally that is a top-level thread;
    // a child whose parent is still active/missing is also a root and must remain
    // visible so legacy retention state can be recovered.
    const archivedThreadIds = new Set(
      threadShells.filter((thread) => thread.archivedAt != null).map((thread) => thread.id),
    );
    const archivedThreads = threadShells.filter((thread) => {
      if (thread.archivedAt == null) return false;
      const parentThreadId = thread.parentThreadId ?? null;
      return parentThreadId === null || !archivedThreadIds.has(parentThreadId);
    });
    const knownProjectIds = new Set(projects.map((project) => project.id));
    const groups: Array<{
      project: (typeof projects)[number] | null;
      threads: typeof archivedThreads;
    }> = projects.map((project) => ({
      project,
      threads: archivedThreads
        .filter((thread) => thread.projectId === project.id)
        .toSorted(compareArchivedThreads),
    }));
    const orphanedThreads = archivedThreads
      .filter((thread) => !knownProjectIds.has(thread.projectId))
      .toSorted(compareArchivedThreads);
    if (orphanedThreads.length > 0) {
      groups.push({ project: null, threads: orphanedThreads });
    }
    return groups.filter((group) => group.threads.length > 0);
  }, [projects, threadShells]);

  const unarchiveThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      try {
        await unarchiveThreadFromClient(api.orchestration, threadId);
        toastManager.add({
          type: "success",
          title: t("Thread restored"),
          description: t("The thread has been moved back to the sidebar."),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("Could not restore thread"),
          description: error instanceof Error ? error.message : t("Unable to restore the thread."),
        });
      }
    },
    [t],
  );

  // Subagent threads are hidden from this list and unreachable without their
  // parent, so deleting the parent removes the whole subtree. Children go
  // first so a mid-flight failure cannot strand them without a parent entry.
  const collectSubtreeDeletionOrder = useCallback(
    (threadId: ThreadId): ThreadId[] => [
      ...collectSubagentDescendants(threadShells, threadId)
        .map((thread) => thread.id)
        .toReversed(),
      threadId,
    ],
    [threadShells],
  );

  const deleteArchivedThread = useCallback(
    async (threadId: ThreadId, threadTitle: string) => {
      const api = readNativeApi();
      if (!api) return;
      const confirmed = await api.dialogs.confirm(
        t(
          'Permanently delete "{{value0}}"?\n\nThis will remove the thread and its conversation history forever.',
          { value0: threadTitle },
        ),
      );
      if (!confirmed) return;
      try {
        await deleteArchivedThreadsFromClient({
          api: api.orchestration,
          threadIds: collectSubtreeDeletionOrder(threadId),
          removeDeletedThreadFromClientState,
        });
        toastManager.add({
          type: "success",
          title: t("Thread deleted"),
          description: t("The archived thread has been permanently removed."),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("Could not delete thread"),
          description: error instanceof Error ? error.message : t("Unable to delete the thread."),
        });
      }
    },
    [collectSubtreeDeletionOrder, removeDeletedThreadFromClientState, t],
  );

  const archivedThreadCount = archivedGroups.reduce(
    (count, group) => count + group.threads.length,
    0,
  );
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const deleteAllArchivedThreads = useCallback(async () => {
    const api = readNativeApi();
    if (!api) return;
    const rootThreadIds = archivedGroups.flatMap((group) =>
      group.threads.map((thread) => thread.id),
    );
    if (rootThreadIds.length === 0) return;
    const confirmed = await api.dialogs.confirm(
      t(
        "Permanently delete all {{value0}} archived {{value1}}?\n\nThis will remove them and their conversation history forever.",
        { value0: rootThreadIds.length, value1: pluralize(rootThreadIds.length, "thread") },
      ),
    );
    if (!confirmed) return;
    setIsDeletingAll(true);
    try {
      await deleteArchivedThreadsFromClient({
        api: api.orchestration,
        threadIds: rootThreadIds.flatMap(collectSubtreeDeletionOrder),
        removeDeletedThreadFromClientState,
      });
      toastManager.add({
        type: "success",
        title: t("Archived threads deleted"),
        description: t("{{value0}} archived {{value1}} permanently removed.", {
          value0: rootThreadIds.length,
          value1: pluralize(rootThreadIds.length, "thread was", "threads were"),
        }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("Could not delete all archived threads"),
        description: error instanceof Error ? error.message : t("Unable to delete the threads."),
      });
    } finally {
      setIsDeletingAll(false);
    }
  }, [archivedGroups, collectSubtreeDeletionOrder, removeDeletedThreadFromClientState, t]);

  const handleContextMenu = useCallback(
    async (threadId: ThreadId, threadTitle: string, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "restore", label: t("Restore") },
          { id: "delete", label: t("Delete"), destructive: true },
        ],
        position,
      );
      if (clicked === "restore") {
        await unarchiveThread(threadId);
      } else if (clicked === "delete") {
        await deleteArchivedThread(threadId, threadTitle);
      }
    },
    [deleteArchivedThread, unarchiveThread, t],
  );

  if (!active) return null;

  if (archivedGroups.length === 0) {
    return (
      <SettingsEmptyState>
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/70 text-muted-foreground">
          <ArchiveIcon className="size-5" />
        </div>
        <div className="text-ui-lg font-medium text-foreground">{t("No archived threads")}</div>
        <div className="mt-1 text-ui leading-snug text-muted-foreground">
          {t("Archived threads will appear here and can be restored to the sidebar.")}
        </div>
      </SettingsEmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-sm text-muted-foreground">
          {archivedThreadCount} {t("archived")} {pluralize(archivedThreadCount, "thread")}
        </span>
        <Button
          size="xs"
          variant="destructive"
          disabled={isDeletingAll}
          onClick={() => void deleteAllArchivedThreads()}
        >
          {t("Delete all")}
        </Button>
      </div>
      {archivedGroups.map(({ project, threads }) => (
        <SettingsSection
          key={project?.id ?? "unknown-project"}
          translateTitle={false}
          title={project?.name ?? t("Unknown project")}
        >
          {threads.map((thread) => (
            <SettingsListRow
              key={thread.id}
              title={thread.title}
              description={`Archived ${formatRelativeTime(thread.archivedAt ?? thread.createdAt, undefined, formatLocale)}`}
              onContextMenu={(event) => {
                event.preventDefault();
                void handleContextMenu(thread.id, thread.title, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              actions={
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void unarchiveThread(thread.id)}
                  >
                    {t("Restore")}
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={() => void deleteArchivedThread(thread.id, thread.title)}
                  >
                    {t("Delete")}
                  </Button>
                </>
              }
            />
          ))}
        </SettingsSection>
      ))}
    </div>
  );
}
