// FILE: ComposerLiveEditorContextChip.tsx
// Purpose: Shared compact composer chip for browser live-editor context attachments.
// Layer: Chat composer presentation

import { CircleAlertIcon, EyeIcon, XIcon } from "../../lib/icons";

interface ComposerLiveEditorContextChipProps {
  title: string;
  nonPersisted?: boolean;
  nonPersistedTitle?: string;
  onPreview: () => void;
  onRemove: () => void;
}

export function ComposerLiveEditorContextChip({
  title,
  nonPersisted = false,
  nonPersistedTitle = "Draft live editor context could not be saved locally and may be lost on navigation.",
  onPreview,
  onRemove,
}: ComposerLiveEditorContextChipProps) {
  return (
    <div className="inline-flex max-w-[260px] items-stretch overflow-hidden rounded-md border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-left shadow-sm">
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 px-2 py-1 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={`Preview live editor context ${title}`}
        onClick={onPreview}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-cyan-500/14 text-cyan-600">
          <EyeIcon className="size-3.5" />
        </span>
        <span className="min-w-0 truncate text-[12px] font-semibold text-foreground/88">
          Live Editor Context
        </span>
      </button>

      {nonPersisted ? (
        <span
          role="img"
          aria-label="Draft attachment may not persist"
          title={nonPersistedTitle}
          className="inline-flex size-7 shrink-0 items-center justify-center text-amber-600"
        >
          <CircleAlertIcon className="size-3" />
        </span>
      ) : null}

      <button
        type="button"
        className="inline-flex w-7 shrink-0 items-center justify-center border-l border-[color:var(--color-border-light)] text-muted-foreground/62 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onRemove}
        aria-label={`Remove live editor context ${title}`}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
