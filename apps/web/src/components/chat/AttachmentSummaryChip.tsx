// FILE: AttachmentSummaryChip.tsx
// Purpose: Shared compact "count pill" for composer/transcript reference attachments
//   that collapse a list into one chip (assistant selections, file comments). Owns the
//   pill shell, leading-icon treatment, dismiss affordance, and hover tooltip so every
//   summary chip stays consistent; each kind supplies its icon, label, and tooltip body.
// Layer: Chat attachment presentation
// Exports: AttachmentSummaryChip

import { type ComponentType, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AttachmentRemoveButton } from "./AttachmentRemoveButton";

interface AttachmentSummaryChipProps {
  /** Leading glyph; rendered with the shared muted count-pill icon treatment. */
  icon: ComponentType<{ className?: string }>;
  /** Pill label, e.g. `3 selections`. */
  label: string;
  /** Accessible label for the dismiss button, e.g. `Remove selections`. */
  removeLabel: string;
  onRemove?: (() => void) | undefined;
  /** Tooltip body (stacked with consistent spacing). */
  tooltip: ReactNode;
}

export function AttachmentSummaryChip({
  icon: Icon,
  label,
  removeLabel,
  onRemove,
  tooltip,
}: AttachmentSummaryChipProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "group relative",
              COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
              onRemove && "pr-6",
            )}
          >
            <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full pl-2 pr-1.5">
              <Icon className="size-3.5 shrink-0 text-muted-foreground/90" />
              <span className="truncate">{label}</span>
            </span>
            {onRemove ? (
              <AttachmentRemoveButton
                size="md"
                tone="ghost"
                placement="center-right"
                label={removeLabel}
                onRemove={onRemove}
              />
            ) : null}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        <div className="space-y-2">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
