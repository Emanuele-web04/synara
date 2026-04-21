// FILE: TranscriptSelectionAction.tsx
// Purpose: Renders the floating "Add to chat" action for assistant transcript selections.
// Layer: Chat transcript interaction UI

import { MessageCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

interface TranscriptSelectionActionProps {
  left: number;
  top: number;
  placement: "top" | "bottom";
  onAddToChat: () => void;
}

export function TranscriptSelectionAction(props: TranscriptSelectionActionProps) {
  return (
    <div
      data-transcript-selection-action="true"
      className="pointer-events-none fixed z-50"
      style={{ left: props.left, top: props.top }}
      aria-hidden="true"
    >
      <button
        type="button"
        className={cn(
          "pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] px-3 text-[11px] font-medium text-[var(--color-text-foreground)] shadow-xl backdrop-blur-xl transition-transform duration-150 hover:scale-[1.01] hover:bg-[var(--color-background-elevated-secondary)]",
          props.placement === "top" ? "origin-bottom" : "origin-top",
        )}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onAddToChat();
        }}
      >
        <MessageCircleIcon className="size-3.5" />
        <span>Add to chat</span>
      </button>
    </div>
  );
}
