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

export function GroupLifecycleSection(props: {
  readonly agent: ReturnType<typeof useProjectAgent>;
  readonly projectName: string;
  readonly onDeleted: () => void;
}) {
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
        description: agent.error ?? "An error occurred.",
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
        title: "Unable to delete hub",
        description: agent.error ?? "An error occurred.",
      });
      return;
    }
    const notice = buildGroupDeletedNotice(result);
    if (notice) {
      toastManager.add({
        type: "info",
        title: "Hub deleted",
        description: notice.description,
        data: { copyItems: notice.copyItems },
      });
    }
    props.onDeleted();
  };

  return (
    <div className="space-y-6 pt-6">
      <SettingsSectionShell title="Lifecycle">
        <SettingsCard>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-ui font-medium">{paused ? "Resume hub" : "Pause hub"}</p>
              <p className="text-ui-sm text-muted-foreground">
                {paused
                  ? "Threads and automations are stopped until you resume."
                  : "Interrupts running threads and stops new coordinator wakes."}
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
              {paused ? "Resume" : "Pause"}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-ui font-medium">Restart coordinator</p>
              <p className="text-ui-sm text-muted-foreground">
                Stops and restarts the coordinator's session. Transcript is kept.
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
              Restart
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-ui font-medium">Archive hub</p>
              <p className="text-ui-sm text-muted-foreground">
                Archives every thread and hides the hub in the sidebar until unarchived.
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
              Archive
            </Button>
          </div>
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="Danger zone">
        <SettingsCard>
          <div className="space-y-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-ui font-medium text-destructive">Delete hub</p>
              <p className="text-ui-sm text-muted-foreground">
                Deletes the hub, its coordinator, context, and automations. The Library is moved to
                the trash when possible. The hub folder under ~/Documents/Synara/Groups is removed
                only when it holds nothing but Synara-generated files; if it has your files it is
                kept and you get its path. Linked repositories and their threads are untouched.
              </p>
            </div>
            {confirmOpen ? (
              <div className="space-y-2">
                <Input
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  placeholder={`Type ${projectName} to confirm`}
                  aria-label="Type the hub name to confirm deletion"
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={!nameMatches || busy}
                    onClick={() => void handleDelete()}
                  >
                    {deleting ? "Deleting..." : "Delete hub"}
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
                    Cancel
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
                Delete hub…
              </Button>
            )}
          </div>
        </SettingsCard>
      </SettingsSectionShell>
    </div>
  );
}
