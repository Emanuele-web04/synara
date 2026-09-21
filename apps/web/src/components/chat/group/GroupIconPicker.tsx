import { cn } from "~/lib/utils";

import { GROUP_ICON_OPTIONS } from "./groupSettingsDialog.logic";

export function GroupIconPicker({
  value,
  onValueChange,
}: {
  readonly value: string;
  readonly onValueChange: (icon: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Group icon">
      {GROUP_ICON_OPTIONS.map((icon) => {
        const selected = value === icon;
        return (
          <button
            key={icon}
            type="button"
            title={icon}
            aria-label={`Group icon ${icon}`}
            aria-pressed={selected}
            className={cn(
              "relative grid size-8 place-items-center rounded-lg border-2 text-base transition-colors motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              selected ? "border-foreground" : "border-transparent hover:border-foreground/25",
            )}
            onClick={() => onValueChange(selected ? "" : icon)}
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
}
