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
  // toArray drops null/undefined/false, so conditional segments disappear entirely instead of leaving a stray separator dot
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
