// FILE: AttachmentRemoveButton.tsx
// Purpose: Shared circular "remove" affordance for composer attachments. One primitive
//   keeps dismiss behavior consistent while each attachment shape chooses placement.
// Layer: Chat composer presentation

import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type AttachmentRemoveButtonSize = "sm" | "md";
export type AttachmentRemoveButtonPlacement = "corner" | "center-right";

const ATTACHMENT_REMOVE_BUTTON_SIZE_STYLES: Record<
  AttachmentRemoveButtonSize,
  { button: string; icon: string }
> = {
  sm: { button: "size-3.5 focus-visible:ring-1", icon: "size-2.5" },
  md: { button: "size-5 focus-visible:ring-2", icon: "size-3" },
};

interface AttachmentRemoveButtonProps {
  onRemove: () => void;
  /** Accessible label, e.g. `Remove screenshot.png`. */
  label: string;
  size?: AttachmentRemoveButtonSize;
  placement?: AttachmentRemoveButtonPlacement;
  className?: string;
}

export function AttachmentRemoveButton({
  onRemove,
  label,
  size = "md",
  placement = "corner",
  className,
}: AttachmentRemoveButtonProps) {
  const styles = ATTACHMENT_REMOVE_BUTTON_SIZE_STYLES[size];
  return (
    <button
      type="button"
      className={cn(
        "absolute flex items-center justify-center rounded-full bg-foreground/80 text-background shadow-sm transition-colors hover:bg-foreground focus-visible:outline-none focus-visible:ring-ring",
        placement === "center-right" ? "right-1 top-1/2 -translate-y-1/2" : "right-1 top-1",
        styles.button,
        className,
      )}
      aria-label={label}
      // Keep composer focus put when dismissing from the attachments row.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRemove}
    >
      <XIcon className={styles.icon} />
    </button>
  );
}
