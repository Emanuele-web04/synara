import { COORDINATOR_SUGGESTION_CHIPS } from "./coordinatorSuggestions.logic";

export function CoordinatorSuggestions({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-28">
      <div className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
        Suggestions
      </div>
      <div className="flex flex-wrap gap-2">
        {COORDINATOR_SUGGESTION_CHIPS.map((label) => (
          <button
            key={label}
            type="button"
            className="rounded-full border border-[color:var(--color-border-light)] px-3 py-1 text-[length:var(--app-font-size-ui,12px)] text-foreground hover:bg-foreground/5"
            onClick={onOpenSettings}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
