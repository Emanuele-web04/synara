// FILE: ProjectImportAnnouncementDialog.tsx
// Purpose: One-time announcement that introduces Codex/Claude Code project import
// and routes straight into the import dialog.
// Layer: Root web overlay

import { AnnouncementSheet } from "~/components/AnnouncementSheet";
import { ProjectImportGlyph } from "./ProjectImportGlyph";
import { useProjectImportDialogStore } from "./projectImportDialogStore";
import { useProjectImportAnnouncement } from "./useProjectImportAnnouncement";

export function ProjectImportAnnouncementDialog() {
  const { visible, markSeen } = useProjectImportAnnouncement();
  return (
    <AnnouncementSheet
      open={visible}
      // Inset keeps the rotated tiles clear of the sheet edge.
      hero={<ProjectImportGlyph size="lg" className="ps-1" />}
      title="Import projects"
      description="Bring your Claude Code and Codex projects into Synara and continue their chats right where you left off."
      dismissLabel="Not now"
      confirmLabel="Import projects"
      onDismiss={markSeen}
      onConfirm={() => {
        markSeen();
        useProjectImportDialogStore.getState().openDialog();
      }}
    />
  );
}
