// FILE: sidebarThreadOrdering.ts
// Purpose: Normalizes, applies, and mutates the persisted manual sidebar thread order.
// Layer: UI state logic
// Exports: immutable helpers shared by the ordering store, pinned store, and sidebar sorting.

export type ScopedOrderMoveResult<TId extends string> = {
  orderedIds: TId[];
  changed: boolean;
};

export function normalizeSidebarThreadOrder<TId extends string>(ids: readonly TId[]): TId[] {
  const seen = new Set<TId>();
  const normalized: TId[] = [];
  for (const id of ids) {
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

/**
 * Reorders one visible container without disturbing persisted ids from other
 * projects/surfaces. `scopeIds` must be the complete current order for that
 * container, including rows hidden behind pagination.
 */
export function moveSidebarThreadWithinScope<TId extends string>(input: {
  readonly orderedIds: readonly TId[];
  readonly scopeIds: readonly TId[];
  readonly activeId: TId;
  readonly overId: TId;
}): ScopedOrderMoveResult<TId> {
  const orderedIds = normalizeSidebarThreadOrder(input.orderedIds);
  const scopeIds = normalizeSidebarThreadOrder(input.scopeIds);
  const activeIndex = scopeIds.indexOf(input.activeId);
  const overIndex = scopeIds.indexOf(input.overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return { orderedIds, changed: orderedIds.length !== input.orderedIds.length };
  }

  const movedScopeIds = [...scopeIds];
  const [activeId] = movedScopeIds.splice(activeIndex, 1);
  if (!activeId) {
    return { orderedIds, changed: false };
  }
  movedScopeIds.splice(overIndex, 0, activeId);

  const scopeIdSet = new Set(scopeIds);
  const outsideScopeIds = orderedIds.filter((id) => !scopeIdSet.has(id));
  return {
    orderedIds: [...outsideScopeIds, ...movedScopeIds],
    changed: true,
  };
}

export function pruneSidebarThreadOrder<TId extends string>(
  orderedIds: readonly TId[],
  allowedIds: readonly TId[],
): TId[] {
  const allowedIdSet = new Set(allowedIds);
  return normalizeSidebarThreadOrder(orderedIds).filter((id) => allowedIdSet.has(id));
}

/** Known ids follow the manual rank. New/unranked ids stay discoverable at the
 * top and retain the caller's automatic fallback order among themselves. */
export function compareSidebarThreadsByManualOrder<TId extends string>(input: {
  readonly leftId: TId;
  readonly rightId: TId;
  readonly rankById: ReadonlyMap<TId, number>;
  readonly compareFallback: () => number;
}): number {
  const leftRank = input.rankById.get(input.leftId);
  const rightRank = input.rankById.get(input.rightId);
  if (leftRank === undefined && rightRank === undefined) return input.compareFallback();
  if (leftRank === undefined) return -1;
  if (rightRank === undefined) return 1;
  return leftRank - rightRank;
}
