// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { pluralize } from "@synara/shared/text";

import { MessageCircleIcon } from "~/lib/icons";
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
        <p key={selection.id} className="text-xs leading-relaxed">
          {selection.text}
        </p>
      ))}
    />
  );
}
