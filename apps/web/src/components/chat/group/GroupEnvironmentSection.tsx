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
import { useTranslation } from "~/i18n";

export function GroupEnvironmentSection(props: {
  readonly workspacePath: string;
  readonly draft: GroupSettingsDraft;
  readonly agent: ReturnType<typeof useProjectAgent>;
  readonly onChange: (patch: Partial<GroupSettingsDraft>) => void;
}) {
  const { t } = useTranslation();

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
        title: t("workspace:unableToUnlinkRepository"),
        description: props.agent.readError() ?? t("workspace:anUnknownErrorOccurred"),
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
        title="workspace:linkedRepositories"
        action={
          <Button size="xs" variant="outline" onClick={() => setLinkPickerOpen(true)}>
            {t("workspace:addRepository")}
          </Button>
        }
      >
        {linkedProjects.length === 0 && missingLinkedIds.length === 0 ? (
          <SettingsEmptyState layout="status">
            {t("workspace:noLinkedRepositories")}
          </SettingsEmptyState>
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
                    {t("workspace:edit_remove")}
                  </Button>
                }
              />
            ))}
            {missingLinkedIds.map((id) => (
              <SettingsListRow
                key={id}
                title={id}
                description={t("workspace:thisProjectIsNoLongerAvailable")}
                actions={
                  <Button size="xs" variant="outline" onClick={() => void unlinkProject(id)}>
                    {t("workspace:edit_remove")}
                  </Button>
                }
              />
            ))}
          </SettingsCard>
        )}
        <p className="mt-2 px-1 text-ui-sm text-muted-foreground">
          {t("workspace:linkingAndUnlinkingApplyImmediately")}
        </p>
      </SettingsSectionShell>

      <SettingsSectionShell title="workspace:editor_workspaceLabel">
        <SettingsCard>
          <SettingsRow
            id="setting-hub-folder"
            title="workspace:hubFolder"
            description={
              props.workspacePath
                ? abbreviateHomePath(props.workspacePath, homeDir)
                : "workspace:noFolderAssigned"
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
            id="setting-worker-environment"
            title="workspace:workerEnvironment"
            description="workspace:whereWorkerThreadsRunTheirTasks"
            control={
              <SettingsSegmentedControl
                value={draft.workerEnvironment}
                onValueChange={(value) => onChange({ workerEnvironment: value })}
                options={[
                  { value: "local", label: t("computer:worktreeMode_local") },
                  { value: "worktree", label: t("common:worktreeMode_worktree") },
                ]}
                ariaLabel={t("workspace:workerEnvironment")}
              />
            }
          />
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="workspace:libraryHosting">
        <SettingsCard>
          <SettingsRow
            id="setting-location"
            title="workspace:location"
            description={
              canPickFolder
                ? draft.libraryPath
                  ? abbreviateHomePath(draft.libraryPath, homeDir)
                  : "workspace:pathNotSet"
                : "workspace:libraryAbsolutePath"
            }
            control={
              canPickFolder ? (
                <Button size="xs" variant="outline" onClick={() => void pickLibraryPath()}>
                  {t("workspace:change")}
                </Button>
              ) : (
                <Input
                  value={draft.libraryPath}
                  onChange={(event) => onChange({ libraryPath: event.target.value })}
                  placeholder={t("workspace:absolutePath")}
                  aria-label={t("workspace:libraryLocation")}
                  className="w-full sm:w-64"
                />
              )
            }
          />
          <SettingsRow
            id="setting-git-remote"
            title="workspace:gitRemote"
            description="workspace:remoteTheLibraryPushesTo"
            control={
              <Input
                value={draft.libraryRemoteUrl}
                onChange={(event) => onChange({ libraryRemoteUrl: event.target.value })}
                placeholder="https://…"
                aria-label={t("workspace:libraryGitRemote")}
                className="w-full sm:w-64"
              />
            }
          />
          <SettingsRow
            id="setting-push-on-change"
            title="workspace:pushOnChange"
            description="workspace:pushLibraryCommitsToTheRemoteAutomatically"
            control={
              <Switch
                checked={draft.libraryPushOnChange}
                onCheckedChange={(checked) => onChange({ libraryPushOnChange: Boolean(checked) })}
                aria-label={t("workspace:pushOnChange")}
              />
            }
          />
          <div className="px-4 py-2.5 text-ui-sm text-muted-foreground">
            {t("workspace:theLibraryIsAGitRepositoryEveryChangeIs")}
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
                title: t("workspace:unableToLinkRepository"),
                description: props.agent.readError() ?? t("workspace:anUnknownErrorOccurred"),
              });
            }
          });
        }}
      />
    </div>
  );
}
