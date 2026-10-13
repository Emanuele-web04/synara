// FILE: AssistantSelectionsSummaryChip.tsx
// Purpose: Renders the compact assistant-selection count chip used in composer and user bubbles.
// Layer: Chat attachment presentation

import { pluralize } from "~/i18n/pluralize";

import { MessageCircleIcon } from "~/lib/icons";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { AttachmentSummaryChip } from "./AttachmentSummaryChip";
import { t } from "~/i18n";

interface AssistantSelectionsSummaryChipProps {
  selections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  onRemove?: (() => void) | undefined;
}

function selectionCountLabel(count: number): string {
  return t("{{value0}} {{value1}}", { value0: count, value1: pluralize(count, "selection") });
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
        <p key={selection.id} className="text-ui leading-relaxed">
          {selection.text}
        </p>
      ))}
    />
  );
}
