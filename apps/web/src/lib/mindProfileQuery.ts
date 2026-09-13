import type { QueryClient } from "@tanstack/react-query";

/**
 * Roll back an optimistic profile write after a rejected save.
 *
 * `undefined` means the query had no cache entry when the mutation began —
 * restoring it would write `undefined` over the optimistic row only if the
 * optimistic value were not already the entry's data, so the entry must be
 * removed instead: `resetQueries` clears the fabricated profile and refetches
 * the server's truth for the mounted card. A defined snapshot (including
 * `null`, "server says no profile") is restored directly.
 */
export function rollbackOptimisticProfile(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  previous: unknown,
): void {
  if (previous !== undefined) {
    queryClient.setQueryData(queryKey, previous);
  } else {
    void queryClient.resetQueries({ queryKey: [...queryKey] });
  }
}
