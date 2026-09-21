import { StarFilledIcon, StarIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { COMPOSER_PICKER_RADIUS_CLASS_NAME } from "./composerPickerStyles";

// Lives inside a menu item, so every event that would also activate the row (click, pointer down, Enter/Space) stops here.
export function ModelStarButton(props: {
  starred: boolean;
  label: string;
  onToggle: () => void;
  iconClassName?: string;
}) {
  const Icon = props.starred ? StarFilledIcon : StarIcon;
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.starred}
      className={cn(
        "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center text-muted-foreground/50 transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
        COMPOSER_PICKER_RADIUS_CLASS_NAME,
        props.starred && "text-amber-400 hover:text-amber-300",
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onToggle();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Icon aria-hidden="true" className={props.iconClassName ?? "size-3"} />
    </button>
  );
}
