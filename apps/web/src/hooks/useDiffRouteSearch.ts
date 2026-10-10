import { useSearch } from "@tanstack/react-router";

import {
  diffRouteSearchEquals,
  type DiffRouteSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";

function createStableDiffRouteSearchSelector() {
  let previous: DiffRouteSearch | null = null;
  return (search: Record<string, unknown>): DiffRouteSearch => {
    const next = parseDiffRouteSearch(search);
    if (previous && diffRouteSearchEquals(previous, next)) {
      return previous;
    }
    previous = next;
    return next;
  };
}

const selectStableDiffRouteSearch = createStableDiffRouteSearchSelector();

// keep one stable selector instance so unchanged search reuses the snapshot — TanStack structural sharing can't handle Effect-branded TurnId
export function useDiffRouteSearch() {
  return useSearch({
    strict: false,
    select: selectStableDiffRouteSearch,
  });
}
