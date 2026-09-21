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
