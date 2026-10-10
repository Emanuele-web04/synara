import type { ThreadId } from "@synara/contracts";

type ReminderStorage = Pick<Storage, "getItem" | "setItem">;

/** Same-origin receipts survive reloads; each thread owns its own key so tabs
 * cannot overwrite receipts for other threads with a stale whole-map write. */
export function claimSnoozeReminder(
  threadId: ThreadId,
  reminderAt: string,
  storage: ReminderStorage | undefined,
): boolean {
  if (!storage) return true;
  const key = `synara:snooze-reminder:v1:${threadId}`;
  try {
    const deliveredAt = storage.getItem(key);
    if (
      deliveredAt === reminderAt ||
      (deliveredAt !== null && Date.parse(deliveredAt) >= Date.parse(reminderAt))
    )
      return false;
    storage.setItem(key, reminderAt);
  } catch {
    // The runtime also deduplicates in memory when browser storage is blocked.
  }
  return true;
}
