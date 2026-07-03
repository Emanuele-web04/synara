import { TargetIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerGoalChip({
  label = "Goal",
  tooltip,
  disabled = false,
  onClear,
}: {
  label?: string;
  tooltip?: string;
  disabled?: boolean;
  onClear: () => void;
}) {
  return (
    <div
      className={cn(
        "group/goal-chip flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-md px-2",
        "text-[length:var(--app-font-size-ui-sm,11px)] font-normal",
        "text-[var(--color-text-foreground-secondary)] transition-colors",
        "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
        "focus-within:bg-[var(--color-background-button-secondary-hover)] focus-within:text-[var(--color-text-foreground)]",
        disabled && "opacity-60",
      )}
      title={tooltip}
    >
      <TargetIcon className="size-3.5 shrink-0" />
      <span className="max-w-24 truncate whitespace-nowrap sm:max-w-32">{label}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                "grid size-3.5 shrink-0 cursor-pointer place-items-center rounded-sm text-current opacity-0 transition",
                "hover:bg-[var(--color-background-button-secondary-hover)]",
                "hover:text-[var(--color-text-foreground)]",
                "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1",
                "focus-visible:ring-ring/60",
                "group-hover/goal-chip:opacity-100 group-focus-within/goal-chip:opacity-100",
              )}
              aria-label="Disable goal"
              disabled={disabled}
              onClick={onClear}
            />
          }
        >
          <XIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Disable goal</TooltipPopup>
      </Tooltip>
    </div>
  );
}
