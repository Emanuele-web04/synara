// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
//   Hover or click opens a numbered list of quotes with their comments; in the composer each
//   quote can be removed on its own.
// Layer: Chat attachment presentation

import { pluralize } from "@synara/shared/text";

import { MessageCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { COMPOSER_ATTACHMENT_CHIP_CLASS_NAME } from "../composerInlineChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AttachmentRemoveButton } from "./AttachmentRemoveButton";

interface AssistantSelectionsSummaryChipProps {
  selections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  onRemove?: (() => void) | undefined;
  onRemoveSelection?: ((selectionId: string) => void) | undefined;
}

function selectionCountLabel(count: number): string {
  return `${count} ${pluralize(count, "selection")}`;
}

export function AssistantSelectionsSummaryChip(props: AssistantSelectionsSummaryChipProps) {
  const { selections, onRemove, onRemoveSelection } = props;
  if (selections.length === 0) {
    return null;
  }
  const label = selectionCountLabel(selections.length);

  return (
    <Popover>
      <span
        className={cn("group relative", COMPOSER_ATTACHMENT_CHIP_CLASS_NAME, onRemove && "pr-6")}
      >
        <PopoverTrigger
          openOnHover
          delay={150}
          render={
            <button
              type="button"
              aria-label={`Show ${label}`}
              className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full pl-2 pr-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <MessageCircleIcon className="size-3.5 shrink-0 text-muted-foreground/90" />
              <span className="truncate">{label}</span>
            </button>
          }
        />
        {onRemove ? (
          <AttachmentRemoveButton
            size="md"
            tone="ghost"
            placement="center-right"
            label="Remove selections"
            onRemove={onRemove}
          />
        ) : null}
      </span>
      <PopoverPopup
        tooltipStyle
        side="top"
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] rounded-xl shadow-lg/10"
      >
        <ol className="max-h-72 min-w-0 overflow-y-auto overscroll-contain py-1">
          {selections.map((selection, index) => (
            <li
              key={selection.id}
              className={cn(
                "relative flex min-w-0 gap-2 rounded-lg px-2 py-1.5",
                onRemoveSelection && "pr-7",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--sidebar-accent-active)] text-ui-xs font-semibold text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="line-clamp-4 whitespace-pre-wrap text-wrap break-words text-ui leading-relaxed">
                  {selection.text}
                </p>
                {selection.comment ? (
                  <p className="whitespace-pre-wrap text-wrap break-words text-ui leading-relaxed text-muted-foreground">
                    {selection.comment}
                  </p>
                ) : null}
              </div>
              {onRemoveSelection ? (
                <AttachmentRemoveButton
                  size="md"
                  tone="ghost"
                  label={`Remove selection ${index + 1}`}
                  onRemove={() => onRemoveSelection(selection.id)}
                />
              ) : null}
            </li>
          ))}
        </ol>
      </PopoverPopup>
    </Popover>
  );
}
