import { FlagIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export function ComposerGoalChip({
  label,
  onClear,
  className,
}: {
  label: string;
  onClear: () => void;
  className?: string;
}) {
  const title = `Goal: ${label}`;

  return (
    <div
      className={cn(
        "group flex h-7 min-w-0 max-w-48 shrink items-center gap-1 rounded-md border border-transparent px-2 text-[length:var(--app-font-size-ui-sm,11px)] text-[var(--color-text-foreground-secondary)] transition-colors hover:border-[color:var(--color-border)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-within:border-[color:var(--color-border)] focus-within:bg-[var(--color-background-button-secondary-hover)] focus-within:text-[var(--color-text-foreground)]",
        className,
      )}
      data-testid="composer-goal-chip"
      title={title}
    >
      <FlagIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-80" />
      <span className="min-w-0 truncate">{label}</span>
      <Button
        aria-label="Disable goal"
        className="-mr-1 size-5 shrink-0 rounded-sm p-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={onClear}
        size="icon-chip"
        title="Disable goal"
        variant="ghost"
      >
        <XIcon aria-hidden="true" className="size-3" />
      </Button>
    </div>
  );
}
