// FILE: ComposerLiveEditorContextChip.tsx
// Purpose: Shared compact composer chip for browser live-editor context attachments.
// Layer: Chat composer presentation

import { CircleAlertIcon, EyeIcon, XIcon } from "../../lib/icons";

interface ComposerLiveEditorContextChipProps {
  title: string;
  size?: "default" | "compact";
  nonPersisted?: boolean;
  nonPersistedTitle?: string;
  onPreview: () => void;
  onRemove?: () => void;
}

export function ComposerLiveEditorContextChip({
  title,
  size = "default",
  nonPersisted = false,
  nonPersistedTitle = "Draft live editor context could not be saved locally and may be lost on navigation.",
  onPreview,
  onRemove,
}: ComposerLiveEditorContextChipProps) {
  const compact = size === "compact";
  return (
    <div
      className={
        compact
          ? "inline-flex max-w-[142px] items-stretch overflow-hidden rounded-md border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-left shadow-sm"
          : "inline-flex max-w-[260px] items-stretch overflow-hidden rounded-md border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-left shadow-sm"
      }
    >
      <button
        type="button"
        className={
          compact
            ? "flex min-w-0 items-center gap-1.5 px-1.5 py-0.5 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            : "flex min-w-0 items-center gap-2 px-2 py-1 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        }
        aria-label={`Preview live editor context ${title}`}
        onClick={onPreview}
      >
        <span
          className={
            compact
              ? "flex size-4 shrink-0 items-center justify-center rounded bg-cyan-500/14 text-cyan-600"
              : "flex size-6 shrink-0 items-center justify-center rounded-md bg-cyan-500/14 text-cyan-600"
          }
        >
          <EyeIcon className={compact ? "size-2.5" : "size-3.5"} />
        </span>
        <span
          className={
            compact
              ? "min-w-0 truncate text-[10px] font-semibold leading-4 text-foreground/88"
              : "min-w-0 truncate text-[12px] font-semibold text-foreground/88"
          }
        >
          Live Editor Context
        </span>
      </button>

      {nonPersisted ? (
        <span
          role="img"
          aria-label="Draft attachment may not persist"
          title={nonPersistedTitle}
          className={
            compact
              ? "inline-flex size-5 shrink-0 items-center justify-center text-amber-600"
              : "inline-flex size-7 shrink-0 items-center justify-center text-amber-600"
          }
        >
          <CircleAlertIcon className={compact ? "size-2.5" : "size-3"} />
        </span>
      ) : null}

      {onRemove ? (
        <button
          type="button"
          className={
            compact
              ? "inline-flex w-5 shrink-0 items-center justify-center border-l border-[color:var(--color-border-light)] text-muted-foreground/62 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              : "inline-flex w-7 shrink-0 items-center justify-center border-l border-[color:var(--color-border-light)] text-muted-foreground/62 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          }
          onClick={onRemove}
          aria-label={`Remove live editor context ${title}`}
        >
          <XIcon className={compact ? "size-2.5" : "size-3"} />
        </button>
      ) : null}
    </div>
  );
}
