// FILE: ReleaseHistoryDialog.tsx
// Purpose: Standalone dialog that shows the full curated release history. Used
// by the Settings > About row so users can revisit any past release notes on
// demand — mirrors the "Complete changelog" view of the post-update dialog
// without the "current release" anchor.
// Layer: Settings overlay — mounted lazily from the settings panel when the
// user asks to view history.

import { ChangelogAccordion } from "../whatsNew/ChangelogAccordion";
import { WHATS_NEW_ENTRIES } from "../whatsNew/entries";
import { sortEntriesByVersionDesc, type WhatsNewEntry } from "../whatsNew/logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface ReleaseHistoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Entries to display. Defaults to the full curated list; callers can
   * override in tests or storybook scenarios without poking at module state.
   */
  readonly entries?: readonly WhatsNewEntry[];
  /**
   * Version to expand by default (usually the installed build). `null`
   * leaves every row collapsed so the user scans dates-first.
   */
  readonly defaultExpandedVersion?: string | null;
}

export default function ReleaseHistoryDialog({
  open,
  onOpenChange,
  entries = WHATS_NEW_ENTRIES,
  defaultExpandedVersion = null,
}: ReleaseHistoryDialogProps) {
  // Sort at render time so the source of truth (`entries.ts`) stays free of
  // ordering rules — authors can prepend, append, or reorder entries freely.
  const sorted = sortEntriesByVersionDesc(entries);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg gap-0 p-0">
        <DialogHeader className="gap-1 p-4 pr-12">
          <DialogTitle className="text-base">Release history</DialogTitle>
          <DialogDescription className="text-xs">
            Every curated release, newest first.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="max-h-[min(62vh,520px)] px-4 py-3">
          <ChangelogAccordion entries={sorted} defaultExpandedVersion={defaultExpandedVersion} />
        </DialogPanel>

        <DialogFooter className="px-4 py-3">
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
