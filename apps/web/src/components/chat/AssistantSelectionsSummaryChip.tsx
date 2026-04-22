// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

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
  return `${count} selection${count === 1 ? "" : "s"}`;
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
            <span className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full pl-2.5 pr-2">
              <MessageCircleIcon className="size-3.5 shrink-0 text-muted-foreground/90" />
              <span className="truncate">{selectionCountLabel(props.selections.length)}</span>
            </span>
            {props.onRemove ? (
              <button
                type="button"
                className="absolute right-0.5 inline-flex size-5 items-center justify-center rounded-full text-[var(--color-text-foreground-tertiary)] transition-all hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
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
