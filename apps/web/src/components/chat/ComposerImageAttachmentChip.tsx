// FILE: ComposerImageAttachmentChip.tsx
// Purpose: Renders composer image attachments as rounded square thumbnails with preview/remove actions.
// Layer: Chat composer presentation
// Depends on: composer draft image metadata, shared chip styles, and expanded image preview helpers.

import { memo } from "react";
import { type ComposerImageAttachment } from "../../composerDraftStore";
import { CircleAlertIcon } from "~/lib/icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AttachmentRemoveButton } from "./AttachmentRemoveButton";
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
    <div className="group relative shrink-0">
      <button
        type="button"
        className="block size-16 overflow-hidden rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] transition-colors hover:border-[color:var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Preview ${image.name}`}
        title={image.name}
        onClick={() => {
          const preview = buildExpandedImagePreview(images, image.id);
          if (!preview) return;
          onExpandImage(preview);
        }}
      >
        {image.previewUrl ? (
          <img src={image.previewUrl} alt={image.name} className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
            IMG
          </span>
        )}
      </button>

      {nonPersisted && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label="Draft attachment may not persist"
                className="absolute bottom-1 left-1 inline-flex size-5 items-center justify-center rounded-full bg-[var(--composer-surface)] text-amber-600 shadow-sm"
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

      <AttachmentRemoveButton
        size="md"
        label={`Remove ${image.name}`}
        onRemove={() => onRemoveImage(image.id)}
      />
    </div>
  );
});
