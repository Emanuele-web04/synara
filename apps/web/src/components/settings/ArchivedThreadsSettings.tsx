// FILE: ArchivedThreadsSettings.tsx
// Purpose: Archived threads settings panel (grouped by project with restore/delete actions).
// Layer: Settings UI components
// Exports: ArchivedThreadsSettings

import { type ThreadId } from "@t3tools/contracts";
import { type Project, type Thread } from "../../types";
import { ArchiveIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../Sidebar";
import {
  SETTINGS_EMPTY_STATE_CLASS_NAME,
  SETTINGS_INSET_LIST_CLASS_NAME,
} from "../../settingsPanelStyles";
import { Button } from "../ui/button";
import { SettingsSection } from "./SettingsPanelPrimitives";

export function ArchivedThreadsSettings(props: {
  projects: ReadonlyArray<Project>;
  archivedThreads: ReadonlyArray<Thread>;
  onRestore: (threadId: ThreadId) => void;
  onDelete: (threadId: ThreadId, threadTitle: string) => void;
  onContextMenu: (
    threadId: ThreadId,
    threadTitle: string,
    position: { x: number; y: number },
  ) => void;
}) {
  const { projects, archivedThreads, onRestore, onDelete, onContextMenu } = props;
  const archivedGroups = [
    ...projects.map((project) => ({
      project,
      threads: archivedThreads
        .filter((thread) => thread.projectId === project.id)
        .toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.updatedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.updatedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        }),
    })),
    ...(() => {
      const knownProjectIds = new Set(projects.map((project) => project.id));
      const orphanedThreads = archivedThreads
        .filter((thread) => !knownProjectIds.has(thread.projectId))
        .toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.updatedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.updatedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        });
      return orphanedThreads.length > 0
        ? [
            {
              project: null,
              threads: orphanedThreads,
            },
          ]
        : [];
    })(),
  ].filter((group) => group.threads.length > 0);

  return (
    <div className="space-y-6">
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <div className={cn(SETTINGS_EMPTY_STATE_CLASS_NAME, "px-5 py-10 text-center")}>
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full border border-border/70 bg-background/70 text-muted-foreground">
              <ArchiveIcon className="size-5" />
            </div>
            <div className="text-sm font-medium text-foreground">No archived threads</div>
            <div className="mt-1 text-sm text-muted-foreground">
              Archived threads will appear here and can be restored to the sidebar.
            </div>
          </div>
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project?.id ?? "unknown-project"}
            title={project?.name ?? "Unknown project"}
          >
            <div className={SETTINGS_INSET_LIST_CLASS_NAME}>
              {projectThreads.map((thread, index) => (
                <div
                  key={thread.id}
                  className={cn(
                    "flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between",
                    index > 0 && "border-t border-[color:var(--color-border)]",
                  )}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onContextMenu(thread.id, thread.title, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {thread.title}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Archived {formatRelativeTime(thread.archivedAt ?? thread.createdAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="xs" variant="outline" onClick={() => onRestore(thread.id)}>
                      Restore
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => onDelete(thread.id, thread.title)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </SettingsSection>
        ))
      )}
    </div>
  );
}
