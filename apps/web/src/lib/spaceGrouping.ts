// FILE: spaceGrouping.ts
// Purpose: One ordering, naming, and labelling rule for every list that groups projects by Space.
// Layer: Spaces presentation utility
// Why: The composer project picker, the sidebar project menu, and the bulk move dialog each
//      rebuilt "active space first, then Void, then the rest" plus the `Name · Active` label by
//      hand. Three copies drift; this is the single source they all read from.

import { RESERVED_VOID_SPACE_ID, type SpaceIconName, type SpaceId } from "@synara/contracts";

import type { Space } from "~/types";

/** Void is not a stored Space, so its name and icon live here rather than in a row. */
export const VOID_SPACE_NAME = "Void";
export const VOID_SPACE_ICON = "black-hole";
/**
 * Void's stand-in wherever a `SpaceId | null` has to survive as a plain string — React
 * keys, menu radio values, storage records. `null` cannot fill any of those roles, and a
 * sentinel that three modules each spell out by hand is a sentinel that eventually only
 * two of them agree on.
 */
export const VOID_SPACE_KEY = RESERVED_VOID_SPACE_ID;

/**
 * Resolve stale persisted selection to Void before Space-scoped lists filter on it. A receipt-
 * fenced optimistic selection remains usable until shell hydration reaches the command sequence.
 */
export function resolveActiveSpaceId(
  activeSpaceId: SpaceId | null,
  spaces: ReadonlyArray<Space>,
  pendingActiveSpaceId: SpaceId | null = null,
): SpaceId | null {
  return activeSpaceId !== null &&
    (activeSpaceId === pendingActiveSpaceId || spaces.some((space) => space.id === activeSpaceId))
    ? activeSpaceId
    : null;
}

/** Narrows a `SpaceId | null` to the string key that stands in for it. */
export function spaceKey(spaceId: SpaceId | null): string {
  return spaceId ?? VOID_SPACE_KEY;
}

/** Shown when a project points at a Space that is not in the snapshot (mid-delete, stale route). */
const UNKNOWN_SPACE_NAME = "Unknown space";

export interface SpaceGroup<T> {
  readonly spaceId: SpaceId | null;
  readonly name: string;
  readonly icon: SpaceIconName | typeof VOID_SPACE_ICON;
  readonly isActive: boolean;
  /** Group heading copy, including the active-space marker. */
  readonly label: string;
  readonly items: ReadonlyArray<T>;
  /** Stable React key — `null` (Void) is not usable as one. */
  readonly key: string;
}

export function spaceDisplayName(
  spaceId: SpaceId | null | undefined,
  spaces: ReadonlyArray<Space>,
): string {
  if (!spaceId) return VOID_SPACE_NAME;
  return spaces.find((space) => space.id === spaceId)?.name ?? UNKNOWN_SPACE_NAME;
}

export function spaceDisplayIcon(
  spaceId: SpaceId | null | undefined,
  spaces: ReadonlyArray<Space>,
): SpaceIconName | typeof VOID_SPACE_ICON {
  if (!spaceId) return VOID_SPACE_ICON;
  return spaces.find((space) => space.id === spaceId)?.icon ?? VOID_SPACE_ICON;
}

/**
 * Space ids in the order every grouped project list presents them: the space you are
 * working in first, then Void, then the remaining spaces in their user-defined order.
 */
export function orderedSpaceIdsForPicker(
  spaces: ReadonlyArray<Space>,
  activeSpaceId: SpaceId | null,
): ReadonlyArray<SpaceId | null> {
  const rest: ReadonlyArray<SpaceId | null> = [null, ...spaces.map((space) => space.id)].filter(
    (spaceId) => spaceId !== activeSpaceId,
  );
  return [activeSpaceId, ...rest];
}

/** Groups any project-shaped list by Space, dropping empty groups. */
export function groupItemsBySpace<T>(input: {
  items: ReadonlyArray<T>;
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  spaceIdOf: (item: T) => SpaceId | null;
}): ReadonlyArray<SpaceGroup<T>> {
  const { activeSpaceId, items, spaceIdOf, spaces } = input;

  // Bucket in one pass, preserving each item's incoming order within its group. Insertion
  // order also records the orphans (see below) in the order they were met, so the ordered
  // ids below only have to describe the groups we actually want to place.
  const itemsBySpaceId = new Map<SpaceId | null, T[]>();
  for (const item of items) {
    const spaceId = spaceIdOf(item);
    const bucket = itemsBySpaceId.get(spaceId);
    if (bucket) bucket.push(item);
    else itemsBySpaceId.set(spaceId, [item]);
  }

  const orderedSpaceIds = orderedSpaceIdsForPicker(spaces, activeSpaceId);
  // An item can point at a space the snapshot has not caught up with (a delete still in
  // flight). Grouping strictly by known spaces would drop it from the list entirely, so
  // stragglers get their own trailing group rather than disappearing.
  const knownSpaceIds = new Set(orderedSpaceIds);
  const orphanSpaceIds = [...itemsBySpaceId.keys()].filter(
    (spaceId) => !knownSpaceIds.has(spaceId),
  );

  return [...orderedSpaceIds, ...orphanSpaceIds].flatMap((spaceId) => {
    const groupItems = itemsBySpaceId.get(spaceId);
    if (!groupItems) return [];
    const isActive = spaceId === activeSpaceId;
    const name = spaceDisplayName(spaceId, spaces);
    return [
      {
        spaceId,
        name,
        icon: spaceDisplayIcon(spaceId, spaces),
        isActive,
        label: isActive ? `${name} · Active` : name,
        items: groupItems,
        key: spaceKey(spaceId),
      } satisfies SpaceGroup<T>,
    ];
  });
}
