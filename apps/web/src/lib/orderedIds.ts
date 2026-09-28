// FILE: orderedIds.ts
// Purpose: Normalizes persisted id lists (user-ordered or hidden items) against a known set.
// Layer: Web settings utility
// Exports: normalizeKnownIds, normalizeIdOrder

/** Known ids from a persisted list, in their saved order, without duplicates. */
export function normalizeKnownIds<Id extends string>(
  ids: ReadonlyArray<string>,
  isKnown: (value: string) => value is Id,
): Id[] {
  const seen = new Set<Id>();
  const result: Id[] = [];
  for (const candidate of ids) {
    if (isKnown(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

/**
 * A complete order: the saved known ids first, then any default id the saved order lacks
 * (items shipped after the user persisted an order), appended in default order.
 */
export function normalizeIdOrder<Id extends string>(
  order: ReadonlyArray<string>,
  defaults: ReadonlyArray<Id>,
  isKnown: (value: string) => value is Id,
): Id[] {
  const result = normalizeKnownIds(order, isKnown);
  const seen = new Set(result);
  for (const id of defaults) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}
