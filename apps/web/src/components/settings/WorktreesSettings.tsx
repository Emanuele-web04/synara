// FILE: WorktreesSettings.tsx
// Purpose: Worktrees settings panel (managed worktrees grouped by workspace root, with delete).
// Layer: Settings UI components
// Exports: WorktreesSettings

import { Button } from "../ui/button";
import {
  SETTINGS_EMPTY_STATE_CLASS_NAME,
  SETTINGS_INSET_LIST_CLASS_NAME,
} from "../../settingsPanelStyles";
import { cn } from "../../lib/utils";
import { SettingsSection } from "./SettingsPanelPrimitives";

type WorktreeGroup = {
  workspaceRoot: string;
  worktrees: Array<{
    path: string;
    linkedThreads: ReadonlyArray<{ id: string; title: string }>;
  }>;
};

export function WorktreesSettings({
  worktreesByWorkspaceRoot,
  isLoading,
  isError,
  error,
  isDeleting,
  onDeleteWorktree,
}: {
  worktreesByWorkspaceRoot: ReadonlyArray<WorktreeGroup>;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isDeleting: boolean;
  onDeleteWorktree: (input: { workspaceRoot: string; worktreePath: string }) => void;
}) {
  return (
    <div className="space-y-6">
      <SettingsSection title="Managed worktrees">
        <div className="space-y-4">
          {isLoading ? (
            <div
              className={cn(
                SETTINGS_EMPTY_STATE_CLASS_NAME,
                "px-4 py-6 text-sm text-muted-foreground",
              )}
            >
              Loading managed worktrees...
            </div>
          ) : isError ? (
            <div
              className={cn(
                SETTINGS_EMPTY_STATE_CLASS_NAME,
                "border-destructive/30 bg-destructive/5 px-4 py-6 text-sm text-destructive",
              )}
            >
              {error instanceof Error ? error.message : "Unable to load worktrees."}
            </div>
          ) : worktreesByWorkspaceRoot.length === 0 ? (
            <div
              className={cn(
                SETTINGS_EMPTY_STATE_CLASS_NAME,
                "px-4 py-6 text-sm text-muted-foreground",
              )}
            >
              No app-managed worktrees found yet.
            </div>
          ) : (
            worktreesByWorkspaceRoot.map((group) => (
              <section key={group.workspaceRoot} className="space-y-2">
                <h3 className="px-1 font-mono text-[11px] text-muted-foreground">
                  {group.workspaceRoot}
                </h3>

                <div className={SETTINGS_INSET_LIST_CLASS_NAME}>
                  {group.worktrees.map((worktree, index) => {
                    const deleteDisabled = isDeleting;
                    return (
                      <div
                        key={worktree.path}
                        className={cn(
                          "flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-start sm:justify-between",
                          index > 0 && "border-t border-[color:var(--color-border)]",
                        )}
                      >
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="space-y-0.5">
                            <div className="text-sm font-medium text-foreground">Worktree</div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {worktree.path}
                            </div>
                          </div>

                          <div className="space-y-1">
                            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                              Conversations
                            </div>
                            {worktree.linkedThreads.length > 0 ? (
                              <div className="space-y-1">
                                {worktree.linkedThreads.map((thread) => (
                                  <div key={thread.id} className="text-sm text-foreground">
                                    {thread.title}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm text-muted-foreground">
                                No conversations linked to this worktree.
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={deleteDisabled}
                            onClick={() =>
                              onDeleteWorktree({
                                workspaceRoot: group.workspaceRoot,
                                worktreePath: worktree.path,
                              })
                            }
                          >
                            Delete
                          </Button>
                          {worktree.linkedThreads.length > 0 ? (
                            <p className="max-w-40 text-right text-[11px] text-muted-foreground">
                              Linked conversations exist. Deleting will ask for confirmation.
                            </p>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
