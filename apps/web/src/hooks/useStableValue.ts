// FILE: useStableValue.ts
// Purpose: Keep a value's referential identity stable across renders while its
//          contents stay equal, so downstream memoization is spared rebuilds.
// Layer: Web hook
// Exports: useStableValue, setsEqual, mapsEqual

import { useRef } from "react";

/**
 * Returns the previously returned value whenever `isEqual` says the new one is
 * content-equal, preserving referential identity across recomputes.
 *
 * The cache ref is deliberately read and written during render: it is a pure
 * memo cache, so a discarded concurrent render at worst stores a value-equal
 * object. React Compiler cannot verify that and skips this hook — keeping the
 * pattern isolated here is the point, so calling hooks stay compiler-eligible.
 */
export function useStableValue<T>(value: T, isEqual: (previous: T, next: T) => boolean): T {
  const cacheRef = useRef(value);
  if (cacheRef.current !== value && !isEqual(cacheRef.current, value)) {
    cacheRef.current = value;
  }
  return cacheRef.current;
}

/** Same members, compared by identity. Pairs with useStableValue for derived Sets. */
export function setsEqual<T>(previous: ReadonlySet<T>, next: ReadonlySet<T>): boolean {
  if (previous.size !== next.size) return false;
  for (const value of next) {
    if (!previous.has(value)) return false;
  }
  return true;
}

/** Same keys mapped to identical values. Pairs with useStableValue for derived Maps. */
export function mapsEqual<K, V>(previous: ReadonlyMap<K, V>, next: ReadonlyMap<K, V>): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, value] of next) {
    if (previous.get(key) !== value || (value === undefined && !previous.has(key))) return false;
  }
  return true;
}
