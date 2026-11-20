import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";

import type { ThreadStatusPill } from "./Sidebar.logic";
import {
  ACTIVITY_PRIORITY_TIER_RANK,
  type ActivityPriorityTier,
  resolveActivityPriorityTier,
} from "./SidebarActivityView.logic";
import { UNREAD_COMPLETION_DOT_CLASS_NAME } from "./SidebarStatusTrailingGlyph";

const MAX_VISIBLE_DOTS = 5;

const tierRank = (tier: ActivityPriorityTier | null) =>
  tier === null ? Number.POSITIVE_INFINITY : ACTIVITY_PRIORITY_TIER_RANK[tier];

/**
 * One dot per child thread, in its status pill's color (unread ones in the sidebar's unread
 * accent), most urgent first; idle children stay grey. The dots are static on purpose: an
 * animated glyph here repaints the translucent sidebar every frame.
 */
export function SidebarChildThreadStatusDots({
  statuses,
  className,
}: {
  statuses: readonly (ThreadStatusPill | null)[];
  className?: string;
}) {
  const { t } = useTranslation();
  if (statuses.length === 0) return null;
  const tiers = statuses.map(resolveActivityPriorityTier);
  const dotClassNames = statuses
    .map((status, index) => ({ status, rank: tierRank(tiers[index] ?? null) }))
    .toSorted((left, right) => left.rank - right.rank)
    .slice(0, MAX_VISIBLE_DOTS)
    .map(({ status }) =>
      // A finished child shows the same accent dot here as on its own row.
      status?.label === "Completed"
        ? UNREAD_COMPLETION_DOT_CLASS_NAME
        : (status?.dotClass ?? "bg-muted-foreground/30"),
    );
  const countOf = (wanted: ActivityPriorityTier | null) =>
    tiers.filter((tier) => tier === wanted).length;
  const label = (
    [
      { count: countOf("waiting"), key: "workspace:childThreadsWaiting" },
      { count: countOf("working"), key: "workspace:childThreadsWorking" },
      { count: countOf("unread"), key: "workspace:childThreadsUnread" },
      { count: countOf(null), key: "workspace:childThreadsIdle" },
    ] as const
  )
    .filter(({ count }) => count > 0)
    .map(({ count, key }) => t(key, { count }))
    .join(", ");
  const hiddenCount = statuses.length - MAX_VISIBLE_DOTS;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-slot="child-thread-status-dots"
      className={cn("inline-flex shrink-0 items-center gap-[3px]", className)}
    >
      {dotClassNames.map((dotClassName, index) => (
        <span
          // Dots have no identity of their own; only the count and colors matter.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", dotClassName)}
        />
      ))}
      {hiddenCount > 0 ? (
        <span aria-hidden="true" className="text-ui-xs leading-none text-muted-foreground/60">
          +{hiddenCount}
        </span>
      ) : null}
    </span>
  );
}
