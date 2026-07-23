// FILE: BrowserAnnotationChip.tsx
// Purpose: Render one compact browser DOM annotation consistently in the composer and transcript.

import { type ComponentPropsWithoutRef } from "react";

import type { BrowserAnnotationDraft } from "~/lib/browserAnnotations";
import { formatBrowserAnnotationLabel } from "~/lib/browserAnnotations";
import { cn } from "~/lib/utils";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AttachmentRemoveButton } from "./AttachmentRemoveButton";

interface BrowserAnnotationChipProps
  extends Omit<ComponentPropsWithoutRef<"span">, "children" | "title"> {
  annotation: BrowserAnnotationDraft;
  onRemove?: (() => void) | undefined;
  variant?: "pill" | "list";
}

export function BrowserAnnotationChip({
  annotation,
  onRemove,
  variant = "pill",
  className,
  ...rest
}: BrowserAnnotationChipProps) {
  const label = formatBrowserAnnotationLabel(annotation);
  const pageLabel = annotation.source.pageTitle || annotation.source.url;
  const removeLabel = `Remove browser annotation ${annotation.ordinal}`;
  const trigger =
    variant === "list" ? (
      <span
        className={cn(
          "group relative flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-xs text-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)]",
          onRemove && "pr-8",
          className,
        )}
        aria-label={`Browser annotation ${annotation.ordinal}: ${label}, ${pageLabel}`}
        data-testid="browser-annotation-chip"
        {...rest}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--sidebar-accent-active)] text-[10px] font-semibold text-muted-foreground">
          {annotation.ordinal}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <span className="max-w-[40%] shrink truncate text-[11px] text-muted-foreground">
          {pageLabel}
        </span>
        {onRemove ? (
          <AttachmentRemoveButton
            size="sm"
            tone="ghost"
            placement="center-right"
            label={removeLabel}
            onRemove={onRemove}
          />
        ) : null}
      </span>
    ) : (
      <span
        className={cn(
          "group relative min-w-0 shrink",
          COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
          onRemove && "pr-5",
          className,
        )}
        aria-label={`Browser annotation ${annotation.ordinal}: ${label}, ${pageLabel}`}
        data-testid="browser-annotation-chip"
        {...rest}
      >
        <span className="inline-flex h-6 min-w-0 max-w-[11rem] items-center gap-1.5 rounded-full pl-2 pr-2">
          <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">
            #{annotation.ordinal}
          </span>
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {onRemove ? (
          <AttachmentRemoveButton
            size="sm"
            tone="ghost"
            placement="center-right"
            label={removeLabel}
            onRemove={onRemove}
          />
        ) : null}
      </span>
    );

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">
            #{annotation.ordinal} · {label}
          </p>
          <p className="text-[0.6875rem] text-muted-foreground">{pageLabel}</p>
          <p className="break-all font-mono text-[0.625rem] text-muted-foreground/80">
            {annotation.selector}
          </p>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
