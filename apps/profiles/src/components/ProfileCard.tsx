// The public profile's building blocks: borderless rounded tiles on a quiet gray fill for
// the headline numbers, chart sections laid straight on the page, a small muted caption
// above each value, and the owner's accent kept for data marks only.

import type { ReactNode } from "react";

/**
 * A chart section laid straight on the page, no tile around it: a small muted caption row
 * (title left, detail right) over the content, with room above to separate it from the
 * section before.
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
    <section aria-label={title} className="flex min-w-0 flex-col gap-4 pt-9">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-muted-foreground">{title}</h2>
        {detail ? (
          <span className="truncate text-[13px] tabular-nums text-muted-foreground">{detail}</span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** One headline number: caption on top, value large, optional footnote. */
export function StatCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[22px] bg-[var(--tile)] px-5 py-4">
      <span className="truncate text-[13px] text-muted-foreground">{label}</span>
      <span className="truncate text-[26px] font-semibold leading-tight tracking-tight tabular-nums">
        {value}
      </span>
      {note ? <span className="truncate text-xs text-muted-foreground">{note}</span> : null}
    </div>
  );
}

/** A label/value row of a grouped list, hairline-separated from its siblings. */
export function ListRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--hairline)] py-3 first:border-t-0 first:pt-0 last:pb-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="m-0 truncate text-sm tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}
