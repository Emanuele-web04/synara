// FILE: ProjectImportAnnouncementDialog.tsx
// Purpose: One-time announcement that introduces Codex/Claude Code project import
// and routes straight into the import dialog.
// Layer: Root web overlay

import { AnnouncementSheet } from "~/components/AnnouncementSheet";
import { ProjectImportHeroScene } from "./ProjectImportHeroScene";
import { useProjectImportDialogStore } from "./projectImportDialogStore";
import { useProjectImportAnnouncement } from "./useProjectImportAnnouncement";
import { useTranslation } from "~/i18n";

export function ProjectImportAnnouncementDialog() {
  const { t } = useTranslation();

  const { visible, markSeen } = useProjectImportAnnouncement();
  return (
    <AnnouncementSheet
      open={visible}
      hero={<ProjectImportHeroScene />}
      title={t("workspace:importProjects")}
      description={t("workspace:bringYourClaudeCodeAndCodexProjectsIntoSynara")}
      dismissLabel={t("common:notNow")}
      confirmLabel={t("workspace:importProjects")}
      onDismiss={markSeen}
      onConfirm={() => {
        markSeen();
        useProjectImportDialogStore.getState().openDialog();
      }}
    />
  );
}
