import type { ReactElement } from "react";

import { ChevronsUpDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export function WalkthroughControls(props: {
  diffStyle: "unified" | "split";
  onToggleDiffStyle: () => void;
}): ReactElement {
  const isSplit = props.diffStyle === "split";
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border/40 bg-[var(--color-background-surface)] px-4 py-2">
      <button
        type="button"
        aria-pressed={isSplit}
        aria-label="Toggle split or unified diff"
        onClick={props.onToggleDiffStyle}
        className={cn(
          "group inline-flex h-7 items-center gap-1.5 rounded-md border border-border/40 bg-background px-2.5 text-[12px] text-foreground outline-none transition-[background-color,border-color,transform] duration-150 ease-out hover:border-border hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
          isSplit ? "bg-muted/40" : "",
        )}
      >
        <span className="inline-block min-w-[2.75rem] text-left">
          {isSplit ? "Split" : "Unified"}
        </span>
        <ChevronsUpDownIcon
          className={cn(
            "size-3 text-muted-foreground transition-[transform,color] duration-150 ease-out group-active:scale-90 motion-reduce:transition-none motion-reduce:group-active:scale-100",
            isSplit && "rotate-90",
          )}
        />
      </button>
    </div>
  );
}
