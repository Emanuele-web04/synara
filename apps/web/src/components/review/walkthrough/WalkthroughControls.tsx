import type { ReactElement } from "react";

import { ChevronsUpDownIcon } from "~/lib/icons";

export function WalkthroughControls(props: {
  diffStyle: "unified" | "split";
  onToggleDiffStyle: () => void;
}): ReactElement {
  const isSplit = props.diffStyle === "split";
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/35 bg-[var(--color-background-surface)] px-4 py-2">
      <button
        type="button"
        aria-pressed={isSplit}
        onClick={props.onToggleDiffStyle}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/45 bg-background px-2.5 text-[12px] text-foreground outline-none transition-[background-color] duration-150 hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        {isSplit ? "Split view" : "Unified view"}
        <ChevronsUpDownIcon className="size-3 text-muted-foreground" />
      </button>
    </div>
  );
}
