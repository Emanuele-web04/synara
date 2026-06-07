// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { pluralize } from "@t3tools/shared/text";

import { MessageCircleIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface AssistantSelectionsSummaryChipProps {
  selections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  onRemove?: (() => void) | undefined;
}

function selectionCountLabel(count: number): string {
  return `${count} ${pluralize(count, "selection")}`;
}

export function AssistantSelectionsSummaryChip(props: AssistantSelectionsSummaryChipProps) {
  if (props.selections.length === 0) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "group relative",
              COMPOSER_ATTACHMENT_CHIP_CLASS_NAME,
              props.onRemove ? "pr-6" : "",
            )}
          >
            <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full pl-2 pr-1.5">
              <MessageCircleIcon className="size-3.5 shrink-0 text-muted-foreground/90" />
              <span className="truncate">{selectionCountLabel(props.selections.length)}</span>
            </span>
            {props.onRemove ? (
              <button
                type="button"
                className="absolute right-0.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-text-foreground-tertiary)] transition-all hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
                aria-label="Remove selections"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onRemove?.();
                }}
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        <div className="space-y-2">
          {props.selections.map((selection) => (
            <p key={selection.id} className="text-xs leading-relaxed">
              {selection.text}
            </p>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
