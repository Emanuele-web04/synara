// FILE: BrowserAnnotationStrip.tsx
// Purpose: Keep browser annotations to one compact row, with overflow available on demand.
// Layer: Chat attachment presentation

import { pluralize } from "@synara/shared/text";

import type { BrowserAnnotationDraft } from "~/lib/browserAnnotations";
import { cn } from "~/lib/utils";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { BrowserAnnotationChip } from "./BrowserAnnotationChip";

export const MAX_VISIBLE_BROWSER_ANNOTATIONS = 2;

interface BrowserAnnotationStripProps {
  annotations: ReadonlyArray<BrowserAnnotationDraft>;
  onRemove?: ((annotationId: string) => void) | undefined;
  className?: string | undefined;
}

function overflowLabel(count: number): string {
  return `+${count} ${pluralize(count, "other")}`;
}

export function BrowserAnnotationStrip({
  annotations,
  onRemove,
  className,
}: BrowserAnnotationStripProps) {
  if (annotations.length === 0) {
    return null;
  }

  const visibleAnnotations = annotations.slice(0, MAX_VISIBLE_BROWSER_ANNOTATIONS);
  const hiddenAnnotations = annotations.slice(MAX_VISIBLE_BROWSER_ANNOTATIONS);

  return (
    <div
      className={cn(
        "flex h-7 w-full max-w-[28rem] flex-nowrap items-center gap-1 overflow-hidden",
        className,
      )}
      data-testid="browser-annotation-strip"
    >
      {visibleAnnotations.map((annotation) => (
        <BrowserAnnotationChip
          key={annotation.id}
          annotation={annotation}
          className="min-w-0"
          onRemove={onRemove ? () => onRemove(annotation.id) : undefined}
        />
      ))}
      {hiddenAnnotations.length > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className={cn(
                  COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
                  "h-6 shrink-0 px-2 transition-colors hover:bg-[var(--color-background-button-secondary-hover)]",
                )}
                aria-label={`Show ${hiddenAnnotations.length} more browser ${pluralize(
                  hiddenAnnotations.length,
                  "annotation",
                )}`}
                data-testid="browser-annotation-overflow"
              >
                {overflowLabel(hiddenAnnotations.length)}
              </button>
            }
          />
          <PopoverPopup
            tooltipStyle
            side="top"
            align="end"
            className="w-80 max-w-[calc(100vw-2rem)] rounded-xl shadow-lg/10"
          >
            <div className="min-w-0 py-1">
              <p className="px-2 pb-1.5 text-[11px] font-medium text-muted-foreground">
                {hiddenAnnotations.length} more{" "}
                {pluralize(hiddenAnnotations.length, "annotation")}
              </p>
              <div
                className="max-h-52 overflow-y-auto overscroll-contain pr-0.5"
                data-testid="browser-annotation-overflow-list"
              >
                {hiddenAnnotations.map((annotation) => (
                  <BrowserAnnotationChip
                    key={annotation.id}
                    annotation={annotation}
                    variant="list"
                    onRemove={onRemove ? () => onRemove(annotation.id) : undefined}
                  />
                ))}
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
