// FILE: ComposerImageAttachmentChip.tsx
// Purpose: Renders filename-first composer image attachments as compact pills with preview/remove actions.
// Layer: Chat composer presentation
// Depends on: composer draft image metadata, shared chip styles, and expanded image preview helpers.

import { memo } from "react";
import { type ComposerImageAttachment } from "../../composerDraftStore";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
} from "../composerInlineChip";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

interface ComposerImageAttachmentChipProps {
  image: ComposerImageAttachment;
  images: readonly ComposerImageAttachment[];
  nonPersisted: boolean;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemoveImage: (imageId: string) => void;
}

export const ComposerImageAttachmentChip = memo(function ComposerImageAttachmentChip({
  image,
  images,
  nonPersisted,
  onExpandImage,
  onRemoveImage,
}: ComposerImageAttachmentChipProps) {
  return (
    <div className={COMPOSER_ATTACHMENT_CHIP_CLASS_NAME}>
      <button
        type="button"
        className="flex min-w-0 max-w-[232px] items-center gap-1.5 rounded-full py-0 pl-0 pr-0.5 text-left transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={`Preview ${image.name}`}
        onClick={() => {
          const preview = buildExpandedImagePreview(images, image.id);
          if (!preview) return;
          onExpandImage(preview);
        }}
      >
        <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)]">
          {image.previewUrl ? (
            <img src={image.previewUrl} alt={image.name} className="size-full object-cover" />
          ) : (
            <span className="px-1 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              IMG
            </span>
          )}
        </span>
        <span className="min-w-0 truncate text-[12px] font-medium text-foreground/84">
          {image.name}
        </span>
      </button>

      {nonPersisted && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label="Draft attachment may not persist"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-amber-600"
              >
                <CircleAlertIcon className="size-3" />
              </span>
            }
          />
          <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
            Draft attachment could not be saved locally and may be lost on navigation.
          </TooltipPopup>
        </Tooltip>
      )}

      <button
        type="button"
        className={cn(
          COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
          "size-5 rounded-full text-muted-foreground/62 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        )}
        onClick={() => onRemoveImage(image.id)}
        aria-label={`Remove ${image.name}`}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
});
