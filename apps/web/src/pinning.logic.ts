// FILE: pinning.logic.ts
// Purpose: Shared immutable helpers for sidebar pin id order, pruning, and optimistic merges.
// Layer: UI state logic
// Exports: pinned id normalization, mutation helpers, and pinned item derivation.

export type PinLimitResult<TId extends string> = {
  pinnedIds: TId[];
  changed: boolean;
  rejected: boolean;
};

export function normalizePinnedIds<TId extends string>(
  ids: readonly TId[],
  options?: { maxCount?: number },
): TId[] {
  const seen = new Set<TId>();
  const normalized: TId[] = [];
  const maxCount = Math.max(0, options?.maxCount ?? Number.POSITIVE_INFINITY);

  for (const id of ids) {
    if (normalized.length >= maxCount) {
      break;
    }
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

export function pinId<TId extends string>(
  ids: readonly TId[],
  id: TId,
  options?: { maxCount?: number },
): PinLimitResult<TId> {
  const normalized = normalizePinnedIds(ids, options);
  if (id.length === 0) {
    return { pinnedIds: normalized, changed: normalized.length !== ids.length, rejected: true };
  }
  if (normalized.includes(id)) {
    return { pinnedIds: normalized, changed: normalized.length !== ids.length, rejected: false };
  }
  if (options?.maxCount !== undefined && normalized.length >= options.maxCount) {
    return { pinnedIds: normalized, changed: false, rejected: true };
  }
  return { pinnedIds: [id, ...normalized], changed: true, rejected: false };
}

export function unpinId<TId extends string>(ids: readonly TId[], id: TId): PinLimitResult<TId> {
  const normalized = normalizePinnedIds(ids);
  const pinnedIds = normalized.filter((candidate) => candidate !== id);
  return {
    pinnedIds,
    changed: pinnedIds.length !== normalized.length || normalized.length !== ids.length,
    rejected: false,
  };
}

export function prunePinnedIds<TId extends string>(
  ids: readonly TId[],
  allowedIds: readonly TId[],
): TId[] {
  const allowedIdSet = new Set(allowedIds);
  return normalizePinnedIds(ids).filter((id) => allowedIdSet.has(id));
}

// Persisted order wins when present; server-only pins are appended in current sidebar order.
export function derivePinnedIds<
  TId extends string,
  TItem extends { id: TId; isPinned?: boolean | undefined },
>(input: {
  readonly items: readonly TItem[];
  readonly persistedPinnedIds: readonly TId[];
  readonly optimisticPinnedStateById: ReadonlyMap<TId, boolean>;
  readonly maxCount?: number;
}): TId[] {
  const itemIds = new Set(input.items.map((item) => item.id));
  const pinnedIds: TId[] = [];
  const addPinnedId = (id: TId) => {
    if (input.maxCount !== undefined && pinnedIds.length >= input.maxCount) {
      return;
    }
    if (itemIds.has(id) && !pinnedIds.includes(id)) {
      pinnedIds.push(id);
    }
  };

  for (const id of input.persistedPinnedIds) {
    if (input.optimisticPinnedStateById.get(id) === false) {
      continue;
    }
    addPinnedId(id);
  }

  for (const item of input.items) {
    const optimisticPinned = input.optimisticPinnedStateById.get(item.id);
    const isPinned = optimisticPinned ?? item.isPinned === true;
    if (isPinned) {
      addPinnedId(item.id);
    }
  }

  return pinnedIds;
}

export function getPinnedItems<TId extends string, TItem extends { id: TId }>(
  items: readonly TItem[],
  pinnedIds: readonly TId[],
): TItem[] {
  const itemById = new Map(items.map((item) => [item.id, item] as const));
  const pinnedItems: TItem[] = [];
  const seen = new Set<TId>();

  for (const id of pinnedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = itemById.get(id);
    if (item) {
      pinnedItems.push(item);
    }
  }

  return pinnedItems;
}

export function orderPinnedItemsFirst<TId extends string, TItem extends { id: TId }>(
  items: readonly TItem[],
  pinnedIds: readonly TId[],
): TItem[] {
  if (pinnedIds.length === 0) {
    return [...items];
  }
  const pinnedIdSet = new Set(pinnedIds);
  return [
    ...getPinnedItems(items, pinnedIds),
    ...items.filter((item) => !pinnedIdSet.has(item.id)),
  ];
}

export function isLatestPinMutation<TId>(input: {
  readonly id: TId;
  readonly requestVersion: number;
  readonly latestMutationVersionById: ReadonlyMap<TId, number>;
}): boolean {
  return input.latestMutationVersionById.get(input.id) === input.requestVersion;
}
