// FILE: TranscriptSelectionAction.tsx
// Purpose: Renders the floating toolbar for assistant transcript selections.
// Layer: Chat transcript interaction UI

import type { ReactNode } from "react";
import { MessageCircleIcon, PencilIcon, TextWrapIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

interface TranscriptSelectionActionProps {
  left: number;
  top: number;
  placement: "top" | "bottom";
  // Highlight/underline only make sense for transcript text; read-only code
  // surfaces (file preview, diff view) omit them and get an add-only toolbar.
  onHighlight?: (() => void) | undefined;
  onUnderline?: (() => void) | undefined;
  onAddToChat: () => void;
}

function TranscriptSelectionToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)]"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

export function TranscriptSelectionAction(props: TranscriptSelectionActionProps) {
  return (
    <div
      data-transcript-selection-action="true"
      className="pointer-events-none fixed z-50"
      style={{ left: props.left, top: props.top }}
      role="toolbar"
      aria-label="Selection actions"
    >
      <div
        className={cn(
          "pointer-events-auto inline-flex items-center gap-0.5 rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] p-0.5 shadow-xl backdrop-blur-xl transition-transform duration-150 hover:scale-[1.01]",
          props.placement === "top" ? "origin-bottom" : "origin-top",
        )}
      >
        {props.onHighlight ? (
          <TranscriptSelectionToolbarButton label="Highlight" onClick={props.onHighlight}>
            <PencilIcon className="size-3.5" />
          </TranscriptSelectionToolbarButton>
        ) : null}
        {props.onUnderline ? (
          <TranscriptSelectionToolbarButton label="Underline" onClick={props.onUnderline}>
            <TextWrapIcon className="size-3.5" />
          </TranscriptSelectionToolbarButton>
        ) : null}
        <TranscriptSelectionToolbarButton label="Add to chat" onClick={props.onAddToChat}>
          <MessageCircleIcon className="size-3.5" />
        </TranscriptSelectionToolbarButton>
      </div>
    </div>
  );
}
