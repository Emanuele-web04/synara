// The public profile's building blocks: sections laid straight on the page under a small
// muted caption, and the headline numbers as plain caption-over-value pairs. No tiles or
// borders; the owner's accent is kept for data marks only.

import type { ReactNode } from "react";

/**
 * A section laid straight on the page: a small muted caption row (title left, detail
 * right) over the content.
 */
export function ProfileSection({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold text-muted-foreground">{title}</h2>
        {detail ? (
          <span className="truncate text-xs font-semibold tabular-nums text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** One headline number: a small muted caption over the value. */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="truncate text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="truncate text-xl leading-tight tabular-nums">{value}</span>
    </div>
  );
}
