// FILE: sidebarNavOrdering.ts
// Purpose: Keeps the primary sidebar nav (New thread, Kanban or Tasks, Pull requests,
//          Automations) order and visibility stable across the sidebar and persisted settings.
// Layer: Web settings utility
// Exports: nav item ids, default order, normalization helpers, and the Kanban/Tasks slot.

import { isBetaFeatureOn } from "./betaFeatures";
import { normalizeIdOrder, normalizeKnownIds } from "./lib/orderedIds";

export const SIDEBAR_NAV_ITEM_IDS = [
  "newThread",
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
  return normalizeIdOrder(order, DEFAULT_SIDEBAR_NAV_ORDER, isSidebarNavItemId);
}

/**
 * Tasks replaces Kanban where the Beta-only "tasks" feature is on; Stable keeps Kanban until
 * Tasks is promoted. Both ids stay valid in persisted settings so neither app loses its layout.
 */
export const TASKS_SURFACE_ENABLED = isBetaFeatureOn("tasks");

/**
 * Kanban and Tasks share one slot in the nav and rail: the enabled surface takes the position
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
