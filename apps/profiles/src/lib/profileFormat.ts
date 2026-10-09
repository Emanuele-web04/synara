// The few display helpers @synara/profile-ui/formatting doesn't cover, specific to the
// public page's copy: the "joined" line and the compact streak.

/** "Joined 30 days ago" from the account's creation instant and the owner's today. */
export function joinedAgo(createdAt: string, localToday?: string): string | null {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const today = localToday ? new Date(`${localToday}T00:00:00Z`) : new Date();
  const createdDay = Date.UTC(
    created.getUTCFullYear(),
    created.getUTCMonth(),
    created.getUTCDate(),
  );
  const todayDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.max(0, Math.round((todayDay - createdDay) / 86_400_000));
  if (days === 0) return "Joined today";
  if (days === 1) return "Joined yesterday";
  return `Joined ${days.toLocaleString("en-US")} days ago`;
}

/** A streak as the compact "12d", or an em dash before any activity. */
export function formatStreakShort(days: number): string {
  return days <= 0 ? "—" : `${days.toLocaleString("en-US")}d`;
}
