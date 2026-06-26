// FILE: AttachmentRemoveButton.tsx
// Purpose: Shared circular "remove" affordance for composer attachments. One primitive
//   keeps dismiss behavior consistent while each attachment shape chooses placement.
// Layer: Chat composer presentation

import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type AttachmentRemoveButtonSize = "sm" | "md";
export type AttachmentRemoveButtonPlacement = "corner" | "center-right";
// `solid` is the high-contrast badge on image/file attachment tiles; `ghost` is
// the subtle dismiss tucked inside compact count pills (selections, comments).
export type AttachmentRemoveButtonTone = "solid" | "ghost";

const ATTACHMENT_REMOVE_BUTTON_SIZE_STYLES: Record<
  AttachmentRemoveButtonSize,
  { button: string; icon: string }
> = {
  sm: { button: "size-3.5 focus-visible:ring-1", icon: "size-2.5" },
  md: { button: "size-5 focus-visible:ring-2", icon: "size-3" },
};

const ATTACHMENT_REMOVE_BUTTON_TONE_STYLES: Record<AttachmentRemoveButtonTone, string> = {
  solid: "bg-foreground/80 text-background shadow-sm transition-colors hover:bg-foreground",
  ghost:
    "text-[var(--color-text-foreground-tertiary)] transition-all hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]",
};

interface AttachmentRemoveButtonProps {
  onRemove: () => void;
  /** Accessible label, e.g. `Remove screenshot.png`. */
  label: string;
  size?: AttachmentRemoveButtonSize;
  placement?: AttachmentRemoveButtonPlacement;
  tone?: AttachmentRemoveButtonTone;
  className?: string;
}

export function AttachmentRemoveButton({
  onRemove,
  label,
  size = "md",
  placement = "corner",
  tone = "solid",
  className,
}: AttachmentRemoveButtonProps) {
  const styles = ATTACHMENT_REMOVE_BUTTON_SIZE_STYLES[size];
  return (
    <button
      type="button"
      className={cn(
        "absolute flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-ring",
        ATTACHMENT_REMOVE_BUTTON_TONE_STYLES[tone],
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
