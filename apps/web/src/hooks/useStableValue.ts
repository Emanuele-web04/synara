// FILE: useStableValue.ts
// Purpose: Keep a value's referential identity stable across renders while its
//          contents stay equal, so downstream memoization is spared rebuilds.
// Layer: Web hook
// Exports: useStableValue

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
