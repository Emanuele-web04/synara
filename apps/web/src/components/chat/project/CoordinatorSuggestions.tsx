import type { GroupSettingsSection } from "../group/groupSettingsDialog.logic";
import { cn } from "~/lib/utils";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "../composerPickerStyles";
import {
  type CoordinatorSuggestionChip,
  coordinatorSuggestionSection,
} from "./coordinatorSuggestions.logic";

export function CoordinatorSuggestions({
  chips,
  composerHeightPx,
  onOpenSettings,
}: {
  chips: readonly CoordinatorSuggestionChip[];
  composerHeightPx: number;
  onOpenSettings: (section: GroupSettingsSection) => void;
}) {
  return (
    <div
      className={cn("shrink-0 pb-28", CHAT_COLUMN_GUTTER_CLASS_NAME)}
      // Keep the original minimum gap, and clear the floating composer when attachments
      // or wrapped text make it taller. Its existing observer tracks both growth and shrinkage.
      style={{ paddingBottom: `max(7rem, ${composerHeightPx + 8}px)` }}
    >
      <div className={cn(CHAT_COLUMN_FRAME_CLASS_NAME, "flex flex-col gap-2 px-1")}>
        <div className="text-ui text-muted-foreground">Suggestions</div>
        <div className="flex flex-wrap gap-2">
          {chips.map((label) => (
            <button
              key={label}
              type="button"
              className="rounded-full border border-[color:var(--color-border-light)] px-3 py-1 text-ui text-foreground hover:bg-foreground/5"
              onClick={() => onOpenSettings(coordinatorSuggestionSection(label))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
