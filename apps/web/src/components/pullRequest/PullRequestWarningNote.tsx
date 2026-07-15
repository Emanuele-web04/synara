// FILE: PullRequestWarningNote.tsx
// Purpose: The amber "we couldn't show everything" callout the pull request surfaces reuse —
//          truncated review comments, and per-repository load failures. One warning skin so every
//          bounded-data note reads identically. Padding/radius stay caller-tunable via className.
// Layer: Pull request presentation
// Exports: PullRequestWarningNote

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export function PullRequestWarningNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "rounded-md border border-warning/32 bg-warning/4 px-2 py-1.5 text-xs text-warning-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
