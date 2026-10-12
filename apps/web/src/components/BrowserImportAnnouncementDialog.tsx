import { useNavigate } from "@tanstack/react-router";

import { useBrowserImportAnnouncement } from "./useBrowserImportAnnouncement";
import { AnnouncementSheet } from "./AnnouncementSheet";
import { BROWSER_IMPORT_DESCRIPTION } from "./BrowserImportPanel";
import { CentralIcon } from "../lib/central-icons";

export function BrowserImportAnnouncementDialog() {
  const navigate = useNavigate();
  const { visible, markSeen } = useBrowserImportAnnouncement();

  return (
    <AnnouncementSheet
      open={visible}
      hero={
        <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl border border-[color:var(--color-border)] bg-muted/30 text-foreground">
          <CentralIcon name="browser" className="size-8" />
        </span>
      }
      title="Bring your browsers"
      description={`${BROWSER_IMPORT_DESCRIPTION} You choose what Synara imports.`}
      dismissLabel="Not now"
      confirmLabel="Review browser import"
      onDismiss={markSeen}
      onConfirm={() => {
        markSeen();
        void navigate({ to: "/settings", search: { section: "general" } });
      }}
    />
  );
}
