// the composer picker, sidebar menu, and bulk-move dialog each rebuilt "active space first, then Void, then the rest" by hand — three copies drift, this is the single source

import {
  RESERVED_VOID_SPACE_ID,
  SPACE_ICON_NAMES,
  type SpaceIconName,
  type SpaceId,
} from "@synara/contracts";

import type { Space } from "~/types";

// Void is not a stored Space — its name/icon are defaults; "Void" is Synara's word, overridable per install (voidSpaceStore), and lists render whatever the user settled on
export const DEFAULT_VOID_SPACE_NAME = "Void";
export const DEFAULT_VOID_SPACE_ICON = "black-hole";
export const DEFAULT_SPACE_ICON: SpaceIconName = "bag";

export type VoidSpaceIconName = SpaceIconName | typeof DEFAULT_VOID_SPACE_ICON;

export interface VoidSpacePresentation {
  readonly name: string;
  readonly icon: VoidSpaceIconName;
}

export const DEFAULT_VOID_SPACE: VoidSpacePresentation = {
  name: DEFAULT_VOID_SPACE_NAME,
  icon: DEFAULT_VOID_SPACE_ICON,
};

export function isVoidSpaceIconName(value: string): value is VoidSpaceIconName {
  return (
    value === DEFAULT_VOID_SPACE_ICON || (SPACE_ICON_NAMES as ReadonlyArray<string>).includes(value)
  );
}

export function toSpaceIconName(icon: VoidSpaceIconName): SpaceIconName {
  return icon === DEFAULT_VOID_SPACE_ICON ? DEFAULT_SPACE_ICON : icon;
}
// Void's stand-in wherever SpaceId|null must survive as a string — a sentinel three modules each spell by hand is one only two eventually agree on
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

export function spaceKey(spaceId: SpaceId | null): string {
  return spaceId ?? VOID_SPACE_KEY;
}

const UNKNOWN_SPACE_NAME = "Unknown space";

export interface SpaceGroup<T> {
  readonly spaceId: SpaceId | null;
  readonly name: string;
  readonly icon: VoidSpaceIconName;
  readonly isActive: boolean;
  readonly label: string;
  readonly items: ReadonlyArray<T>;
  readonly key: string;
}

export function spaceDisplayName(
  spaceId: SpaceId | null | undefined,
  spaces: ReadonlyArray<Space>,
  voidSpace: VoidSpacePresentation = DEFAULT_VOID_SPACE,
): string {
  if (!spaceId) return voidSpace.name;
  return spaces.find((space) => space.id === spaceId)?.name ?? UNKNOWN_SPACE_NAME;
}

export function spaceDisplayIcon(
  spaceId: SpaceId | null | undefined,
  spaces: ReadonlyArray<Space>,
  voidSpace: VoidSpacePresentation = DEFAULT_VOID_SPACE,
): VoidSpaceIconName {
  if (!spaceId) return voidSpace.icon;
  return spaces.find((space) => space.id === spaceId)?.icon ?? voidSpace.icon;
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

export function groupItemsBySpace<T>(input: {
  items: ReadonlyArray<T>;
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  spaceIdOf: (item: T) => SpaceId | null;
  voidSpace?: VoidSpacePresentation;
}): ReadonlyArray<SpaceGroup<T>> {
  const { activeSpaceId, items, spaceIdOf, spaces } = input;
  const voidSpace = input.voidSpace ?? DEFAULT_VOID_SPACE;

  const itemsBySpaceId = new Map<SpaceId | null, T[]>();
  for (const item of items) {
    const spaceId = spaceIdOf(item);
    const bucket = itemsBySpaceId.get(spaceId);
    if (bucket) bucket.push(item);
    else itemsBySpaceId.set(spaceId, [item]);
  }

  const orderedSpaceIds = orderedSpaceIdsForPicker(spaces, activeSpaceId);
  // an item can point at a space the snapshot hasn't caught up with (delete in flight) — strict grouping would drop it, so stragglers get their own trailing group
  const knownSpaceIds = new Set(orderedSpaceIds);
  const orphanSpaceIds = [...itemsBySpaceId.keys()].filter(
    (spaceId) => !knownSpaceIds.has(spaceId),
  );

  return [...orderedSpaceIds, ...orphanSpaceIds].flatMap((spaceId) => {
    const groupItems = itemsBySpaceId.get(spaceId);
    if (!groupItems) return [];
    const isActive = spaceId === activeSpaceId;
    const name = spaceDisplayName(spaceId, spaces, voidSpace);
    return [
      {
        spaceId,
        name,
        icon: spaceDisplayIcon(spaceId, spaces, voidSpace),
        isActive,
        label: isActive ? `${name} · Active` : name,
        items: groupItems,
        key: spaceKey(spaceId),
      } satisfies SpaceGroup<T>,
    ];
  });
}
