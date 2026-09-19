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
      <DialogPopup showCloseButton className="max-h-[min(780px,90dvh)] max-w-[720px]">
        <DialogHeader className="px-6 pb-0 pt-6">
          <DialogTitle>Import projects</DialogTitle>
          <DialogDescription>
            Continue your Codex and Claude Code projects in Synara.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-6 pb-2 pt-4">
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
