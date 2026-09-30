// FILE: sidebarNavOrdering.ts
// Purpose: Keeps primary sidebar navigation order and visibility stable, including Inbox
//          availability and the shared Kanban/Tasks slot.
// Layer: Web settings utility
// Exports: nav item ids, default order, normalization helpers, and the Kanban/Tasks slot.

import { normalizeIdOrder, normalizeKnownIds, placeNewIdAfter } from "./lib/orderedIds";

/** Inbox is Beta-only: the sidebar drops it where INBOX_ON is off. */
export const SIDEBAR_NAV_ITEM_IDS = [
  "newThread",
  "inbox",
  "kanban",
  "tasks",
  "pullRequests",
  "automations",
] as const;

export type SidebarNavItemId = (typeof SIDEBAR_NAV_ITEM_IDS)[number];

export const DEFAULT_SIDEBAR_NAV_ORDER: readonly SidebarNavItemId[] = SIDEBAR_NAV_ITEM_IDS;

const SIDEBAR_NAV_ITEM_ID_SET: ReadonlySet<SidebarNavItemId> = new Set(SIDEBAR_NAV_ITEM_IDS);

export function isSidebarNavItemId(value: string): value is SidebarNavItemId {
  return SIDEBAR_NAV_ITEM_ID_SET.has(value as SidebarNavItemId);
}

export function normalizeHiddenSidebarNavItems(
  hiddenItems: ReadonlyArray<string>,
): SidebarNavItemId[] {
  return normalizeKnownIds(hiddenItems, isSidebarNavItemId);
}

export function normalizeSidebarNavOrder(order: ReadonlyArray<string>): SidebarNavItemId[] {
  const normalized = normalizeIdOrder(order, DEFAULT_SIDEBAR_NAV_ORDER, isSidebarNavItemId);
  // Inbox shipped after users saved an order: it joins under New thread, as by default.
  return placeNewIdAfter(normalized, order, "inbox", "newThread");
}

/**
 * Kanban and Tasks share one slot in the nav and rail (see tasksSurface.ts for which one
 * shows). Both ids stay valid in persisted settings so neither app loses its layout: the enabled surface takes the position
 * of whichever of the two comes first in the stored order, and the other is left out.
 */
export function resolveTasksSurfaceSlot<Id extends string>(
  order: readonly Id[],
  tasksEnabled: boolean,
): Id[] {
  const active = (tasksEnabled ? "tasks" : "kanban") as Id;
  let placed = false;
  const resolved: Id[] = [];
  for (const id of order) {
    if (id !== "kanban" && id !== "tasks") {
      resolved.push(id);
    } else if (!placed) {
      resolved.push(active);
      placed = true;
    }
  }
  return resolved;
}
