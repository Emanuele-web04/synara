// FILE: PullRequestWarningNote.tsx
// Purpose: The amber "we couldn't show everything" callout the pull request surfaces reuse —
//          truncated review comments, truncated diffs, and per-repository load failures. One
//          warning skin so every bounded-data note reads identically, in the three shapes the
//          app actually mounts it in; pick a shape rather than re-cutting the geometry at the
//          call site.
// Layer: Pull request presentation
// Exports: PullRequestWarningNote, PullRequestWarningNoteShape

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
  shape = "note",
  ...props
}: HTMLAttributes<HTMLParagraphElement> & { shape?: PullRequestWarningNoteShape }) {
  return (
    <p
      {...props}
      className={cn(
        PR_META_TEXT_CLASS_NAME,
        // Amber carries the signal through the border and tint only; the copy stays on the
        // readable card ink, exactly like the shared Alert recipe. `--warning-foreground` is
        // the on-fill contrast ink (the runtime theme resolves it to the surface color), so
        // painting text with it over a 4% tint renders it invisible.
        "border border-warning/32 bg-warning/4 text-card-foreground",
        SHAPE_CLASS_NAME[shape],
        className,
      )}
    >
      {children}
    </p>
  );
}
