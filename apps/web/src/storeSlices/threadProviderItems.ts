// FILE: threadProviderItems.ts
// Purpose: Pure normalization and slice-building for typed provider transcript items.
// Layer: Pure helpers consumed by store.ts's Zustand projection actions and event handlers.
// Exports: buildProviderItemSlice, normalizeProviderItems, upsertProviderItem,
//   mergeReadModelProviderItemsWithLiveHotPath.

import type { OrchestrationProviderItem } from "@t3tools/contracts";

import type { Thread } from "../types";
import { arraysShallowEqual, deepEqualJson } from "./equality";

export function buildProviderItemSlice(thread: Thread): {
  ids: string[];
  byId: Record<string, OrchestrationProviderItem>;
} {
  const providerItems = dedupeProviderItemsById(thread.providerItems);
  return {
    ids: providerItems.map((item) => item.id),
    byId: Object.fromEntries(providerItems.map((item) => [item.id, item] as const)) as Record<
      string,
      OrchestrationProviderItem
    >,
  };
}

export function normalizeProviderItems(
  incoming: ReadonlyArray<OrchestrationProviderItem>,
  previous: Thread["providerItems"] | undefined,
): Thread["providerItems"] {
  const previousItems = previous ? dedupeProviderItemsById(previous) : undefined;
  const incomingItems = dedupeProviderItemsById(incoming);
  const previousById = new Map(previousItems?.map((item) => [item.id, item] as const));
  const nextItems = incomingItems.map((item) => {
    const existing = previousById.get(item.id);
    return existing && providerItemsEqual(existing, item) ? existing : item;
  });
  return arraysShallowEqual(previous, nextItems) ? previous : nextItems;
}

export function upsertProviderItem(
  items: ReadonlyArray<OrchestrationProviderItem>,
  providerItem: OrchestrationProviderItem,
): OrchestrationProviderItem[] {
  let found = false;
  const indexById = new Map<string, number>();
  const nextItems: OrchestrationProviderItem[] = [];

  for (const item of items) {
    const nextItem =
      item.id === providerItem.id
        ? providerItemsEqual(item, providerItem)
          ? item
          : providerItem
        : item;
    if (item.id === providerItem.id) {
      found = true;
    }

    const existingIndex = indexById.get(nextItem.id);
    if (existingIndex === undefined) {
      indexById.set(nextItem.id, nextItems.length);
      nextItems.push(nextItem);
      continue;
    }

    nextItems[existingIndex] = nextItem;
  }

  if (!found) {
    nextItems.push(providerItem);
  }

  return arraysShallowEqual(items, nextItems) ? (items as OrchestrationProviderItem[]) : nextItems;
}

export function mergeReadModelProviderItemsWithLiveHotPath(
  incoming: ReadonlyArray<OrchestrationProviderItem>,
  previousThread: Thread | undefined,
  options: { preserveRunningTurn: boolean },
): ReadonlyArray<OrchestrationProviderItem> {
  if (
    !options.preserveRunningTurn ||
    !previousThread ||
    previousThread.providerItems.length === 0
  ) {
    return incoming;
  }
  const incomingIds = new Set(incoming.map((item) => item.id));
  let merged: OrchestrationProviderItem[] | null = null;
  for (const item of previousThread.providerItems) {
    if (incomingIds.has(item.id)) {
      continue;
    }
    if (item.status !== "inProgress" && item.turnId !== previousThread.latestTurn?.turnId) {
      continue;
    }
    merged ??= [...incoming];
    merged.push(item);
  }
  return merged
    ? merged.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    : incoming;
}

function dedupeProviderItemsById<TItem extends OrchestrationProviderItem>(
  providerItems: ReadonlyArray<TItem>,
): TItem[] {
  const indexById = new Map<string, number>();
  const result: TItem[] = [];
  for (const item of providerItems) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, result.length);
      result.push(item);
      continue;
    }
    result[existingIndex] = item;
  }
  return arraysShallowEqual(providerItems, result) ? (providerItems as TItem[]) : result;
}

function providerItemsEqual(
  left: OrchestrationProviderItem,
  right: OrchestrationProviderItem,
): boolean {
  return (
    left.providerItemId === right.providerItemId &&
    left.provider === right.provider &&
    left.turnId === right.turnId &&
    left.itemType === right.itemType &&
    left.status === right.status &&
    left.title === right.title &&
    left.detail === right.detail &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    deepEqualJson(left.data, right.data) &&
    deepEqualJson(left.content, right.content) &&
    deepEqualJson(left.sourceRef, right.sourceRef)
  );
}
