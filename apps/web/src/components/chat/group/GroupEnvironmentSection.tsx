import type { ProjectId } from "@synara/contracts";
import { useMemo, useState } from "react";

import type { Project } from "~/types";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { SettingsSegmentedControl } from "~/components/settings/SettingControls";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { abbreviateHomePath } from "~/components/sidebarHoverCardAnchors";
import type { useProjectAgent } from "~/components/chat/project/useProjectAgent";
import { FolderOpenIcon } from "~/lib/icons";
import { getNavigatorPlatform } from "~/lib/utils";
import { getRevealInFolderLabel } from "~/lib/fileReferenceContextMenu";
import { revealFolderInShell } from "~/lib/revealFolder";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

import { GroupLinkProjectDialog } from "./GroupLinkProjectDialog";
import type { GroupSettingsDraft } from "./groupSettingsDialog.logic";

export function GroupEnvironmentSection(props: {
  readonly workspacePath: string;
  readonly draft: GroupSettingsDraft;
  readonly agent: ReturnType<typeof useProjectAgent>;
  readonly onChange: (patch: Partial<GroupSettingsDraft>) => void;
}) {
  const { draft, onChange } = props;
  const projects = useStore((state) => state.projects);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const linkedProjectIds = props.agent.overview?.linkedProjectIds ?? [];
  const linkedProjects = linkedProjectIds
    .map((id) => projectById.get(id))
    .filter((project): project is Project => project !== undefined);
  const missingLinkedIds = linkedProjectIds.filter((id) => !projectById.has(id));

  const revealLabel = getRevealInFolderLabel(getNavigatorPlatform());
  const canReveal =
    typeof window !== "undefined" && Boolean(window.desktopBridge) && props.workspacePath;
  const canPickFolder = typeof window !== "undefined" && Boolean(window.desktopBridge?.pickFolder);

  const revealGroupFolder = () => {
    revealFolderInShell({ path: props.workspacePath });
  };

  const unlinkProject = async (linkedProjectId: ProjectId) => {
    const ok = await props.agent.unlinkProject(linkedProjectId);
    if (!ok) {
      toastManager.add({
        type: "error",
        title: "Unable to unlink repository",
        description: props.agent.readError() ?? "An unknown error occurred.",
      });
    }
  };

  const pickLibraryPath = async () => {
    const api = readNativeApi();
    if (!api) return;
    const path = await api.dialogs.pickFolder().catch(() => null);
    if (path) onChange({ libraryPath: path });
  };

  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title="Linked repositories"
        action={
          <Button size="xs" variant="outline" onClick={() => setLinkPickerOpen(true)}>
            Add repository
          </Button>
        }
      >
        {linkedProjects.length === 0 && missingLinkedIds.length === 0 ? (
          <SettingsEmptyState layout="status">No linked repositories.</SettingsEmptyState>
        ) : (
          <SettingsCard>
            {linkedProjects.map((project) => (
              <SettingsListRow
                key={project.id}
                title={project.name}
                description={abbreviateHomePath(project.cwd, homeDir)}
                actions={
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void unlinkProject(project.id)}
                  >
                    Remove
                  </Button>
                }
              />
            ))}
            {missingLinkedIds.map((id) => (
              <SettingsListRow
                key={id}
                title={id}
                description="This project is no longer available."
                actions={
                  <Button size="xs" variant="outline" onClick={() => void unlinkProject(id)}>
                    Remove
                  </Button>
                }
              />
            ))}
          </SettingsCard>
        )}
        <p className="mt-2 px-1 text-ui-sm text-muted-foreground">
          Linking and unlinking apply immediately.
        </p>
      </SettingsSectionShell>

      <SettingsSectionShell title="Workspace">
        <SettingsCard>
          <SettingsRow
            title="Group folder"
            description={
              props.workspacePath
                ? abbreviateHomePath(props.workspacePath, homeDir)
                : "No folder assigned"
            }
            control={
              canReveal ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={revealGroupFolder}
                  aria-label={revealLabel}
                >
                  <FolderOpenIcon className="size-3.5" />
                  {revealLabel}
                </Button>
              ) : undefined
            }
          />
          <SettingsRow
            title="Worker environment"
            description="Where worker threads run their tasks."
            control={
              <SettingsSegmentedControl
                value={draft.workerEnvironment}
                onValueChange={(value) => onChange({ workerEnvironment: value })}
                options={[
                  { value: "local", label: "Local" },
                  { value: "worktree", label: "Worktree" },
                ]}
                ariaLabel="Worker environment"
              />
            }
          />
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="Library hosting">
        <SettingsCard>
          <SettingsRow
            title="Location"
            description={
              canPickFolder
                ? draft.libraryPath
                  ? abbreviateHomePath(draft.libraryPath, homeDir)
                  : "Not set"
                : "Absolute path to the library folder."
            }
            control={
              canPickFolder ? (
                <Button size="xs" variant="outline" onClick={() => void pickLibraryPath()}>
                  Change…
                </Button>
              ) : (
                <Input
                  value={draft.libraryPath}
                  onChange={(event) => onChange({ libraryPath: event.target.value })}
                  placeholder="/absolute/path"
                  aria-label="Library location"
                  className="w-full sm:w-64"
                />
              )
            }
          />
          <SettingsRow
            title="Git remote"
            description="Remote the library pushes to."
            control={
              <Input
                value={draft.libraryRemoteUrl}
                onChange={(event) => onChange({ libraryRemoteUrl: event.target.value })}
                placeholder="https://…"
                aria-label="Library git remote"
                className="w-full sm:w-64"
              />
            }
          />
          <SettingsRow
            title="Push on change"
            description="Push library commits to the remote automatically."
            control={
              <Switch
                checked={draft.libraryPushOnChange}
                onCheckedChange={(checked) => onChange({ libraryPushOnChange: Boolean(checked) })}
                aria-label="Push on change"
              />
            }
          />
          <div className="px-4 py-2.5 text-ui-sm text-muted-foreground">
            The library is a git repository; every change is committed.
          </div>
        </SettingsCard>
      </SettingsSectionShell>

      <GroupLinkProjectDialog
        open={linkPickerOpen}
        projects={projects}
        linkedProjectIds={linkedProjectIds}
        onOpenChange={setLinkPickerOpen}
        onPick={(projectId) => {
          setLinkPickerOpen(false);
          void props.agent.linkProject(projectId).then((ok) => {
            if (!ok) {
              toastManager.add({
                type: "error",
                title: "Unable to link repository",
                description: props.agent.readError() ?? "An unknown error occurred.",
              });
            }
          });
        }}
      />
    </div>
  );
}
