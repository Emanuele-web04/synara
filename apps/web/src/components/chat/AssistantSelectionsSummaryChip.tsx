// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { MessageCircleIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ChatAssistantSelectionAttachment } from "../../types";
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
              "group relative inline-flex min-w-0 max-w-full items-center rounded-full border border-border/60 bg-background/92 p-0.5 text-[11px] font-medium text-foreground/92 shadow-[0_1px_0_rgba(255,255,255,0.14)_inset]",
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
                className="pointer-events-none absolute right-0.5 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground/62 opacity-0 transition-all hover:bg-accent/36 hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100"
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
