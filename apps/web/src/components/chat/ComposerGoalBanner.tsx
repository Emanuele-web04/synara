import { FlagIcon, XIcon } from "~/lib/icons";

export function ComposerGoalBanner({
  goal,
  onClear,
}: {
  goal: string;
  onClear: () => void | Promise<void>;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-4 py-2 sm:px-5">
      <FlagIcon className="size-3.5 shrink-0 text-muted-foreground/65" aria-hidden />
      <span className="shrink-0 text-[11px] font-semibold text-muted-foreground/65">Goal</span>
      <span
        className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-foreground-secondary)]"
        title={goal}
      >
        {goal}
      </span>
      <button
        type="button"
        aria-label="Clear thread goal"
        title="Clear thread goal"
        onClick={() => void onClear()}
        className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground/60 transition-colors duration-150 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)] motion-reduce:transition-none"
      >
        <XIcon className="size-3" aria-hidden />
      </button>
    </div>
  );
}
