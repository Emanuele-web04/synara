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
  entries: entriesProp,
  defaultExpandedVersion: defaultExpandedVersionProp,
}: ReleaseHistoryDialogProps) {
  const entries = entriesProp ?? WHATS_NEW_ENTRIES;
  const defaultExpandedVersion = defaultExpandedVersionProp ?? null;
  // Sort at render time so the source of truth (`entries.ts`) stays free of ordering rules — authors can prepend, append, or reorder entries freely.
  const sorted = sortEntriesByVersionDesc(entries);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg gap-0 p-0">
        <DialogHeader className="gap-1 p-4 pr-12">
          <DialogTitle className="text-base">Release history</DialogTitle>
          <DialogDescription className="text-ui leading-snug">
            Every curated release, newest first.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="max-h-[min(62vh,520px)] px-4 py-3">
          <ChangelogAccordion entries={sorted} defaultExpandedVersion={defaultExpandedVersion} />
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
