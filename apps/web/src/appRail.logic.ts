// FILE: appRail.logic.ts
// Purpose: Pure rules for the rail layout's tab strip: item ids, route item order, and
//          which item is active for a pathname, plus the Spaces panel's section list.
// Layer: Web shell logic
// Exports: rail item ids/types, rail item order and visibility, railItemForPathname,
//          reconcileActiveRailItem, buildRailSpacesSections

import type { ProjectId, SpaceId } from "@synara/contracts";

import {
  groupItemsBySpace,
  orderedSpaceIdsForPicker,
  spaceDisplayName,
  spaceKey,
  VOID_SPACE_KEY,
  type VoidSpacePresentation,
} from "./lib/spaceGrouping";
import { normalizeIdOrder, normalizeKnownIds } from "./lib/orderedIds";
import type { SidebarNavItemId } from "./sidebarNavOrdering";
import type { Space } from "./types";

/** Rail items that switch the panel content instead of navigating. */
export const RAIL_PANEL_ITEM_IDS = ["home", "spaces"] as const;
export type RailPanelItemId = (typeof RAIL_PANEL_ITEM_IDS)[number];
export const RAIL_PANEL_ITEM_LABELS: Record<RailPanelItemId, string> = {
  home: "Home",
  spaces: "Spaces",
};
/** Rail items that navigate to a route. "New thread" stays in the panel, never the rail. */
export type RailRouteItemId = Exclude<SidebarNavItemId, "newThread"> | "studio" | "settings";
export type RailItemId = RailPanelItemId | RailRouteItemId;

/**
 * Rail items the user orders and hides from Customize. Settings stays pinned at the bottom;
 * Studio is also reachable from the "…" menu, so it starts hidden.
 */
export const RAIL_ORDERABLE_ITEM_IDS = [
  "home",
  "spaces",
  "kanban",
  "pullRequests",
  "automations",
  "studio",
] as const;
export type RailOrderableItemId = (typeof RAIL_ORDERABLE_ITEM_IDS)[number];
export const DEFAULT_HIDDEN_RAIL_ITEMS: readonly RailOrderableItemId[] = ["studio"];

const RAIL_ORDERABLE_ITEM_ID_SET: ReadonlySet<string> = new Set(RAIL_ORDERABLE_ITEM_IDS);

export function isRailOrderableItemId(value: string): value is RailOrderableItemId {
  return RAIL_ORDERABLE_ITEM_ID_SET.has(value);
}

/** Home is the rail's anchor for the panel: it can move but never be hidden. */
export function railItemCanHide(id: RailOrderableItemId): boolean {
  return id !== "home";
}

export function normalizeRailItemOrder(order: readonly string[]): RailOrderableItemId[] {
  return normalizeIdOrder(order, RAIL_ORDERABLE_ITEM_IDS, isRailOrderableItemId);
}

export function normalizeHiddenRailItems(hidden: readonly string[]): RailOrderableItemId[] {
  return normalizeKnownIds(hidden, isRailOrderableItemId).filter(railItemCanHide);
}

/**
 * The rail's top items in the user's order. Hidden items drop out unless they are the
 * active item, so hiding a section never strands the user in it; Studio needs its section
 * enabled in Settings.
 */
export function buildRailItemOrder(input: {
  order: readonly RailOrderableItemId[];
  hidden: ReadonlySet<RailOrderableItemId>;
  activeItem: RailItemId;
  studioAvailable: boolean;
}): RailOrderableItemId[] {
  return input.order.filter(
    (id) =>
      (id !== "studio" || input.studioAvailable) &&
      (!input.hidden.has(id) || id === input.activeItem),
  );
}

/** A Space or a single project the user added to the rail from its "…" menu. */
export type RailShortcut =
  | { readonly kind: "space"; readonly key: string; readonly spaceId: SpaceId | null }
  | { readonly kind: "project"; readonly key: string; readonly projectId: ProjectId };

const SPACE_SHORTCUT_PREFIX = "space:";
const PROJECT_SHORTCUT_PREFIX = "project:";

export function railSpaceShortcutKey(spaceId: SpaceId | null): string {
  return `${SPACE_SHORTCUT_PREFIX}${spaceKey(spaceId)}`;
}

export function railProjectShortcutKey(projectId: ProjectId): string {
  return `${PROJECT_SHORTCUT_PREFIX}${projectId}`;
}

/**
 * The persisted shortcut keys that still point at something, in their saved order: unknown,
 * deleted, and duplicate entries drop out (Void always exists).
 */
export function resolveRailShortcuts(input: {
  keys: readonly string[];
  spaceIds: ReadonlySet<SpaceId>;
  projectIds: ReadonlySet<ProjectId>;
}): RailShortcut[] {
  const seen = new Set<string>();
  const shortcuts: RailShortcut[] = [];
  for (const key of input.keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (key.startsWith(SPACE_SHORTCUT_PREFIX)) {
      const id = key.slice(SPACE_SHORTCUT_PREFIX.length);
      if (id === VOID_SPACE_KEY) {
        shortcuts.push({ kind: "space", key, spaceId: null });
      } else if (input.spaceIds.has(id as SpaceId)) {
        shortcuts.push({ kind: "space", key, spaceId: id as SpaceId });
      }
    } else if (key.startsWith(PROJECT_SHORTCUT_PREFIX)) {
      const id = key.slice(PROJECT_SHORTCUT_PREFIX.length) as ProjectId;
      if (input.projectIds.has(id)) shortcuts.push({ kind: "project", key, projectId: id });
    }
  }
  return shortcuts;
}

/** Adds a shortcut at the end of the rail, or removes it when it is already there. */
export function toggleRailShortcutKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

/**
 * The shortcut that stands for what the panel shows, so exactly one rail item is active:
 * a pinned Space while Home shows that Space, a pinned project while Spaces shows its threads.
 */
export function resolveActiveRailShortcutKey(input: {
  activeItem: RailItemId;
  activeSpaceId: SpaceId | null;
  spacesProjectId: ProjectId | null;
  shortcuts: readonly RailShortcut[];
}): string | null {
  for (const shortcut of input.shortcuts) {
    if (
      shortcut.kind === "space" &&
      input.activeItem === "home" &&
      shortcut.spaceId === input.activeSpaceId
    ) {
      return shortcut.key;
    }
    if (
      shortcut.kind === "project" &&
      input.activeItem === "spaces" &&
      shortcut.projectId === input.spacesProjectId
    ) {
      return shortcut.key;
    }
  }
  return null;
}

/**
 * Whether the panel column shows next to the rail for the active item. Every section either
 * owns a panel (Home/Spaces: projects and threads; Automations, Studio, Settings: their own
 * lists) or takes the full width: Kanban is one board, Pull requests has its own list and
 * detail panes.
 */
export function railItemShowsPanel(id: RailItemId): boolean {
  return id !== "kanban" && id !== "pullRequests";
}

function matchesRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** The route rail item that owns a pathname, or null for thread and chat-index routes. */
export function railItemForPathname(pathname: string): RailRouteItemId | null {
  if (matchesRoute(pathname, "/kanban")) return "kanban";
  if (matchesRoute(pathname, "/pull-requests")) return "pullRequests";
  if (matchesRoute(pathname, "/automations")) return "automations";
  if (matchesRoute(pathname, "/studio")) return "studio";
  if (matchesRoute(pathname, "/settings")) return "settings";
  return null;
}

/**
 * Re-syncs the active item after navigation: a route item wins when the pathname is its
 * route (shortcut, deep link, command palette); a Studio thread lives at a plain thread
 * path, so the sidebar's Studio detection counts as the Studio route; anywhere else the
 * current panel item is active, so exactly one rail item is active at a time.
 */
export function reconcileActiveRailItem(input: {
  current: RailItemId;
  pathname: string;
  onStudioSurface: boolean;
  panelView: RailPanelItemId;
}): RailItemId {
  return (
    railItemForPathname(input.pathname) ?? (input.onStudioSurface ? "studio" : input.panelView)
  );
}

export interface RailSpacesSection<T> {
  readonly key: string;
  readonly spaceId: SpaceId | null;
  readonly name: string;
  readonly items: ReadonlyArray<T>;
}

/**
 * Spaces panel sections in the shared picker order (active space, Void, the rest, then
 * spaces the snapshot has not caught up with). Empty spaces stay listed so they can show
 * their empty state; an empty Void is dropped because it is only the unfiled bucket,
 * unless it is the only section there is.
 */
export function buildRailSpacesSections<T>(input: {
  items: ReadonlyArray<T>;
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  spaceIdOf: (item: T) => SpaceId | null;
  voidSpace: VoidSpacePresentation;
}): RailSpacesSection<T>[] {
  const groups = groupItemsBySpace(input);
  const groupByKey = new Map(groups.map((group) => [group.key, group]));
  const orderedKeys = new Set<string>();
  const sections: RailSpacesSection<T>[] = [];
  for (const spaceId of orderedSpaceIdsForPicker(input.spaces, input.activeSpaceId)) {
    const key = spaceKey(spaceId);
    orderedKeys.add(key);
    const group = groupByKey.get(key);
    if (!group && spaceId === null) continue;
    sections.push({
      key,
      spaceId,
      name: group?.name ?? spaceDisplayName(spaceId, input.spaces, input.voidSpace),
      items: group?.items ?? [],
    });
  }
  for (const group of groups) {
    if (!orderedKeys.has(group.key)) {
      sections.push({
        key: group.key,
        spaceId: group.spaceId,
        name: group.name,
        items: group.items,
      });
    }
  }
  if (sections.length === 0) {
    sections.push({ key: spaceKey(null), spaceId: null, name: input.voidSpace.name, items: [] });
  }
  return sections;
}
