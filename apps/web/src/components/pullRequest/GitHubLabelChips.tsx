// FILE: GitHubLabelChips.tsx
// Purpose: GitHub labels as small outline badges with the label's color as a dot, shared by the
//          inbox rows (capped, with a "+N" overflow) and the item header (all of them); the dot
//          alone marks a label in the inbox's filter menu and chips. Label colors are untrusted
//          text, so only a validated hex ever reaches a style.
// Layer: Pull request presentation
// Exports: GitHubLabelChips, GitHubLabelDot

import type { PullRequestLabel } from "@synara/contracts";

import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import { safeGitHubLabelColor } from "./pullRequestList.logic";

/** A label's color as a dot; `color` must already be validated (see safeGitHubLabelColor). */
export function GitHubLabelDot({
  color,
  className,
}: {
  color: string | null | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full bg-muted-foreground/50", className)}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

export function GitHubLabelChips({
  labels,
  limit,
  className,
}: {
  labels: ReadonlyArray<PullRequestLabel>;
  /** Show at most this many chips; the rest collapse into one "+N" chip. */
  limit?: number;
  className?: string;
}) {
  if (labels.length === 0) return null;
  const shown = limit === undefined ? labels : labels.slice(0, limit);
  const hidden = labels.slice(shown.length);
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((label) => {
        const color = safeGitHubLabelColor(label.color);
        return (
          <Badge
            key={label.name}
            variant="outline"
            size="sm"
            className="max-w-[9rem] gap-1 font-normal text-muted-foreground"
            title={label.name}
          >
            <GitHubLabelDot color={color} />
            <span className="truncate">{label.name}</span>
          </Badge>
        );
      })}
      {hidden.length > 0 ? (
        <Badge
          variant="outline"
          size="sm"
          className="font-normal text-muted-foreground"
          title={hidden.map((label) => label.name).join(", ")}
        >
          +{hidden.length}
        </Badge>
      ) : null}
    </span>
  );
}
