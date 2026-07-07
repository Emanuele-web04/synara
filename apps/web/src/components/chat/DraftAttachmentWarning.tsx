// FILE: DraftAttachmentWarning.tsx
// Purpose: Single source of truth for the "this draft attachment may not survive a
//   reload" warning shared by image and file attachment chips — the amber glyph, its
//   accessible label, and the explanatory copy. Keeps the wording and affordance from
//   drifting between the two surfaces.
// Layer: Chat attachment presentation
// Exports: DraftAttachmentWarningIcon, DRAFT_ATTACHMENT_WARNING_LABEL,
//   DRAFT_ATTACHMENT_WARNING_DESCRIPTION

import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { useTranslation } from "react-i18next";

import { CircleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

/** i18n key for the accessible label on the warning glyph. */
export const DRAFT_ATTACHMENT_WARNING_LABEL_KEY = "draftAttachment.label";
/** i18n key for the explanatory copy shown in the hover tooltip / detail row. */
export const DRAFT_ATTACHMENT_WARNING_DESCRIPTION_KEY = "draftAttachment.description";

// `inline` sits in a card's detail row; `badge` floats over an image thumbnail
// (opaque surface + shadow so it stays legible on any preview).
export type DraftAttachmentWarningVariant = "inline" | "badge";

type DraftAttachmentWarningIconProps = ComponentPropsWithoutRef<"span"> & {
  variant?: DraftAttachmentWarningVariant;
};

// forwardRef + prop spread so the badge can act as a Base UI tooltip trigger.
export const DraftAttachmentWarningIcon = forwardRef<
  HTMLSpanElement,
  DraftAttachmentWarningIconProps
>(function DraftAttachmentWarningIcon({ variant = "inline", className, ...rest }, ref) {
  const { t } = useTranslation();
  return (
    <span
      ref={ref}
      {...rest}
      role="img"
      aria-label={t(DRAFT_ATTACHMENT_WARNING_LABEL_KEY)}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-amber-600",
        variant === "badge" ? "size-5 bg-[var(--composer-surface)] shadow-sm" : "size-4",
        className,
      )}
    >
      <CircleAlertIcon className="size-3" />
    </span>
  );
});
