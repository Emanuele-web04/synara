// FILE: PastedTextChip.tsx
// Purpose: Attachment-style "pasted text" cards for the collapsed big-paste feature
//   - the composer card (insert-into-field / remove) and the transcript card
//   (click-to-expand echo of a sent paste).
// Layer: Chat composer/transcript presentation

import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";

import { ChevronRightIcon, FileIcon } from "~/lib/icons";
import { formatPastedTextCountLabel, pastedTextTitle } from "~/lib/composerPastedText";
import { AttachmentCard } from "./AttachmentCard";

interface PastedTextCardMetrics {
  lineCount: number;
  charCount: number;
}

// Shared underlined affordance under the card title ("Show in text field" /
// "Show text"). Callers supply the content and behavior; the treatment is fixed.
function PastedTextCardAction({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="-ml-px inline-flex w-fit items-center gap-0.5 text-[11px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60 focus-visible:outline-none"
      {...props}
    >
      {children}
    </button>
  );
}

function PastedTextCardShell({
  text,
  metrics,
  action,
  onRemove,
  className,
}: {
  text: string;
  metrics: PastedTextCardMetrics;
  action: ReactNode;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <AttachmentCard
      size="sm"
      className={className}
      icon={<FileIcon className="size-3" />}
      title={pastedTextTitle(text)}
      subtitle={action}
      onRemove={onRemove}
      removeLabel={`Remove pasted text (${formatPastedTextCountLabel(metrics)})`}
    />
  );
}

interface ComposerPastedTextCardProps {
  text: string;
  metrics: PastedTextCardMetrics;
  onShowInTextField: () => void;
  onRemove: () => void;
}

// Composer attachment card: a document tile, the first line of the paste, and a
// "Show in text field" action that drops the full text back into the editor.
export function ComposerPastedTextCard({
  text,
  metrics,
  onShowInTextField,
  onRemove,
}: ComposerPastedTextCardProps) {
  return (
    <PastedTextCardShell
      text={text}
      metrics={metrics}
      onRemove={onRemove}
      action={
        <PastedTextCardAction
          onMouseDown={(event) => event.preventDefault()}
          onClick={onShowInTextField}
        >
          Show in text field
          <ChevronRightIcon className="size-2.5" />
        </PastedTextCardAction>
      }
    />
  );
}

interface UserMessagePastedTextCardProps {
  text: string;
  metrics: PastedTextCardMetrics;
}

// Transcript echo: the same card, but the action expands the full pasted content
// in place (read-only) instead of editing.
export function UserMessagePastedTextCard({ text, metrics }: UserMessagePastedTextCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col items-start gap-1">
      <PastedTextCardShell
        text={text}
        metrics={metrics}
        action={
          <PastedTextCardAction
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide text" : "Show text"}
            <span className="opacity-65">· {formatPastedTextCountLabel(metrics)}</span>
          </PastedTextCardAction>
        }
      />
      {expanded ? (
        <pre className="max-h-80 w-full max-w-full overflow-auto rounded-md border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words text-foreground">
          {text}
        </pre>
      ) : null}
    </div>
  );
}
