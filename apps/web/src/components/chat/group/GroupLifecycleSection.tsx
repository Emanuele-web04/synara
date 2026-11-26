// FILE: GroupLifecycleSection.tsx
// Purpose: Group lifecycle controls inside group settings — pause/resume,
//          archive, restart coordinator, and the typed-name delete zone.
//          Actions go through useProjectAgent's lifecycle methods so the
//          summaries store and overview stay in sync.
// Layer: Web component
// Exports: GroupLifecycleSection

import { useState } from "react";

import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { SettingsCard, SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";
import { toastManager } from "~/components/ui/toast";

import { buildGroupDeletedNotice } from "./groupLifecycle.logic";
import type { useProjectAgent } from "../project/useProjectAgent";
import { useTranslation } from "~/i18n";

export function GroupLifecycleSection(props: {
  readonly agent: ReturnType<typeof useProjectAgent>;
  readonly projectName: string;
  readonly onDeleted: () => void;
}) {
  const { t } = useTranslation();

  const { agent, projectName } = props;
  const [confirmName, setConfirmName] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const config = agent.overview?.config ?? null;
  if (!config) return null;
  const paused = config.pausedAt != null;
  const archived = config.archivedAt != null;
  const busy = agent.busy || deleting;
  const nameMatches = confirmName.trim() === projectName.trim() && projectName.trim().length > 0;

  const run = async (work: () => Promise<unknown>, errorTitle: string) => {
    const result = await work();
    if (result === null || result === false) {
      toastManager.add({
        type: "error",
        title: errorTitle,
        description: agent.error ?? t("common:proposedPlan_unknownError"),
      });
    }
  };

  const handleDelete = async () => {
    if (!nameMatches || busy) return;
    setDeleting(true);
    const result = await agent.deleteGroup(config.projectId, confirmName);
    setDeleting(false);
    if (result === null) {
      toastManager.add({
        type: "error",
        title: t("workspace:unableToDeleteHub"),
        description: agent.error ?? t("common:proposedPlan_unknownError"),
      });
      return;
    }
    const notice = buildGroupDeletedNotice(result);
    if (notice) {
      toastManager.add({
        type: "info",
        title: t("workspace:hubDeleted"),
        description: notice.description,
        data: { copyItems: notice.copyItems },
      });
    }
    props.onDeleted();
  };

  return (
    <div className="space-y-6 pt-6">
      <SettingsSectionShell title="workspace:lifecycle">
        <SettingsCard>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-ui font-medium">
                {paused ? t("workspace:resumeHub") : t("workspace:pauseHub")}
              </p>
              <p className="text-ui-sm text-muted-foreground">
                {paused
                  ? t("workspace:threadsAndAutomationsAreStoppedUntilYouResume")
                  : t("workspace:interruptsRunningThreadsAndStopsNewCoordinatorWakes")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || archived}
              onClick={() =>
                void run(
                  () =>
                    paused
                      ? agent.resumeGroup(config.projectId)
                      : agent.pauseGroup(config.projectId),
                  paused ? "Unable to resume hub" : "Unable to pause hub",
                )
              }
            >
              {paused ? t("chat:detail_resume") : t("workspace:detail_pause")}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-ui font-medium">{t("workspace:restartCoordinator")}</p>
              <p className="text-ui-sm text-muted-foreground">
                {t("workspace:stopsAndRestartsTheCoordinatorSSessionTranscriptIs")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || paused || archived}
              onClick={() =>
                void run(
                  () => agent.restartCoordinator(config.projectId),
                  "Unable to restart the coordinator",
                )
              }
            >
              {t("common:restart")}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-ui font-medium">{t("workspace:archiveHub")}</p>
              <p className="text-ui-sm text-muted-foreground">
                {t("workspace:archivesEveryThreadAndHidesTheHubInThe")}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || archived}
              onClick={() =>
                void run(() => agent.archiveGroup(config.projectId), "Unable to archive hub")
              }
            >
              {t("workspace:detail_archive")}
            </Button>
          </div>
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="workspace:dangerZone">
        <SettingsCard>
          <div className="space-y-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-ui font-medium text-destructive">{t("workspace:deleteHub")}</p>
              <p className="text-ui-sm text-muted-foreground">
                {t("workspace:deletesTheHubItsCoordinatorContextAndAutomationsThe")}
              </p>
            </div>
            {confirmOpen ? (
              <div className="space-y-2">
                <Input
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  placeholder={t("workspace:typeToConfirm", { value0: projectName })}
                  aria-label={t("workspace:typeTheHubNameToConfirmDeletion")}
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={!nameMatches || busy}
                    onClick={() => void handleDelete()}
                  >
                    {deleting ? t("workspace:deleting") : t("workspace:deleteHub")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={deleting}
                    onClick={() => {
                      setConfirmOpen(false);
                      setConfirmName("");
                    }}
                  >
                    {t("common:form_cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="destructive-outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
              >
                {t("workspace:deleteHub2")}
              </Button>
            )}
          </div>
        </SettingsCard>
      </SettingsSectionShell>
    </div>
  );
}
