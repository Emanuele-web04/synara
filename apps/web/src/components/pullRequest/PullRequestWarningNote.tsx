import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";
import { PR_META_TEXT_CLASS_NAME } from "./pullRequestText";

export type PullRequestWarningNoteShape = "note" | "callout" | "banner";

const SHAPE_CLASS_NAME: Record<PullRequestWarningNoteShape, string> = {
  /** Inline inside a section that already has padding (the Comments list): tight and compact. */
  note: "rounded-md px-2 py-1.5",
  /** Standing on its own in a page's stack: the card radius of the surfaces around it. */
  callout: "rounded-lg px-3 py-2",
  /** Full-bleed across the top of a panel: squared off and down to its bottom rule, so it reads
   *  as part of the chrome instead of a card floating inside it. */
  banner: "rounded-none border-x-0 border-t-0 px-3 py-2",
};

export function PullRequestWarningNote({
  children,
  className,
  shape: shapeProp,
  ...props
}: HTMLAttributes<HTMLParagraphElement> & { shape?: PullRequestWarningNoteShape }) {
  const shape = shapeProp ?? "note";
  return (
    <p
      {...props}
      className={cn(
        PR_META_TEXT_CLASS_NAME,
        // amber carries the signal through border and tint only — `--warning-foreground` is the on-fill contrast ink, so painting text with it over a 4% tint renders it invisible
        "border border-warning/32 bg-warning/4 text-card-foreground",
        SHAPE_CLASS_NAME[shape],
        className,
      )}
    >
      {children}
    </p>
  );
}
