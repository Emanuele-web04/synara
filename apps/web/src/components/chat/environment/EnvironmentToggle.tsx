// FILE: EnvironmentToggle.tsx
// Purpose: The single chat-header "Environment" button that replaces the former
//          Open-in-editor + git-actions + diff-toggle cluster. It toggles the Environment
//          panel overlay, which is always pinned to the top-right of the chat column
//          (with matching p-3 gutters). When the right dock is closed the overlay also
//          reserves transcript/composer inset; when the dock is open it overlays only.
// Layer: Chat header control

import { WindowIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CHAT_HEADER_TOGGLE_CLASS_NAME, SurfaceChipIcon } from "../chatHeaderControls";

export interface EnvironmentToggleState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Icon-only footprint matching the header diff toggle's collapsed (no-badge) size.
const TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
);

export function EnvironmentToggle({ environment }: { environment: EnvironmentToggleState }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={TOGGLE_CLASS_NAME}
            pressed={environment.open}
            onPressedChange={environment.onOpenChange}
            aria-label="Toggle environment panel"
            variant="default"
            size="xs"
          >
            <SurfaceChipIcon icon={WindowIcon} className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">Environment</TooltipPopup>
    </Tooltip>
  );
}
