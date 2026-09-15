// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { pluralize } from "@synara/shared/text";

import { MessageCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";

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
    <AttachmentSummaryChip
      icon={MessageCircleIcon}
      label={selectionCountLabel(props.selections.length)}
      removeLabel="Remove selections"
      onRemove={props.onRemove}
      tooltip={props.selections.map((selection) => (
        <div key={selection.id} className="space-y-0.5">
          {selection.comment ? (
            <p className="text-xs font-medium leading-relaxed">{selection.comment}</p>
          ) : null}
          <p
            className={cn("text-xs leading-relaxed", selection.comment && "text-muted-foreground")}
          >
            {selection.text}
          </p>
        </div>
      ))}
    />
  );
}
