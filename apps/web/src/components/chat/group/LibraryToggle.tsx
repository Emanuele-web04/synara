// FILE: LibraryToggle.tsx
// Purpose: Chat-header toggle for the group Library panel; mirrors ProjectToggle.
// Layer: Chat UI component

import { BookIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CHAT_HEADER_TOGGLE_CLASS_NAME, SurfaceChipIcon } from "../chatHeaderControls";
import type { ProjectToggleState } from "../project/ProjectToggle";

const TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
);

export function LibraryToggle({ library }: { library: ProjectToggleState }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={TOGGLE_CLASS_NAME}
            pressed={library.open}
            onPressedChange={library.onOpenChange}
            aria-label="Toggle library panel"
            variant="default"
            size="xs"
          >
            <SurfaceChipIcon icon={BookIcon} className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">Library</TooltipPopup>
    </Tooltip>
  );
}
