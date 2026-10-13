// FILE: workItemReactQuery.ts
// Purpose: React Query hook for debounced GitHub work item search.

import { useQuery, queryOptions } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useDebouncedValue } from "@tanstack/react-pacer";

import {
  WS_WORK_ITEMS_COMPOSER_ATTACH_CAPABILITY,
  WORK_ITEM_QUERY_MAX_CHARS,
  type WorkItemSearchInput,
} from "@synara/contracts";
import {
  ensureNativeApi,
  onNativeApiServerCapabilitiesChange,
  readNativeApiServerCapability,
} from "~/nativeApi";

export const WORK_ITEMS_SEARCH_DEBOUNCE_MS = 300;
export const WORK_ITEMS_AVAILABILITY_STALE_TIME_MS = 30_000;

export const workItemQueryKeys = {
  search: (input: WorkItemSearchInput | null) =>
    ["work-items", "search", input?.cwd ?? "", input?.query ?? "", input?.limit ?? 20] as const,
  availability: (cwd: string | null) => ["work-items", "availability", cwd] as const,
};

export function workItemsSearchQueryOptions(input: WorkItemSearchInput | null, enabled = true) {
  return queryOptions({
    queryKey: workItemQueryKeys.search(input),
    queryFn: async ({ signal }) => {
      if (!input) {
        return { available: false, errorHint: "No project directory.", items: [] };
      }
      return ensureNativeApi().workItems.search(input, { signal });
    },
    enabled: enabled && input !== null,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
  });
}

export function useWorkItemsSearch(input: WorkItemSearchInput | null, enabled = true) {
  return useQuery(workItemsSearchQueryOptions(input, enabled));
}

export function workItemsAvailabilityQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: workItemQueryKeys.availability(cwd),
    queryFn: async ({ signal }) => {
      if (!cwd) {
        return { status: "no-repository" as const, hint: null };
      }
      return ensureNativeApi().workItems.availability({ cwd }, { signal });
    },
    enabled: cwd !== null,
    staleTime: WORK_ITEMS_AVAILABILITY_STALE_TIME_MS,
    refetchInterval: (query) =>
      query.state.data?.status === "ready" ? false : WORK_ITEMS_AVAILABILITY_STALE_TIME_MS,
    gcTime: 10 * 60_000,
  });
}

export function useWorkItemsAvailability(cwd: string | null) {
  return useQuery(workItemsAvailabilityQueryOptions(cwd));
}

export function useDebouncedWorkItemsSearch(cwd: string | null, query: string, enabled: boolean) {
  const [debouncedQuery] = useDebouncedValue(query.slice(0, WORK_ITEM_QUERY_MAX_CHARS), {
    wait: WORK_ITEMS_SEARCH_DEBOUNCE_MS,
  });
  const input: WorkItemSearchInput | null = cwd ? { cwd, query: debouncedQuery, limit: 20 } : null;

  return useWorkItemsSearch(input, enabled);
}

const subscribeCapability = (listener: () => void) => onNativeApiServerCapabilitiesChange(listener);
const readCapability = () =>
  readNativeApiServerCapability(WS_WORK_ITEMS_COMPOSER_ATTACH_CAPABILITY);
const readServerCapability = () => false;
export function useWorkItemsCapability() {
  return useSyncExternalStore(subscribeCapability, readCapability, readServerCapability);
}
