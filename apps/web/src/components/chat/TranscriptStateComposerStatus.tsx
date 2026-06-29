import type { ReactElement } from "react";

interface TranscriptStateComposerStatusProps {
  readonly label: string;
}

export function TranscriptStateComposerStatus({
  label,
}: TranscriptStateComposerStatusProps): ReactElement {
  return (
    <span
      role="status"
      aria-live="polite"
      className="min-w-0 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--color-text-foreground-secondary)]"
    >
      {label}
    </span>
  );
}
