// FILE: ComposerImageAttachmentChip.tsx
// Purpose: Renders image attachments, including source-aware AppSnap cards.
// Layer: Chat composer presentation
// Depends on: composer draft image metadata, shared chip styles, and expanded image preview helpers.

import { WindowIcon } from "~/lib/icons";
import { type ComposerImageAttachment } from "../../composerDraftStore";
import { normalizeComposerImageSource } from "../../lib/composerImageSource";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AttachmentRemoveButton } from "./AttachmentRemoveButton";
import {
  DRAFT_ATTACHMENT_WARNING_DESCRIPTION,
  DraftAttachmentWarningIcon,
} from "./DraftAttachmentWarning";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

interface ComposerImageAttachmentChipProps {
  image: ComposerImageAttachment;
  images: readonly ComposerImageAttachment[];
  nonPersisted: boolean;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemoveImage: (imageId: string) => void;
}

export function ComposerImageAttachmentChip({
  image,
  images,
  nonPersisted,
  onExpandImage,
  onRemoveImage,
}: ComposerImageAttachmentChipProps) {
  // Normalize here so a legacy "appshot" provenance still renders as an AppSnap.
  const appSnapSource = normalizeComposerImageSource(image.source) ?? null;
  const previewImage = () => {
    const preview = buildExpandedImagePreview(images, image.id);
    if (!preview) return;
    onExpandImage(preview);
  };

  if (appSnapSource) {
    const appName = appSnapSource.appName?.trim() || "Captured app";
    const windowTitle = appSnapSource.windowTitle?.trim() || null;
    // Lead with the captured window title, but avoid repeating an app whose title
    // merely echoes its name (e.g. "ChatGPT / ChatGPT").
    const provenance =
      windowTitle && windowTitle.localeCompare(appName, undefined, { sensitivity: "accent" }) !== 0
        ? `${windowTitle} / ${appName}`
        : appName;
    const appIconDataUrl = appSnapSource.appIconDataUrl ?? null;

    return (
      <div className="group relative h-32 w-52 shrink-0 overflow-hidden rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-secondary)] transition-colors duration-150 hover:border-[color:var(--color-border)]">
        <button
          type="button"
          className="relative flex size-full items-center justify-center overflow-hidden bg-[var(--color-background-secondary)] p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={`Preview AppSnap from ${appName}`}
          title={provenance}
          onClick={previewImage}
        >
          {image.previewUrl ? (
            <img
              src={image.previewUrl}
              alt={image.name}
              className="max-h-full max-w-full rounded-md object-contain"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-[10px] font-medium text-muted-foreground/70">
              IMG
            </span>
          )}

          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-end gap-2 bg-linear-to-t from-black/90 via-black/55 to-transparent px-2.5 pb-2 pt-10 text-left">
            {appIconDataUrl ? (
              <img
                src={appIconDataUrl}
                alt=""
                className="size-5 shrink-0 rounded-[5px] object-contain shadow-sm"
              />
            ) : (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-white/15 text-white/85 backdrop-blur-sm">
                <WindowIcon className="size-3" aria-hidden="true" />
              </span>
            )}
            <span
              className="min-w-0 flex-1 truncate pb-px text-[11px] font-medium text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]"
              title={provenance}
            >
              {provenance}
            </span>
          </span>
        </button>

        {nonPersisted && (
          <Tooltip>
            <TooltipTrigger
              render={
                <DraftAttachmentWarningIcon variant="badge" className="absolute left-1.5 top-1.5" />
              }
            />
            <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
              {DRAFT_ATTACHMENT_WARNING_DESCRIPTION}
            </TooltipPopup>
          </Tooltip>
        )}

        <AttachmentRemoveButton
          size="sm"
          label={`Remove AppSnap from ${appName}`}
          className="opacity-70 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
          onRemove={() => onRemoveImage(image.id)}
        />
      </div>
    );
  }

  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        className="block size-16 overflow-hidden rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] transition-colors hover:border-[color:var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Preview ${image.name}`}
        title={image.name}
        onClick={previewImage}
      >
        {image.previewUrl ? (
          <img src={image.previewUrl} alt={image.name} className="size-full object-cover" />
        ) : (
          <span className="flex size-full items-center justify-center text-[10px] font-medium text-muted-foreground/70">
            IMG
          </span>
        )}
      </button>

      {nonPersisted && (
        <Tooltip>
          <TooltipTrigger
            render={
              <DraftAttachmentWarningIcon variant="badge" className="absolute bottom-1 left-1" />
            }
          />
          <TooltipPopup side="top" className="max-w-64 whitespace-normal leading-tight">
            {DRAFT_ATTACHMENT_WARNING_DESCRIPTION}
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
}
