// FILE: NewTaskButton.tsx
// Purpose: The "New task" header button Tasks and Kanban share, with a tooltip that names
//          the shortcut.
// Layer: Tasks UI component
// Exports: NewTaskButton

import { Button } from "~/components/ui/button";
import { ShortcutKbd } from "~/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PlusIcon } from "~/lib/icons";
import { NEW_TASK_SHORTCUT_LABEL } from "~/lib/newTaskShortcut";

export function NewTaskButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="chrome"
            className="ml-auto shrink-0 gap-1.5"
            disabled={disabled}
            onClick={onClick}
          >
            <PlusIcon className="size-3.5" />
            New task
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        <span className="flex items-center gap-2">
          New task
          <ShortcutKbd shortcutLabel={NEW_TASK_SHORTCUT_LABEL} />
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
