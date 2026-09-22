import { WorkflowIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CHAT_HEADER_TOGGLE_CLASS_NAME, SurfaceChipIcon } from "../chatHeaderControls";

export interface ProjectToggleState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
);

export function ProjectToggle({ project }: { project: ProjectToggleState }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={TOGGLE_CLASS_NAME}
            pressed={project.open}
            onPressedChange={project.onOpenChange}
            aria-label="Toggle group panel"
            variant="default"
            size="xs"
          >
            <SurfaceChipIcon icon={WorkflowIcon} className="size-4" />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">Group</TooltipPopup>
    </Tooltip>
  );
}
