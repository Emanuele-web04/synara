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

export function ProjectImportDialog() {
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
          <DialogTitle>Import projects</DialogTitle>
          <DialogDescription className="text-ui">
            Continue your Codex and Claude Code projects in Synara.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 pb-2 pt-3.5">
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
