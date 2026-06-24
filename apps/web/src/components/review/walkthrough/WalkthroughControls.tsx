import type { ReactElement } from "react";

import { ChevronsUpDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export function WalkthroughControls(props: {
  diffStyle: "unified" | "split";
  onToggleDiffStyle: () => void;
}): ReactElement {
  const isSplit = props.diffStyle === "split";
  return (
    <div className="shrink-0 border-b border-border/40 bg-background px-4 py-2">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-end gap-2 px-5 sm:px-7">
        <button
          type="button"
          aria-label="Toggle split diff view"
          aria-pressed={isSplit}
          onClick={props.onToggleDiffStyle}
          className={cn(
            "group relative inline-flex h-7 items-center gap-1.5 rounded-[0.625rem] border border-border/70 bg-muted/40 px-2.5 text-[12px] text-foreground outline-none transition-[background-color,border-color,transform] duration-150 ease-out hover:border-border hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] pointer-coarse:after:absolute pointer-coarse:after:inset-0 pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 motion-reduce:transition-none motion-reduce:active:scale-100",
            isSplit ? "border-border bg-muted/60 hover:bg-muted/70" : "",
          )}
        >
          <span className="inline-block min-w-[2.75rem] text-left">
            {isSplit ? "Split" : "Unified"}
          </span>
          <ChevronsUpDownIcon
            className={cn(
              "size-3 text-muted-foreground transition-[transform,color] duration-150 ease-out motion-reduce:transition-none",
              isSplit && "rotate-90",
            )}
          />
        </button>
      </div>
    </div>
  );
}
