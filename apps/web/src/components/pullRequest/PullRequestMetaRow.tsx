// FILE: PullRequestMetaRow.tsx
// Purpose: One label/value fact of a GitHub item: a fixed-width muted label (glyph + word) and
//          the value beside it, wrapping onto more lines when it needs them. Shared by the chat
//          dock's Summary tab and the code review page's info rows, so both list the same facts
//          in the same shape.
// Layer: Pull request presentation
// Exports: PullRequestMetaRow

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { PR_META_TEXT_CLASS_NAME } from "./pullRequestText";

export function PullRequestMetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(PR_META_TEXT_CLASS_NAME, "flex items-start gap-3 py-1.5")}>
      <span className="flex h-6 w-24 shrink-0 items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </span>
      <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-2 text-foreground">
        {children}
      </div>
    </div>
  );
}
