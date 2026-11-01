import { useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { ProjectImportPanel } from "./ProjectImportPanel";
import { useProjectImportDialogStore } from "./projectImportDialogStore";
import { useTranslation } from "~/i18n";

export function ProjectImportDialog() {
  const { t } = useTranslation();

  const open = useProjectImportDialogStore((store) => store.isOpen);
  const close = useProjectImportDialogStore((store) => store.closeDialog);
  const initialProviders = useProjectImportDialogStore((store) => store.initialProviders);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
    >
      <DialogPopup showCloseButton className="max-h-[min(640px,85dvh)] max-w-[520px]">
        <DialogHeader className="gap-1 px-5 pb-0 pt-5">
          <DialogTitle>{t("workspace:importProjects")}</DialogTitle>
          <DialogDescription className="text-ui">
            {t("workspace:continueYourCodexAndClaudeCodeProjectsInSynara")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-3.5 pb-3">
          {open ? (
            <ProjectImportPanel
              onBusyChange={setBusy}
              {...(initialProviders ? { initialProviders } : {})}
            />
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
