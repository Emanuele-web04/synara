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
  onOpenSettings,
}: {
  chips: readonly CoordinatorSuggestionChip[];
  onOpenSettings: (section: GroupSettingsSection) => void;
}) {
  return (
    <div className={cn("pb-28", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
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
