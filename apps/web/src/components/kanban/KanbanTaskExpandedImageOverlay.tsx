// FILE: KanbanTaskExpandedImageOverlay.tsx
// Purpose: Fullscreen image preview overlay for task composer attachments.
// Layer: Kanban UI component
// Exports: KanbanTaskExpandedImageOverlay

import { Button } from "~/components/ui/button";
import { useTranslation } from "react-i18next";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "~/lib/icons";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";

interface KanbanTaskExpandedImageOverlayProps {
  readonly expandedImage: ExpandedImagePreview | null;
  readonly onClose: () => void;
  readonly onNavigate: (direction: -1 | 1) => void;
}

export function KanbanTaskExpandedImageOverlay({
  expandedImage,
  onClose,
  onNavigate,
}: KanbanTaskExpandedImageOverlayProps) {
  const { t } = useTranslation();
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  if (!expandedImage || !expandedImageItem) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label={t("kanban.expandedImagePreview")}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label={t("kanban.closeImagePreview")}
        onClick={onClose}
      />
      {expandedImage.images.length > 1 ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label={t("kanban.previousImage")}
          onClick={() => onNavigate(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      ) : null}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={onClose}
          aria-label={t("kanban.closeImagePreview")}
        >
          <XIcon />
        </Button>
        <img
          src={expandedImageItem.src}
          alt={expandedImageItem.name}
          className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] object-contain shadow-2xl"
          draggable={false}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {expandedImageItem.name}
          {expandedImage.images.length > 1
            ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
            : ""}
        </p>
      </div>
      {expandedImage.images.length > 1 ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label={t("kanban.nextImage")}
          onClick={() => onNavigate(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      ) : null}
    </div>
  );
}
