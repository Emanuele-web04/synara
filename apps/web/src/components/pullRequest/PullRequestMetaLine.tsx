// FILE: PullRequestMetaLine.tsx
// Purpose: The dot-separated metadata line every pull request surface writes — author · time ·
//          state under the detail title, repository · branch under a list row's title, files ·
//          counts above a diff. It owns the separator so the glyph, the spacing, and the fact
//          that it is punctuation rather than content (hence aria-hidden) cannot drift per
//          surface, and it draws separators between the segments that survive, so a
//          conditional segment can be `null` without leaving a stray dot behind.
// Layer: Pull request presentation
// Exports: PullRequestMetaLine

import { Children, isValidElement, type ReactNode } from "react";

import { cn } from "~/lib/utils";

/** `Children.toArray` keys every element it returns, so a separator can borrow the key of the
 *  segment it precedes and stay stable without counting positions. Plain text segments carry
 *  no key and are their own identity. */
function segmentKey(segment: ReactNode): string {
  return isValidElement(segment) ? String(segment.key) : String(segment);
}

/** Text size and ink come from the host line's own role — a list row's meta line is fine print,
 *  the detail header's is UI text — so this only owns the layout and the separators. */
export function PullRequestMetaLine({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  // toArray drops null/undefined/false, so `{condition ? <span/> : null}` segments disappear
  // entirely instead of the caller having to hand-manage the separator that follows them.
  const segments = Children.toArray(children);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {segments.flatMap((segment, index) =>
        index === 0
          ? segment
          : [
              <span aria-hidden className="shrink-0" key={`separator:${segmentKey(segment)}`}>
                ·
              </span>,
              segment,
            ],
      )}
    </span>
  );
}
