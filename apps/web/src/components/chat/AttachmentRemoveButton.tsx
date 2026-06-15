// FILE: AttachmentRemoveButton.tsx
// Purpose: Shared circular "remove" affordance overlaid on the top-right corner of a
//   composer attachment (image thumbnail, pasted-text card, …). One primitive so
//   every attachment type dismisses with the same look, position, and semantics.
// Layer: Chat composer presentation

import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type AttachmentRemoveButtonSize = "sm" | "md";

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
  className?: string;
}

export function AttachmentRemoveButton({
  onRemove,
  label,
  size = "md",
  className,
}: AttachmentRemoveButtonProps) {
  const styles = ATTACHMENT_REMOVE_BUTTON_SIZE_STYLES[size];
  return (
    <button
      type="button"
      className={cn(
        "absolute right-1 top-1 flex items-center justify-center rounded-full bg-foreground/80 text-background shadow-sm transition-colors hover:bg-foreground focus-visible:outline-none focus-visible:ring-ring",
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
