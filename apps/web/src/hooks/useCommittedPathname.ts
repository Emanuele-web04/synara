// FILE: useCommittedPathname.ts
// Purpose: Pathname of the route that is actually rendered, for shell code that also reads params.
// Layer: Web routing hook
// Exports: resolveCommittedPathname, useCommittedPathname

import { useRouter, useRouterState } from "@tanstack/react-router";

interface CommittedPathnameRouterState {
  readonly isLoading: boolean;
  readonly location: { readonly pathname: string };
  readonly resolvedLocation?: { readonly pathname: string } | undefined;
}

/**
 * TanStack Router publishes a navigation in two store updates: `location` (with
 * `isLoading: true`) first, then `matches` (with `isLoading: false`) once the route
 * is ready. Holding the previous pathname while `isLoading` is set makes the pathname
 * change in the update that also changes `useParams`/`useSearch`.
 *
 * The value is `location.pathname` itself, never a match's `pathname`: matches carry
 * the interpolated route path (`/pull-requests/` for an index route, re-encoded params,
 * no unmatched tail), which is not string-identical to the location.
 */
export function resolveCommittedPathname(
  state: CommittedPathnameRouterState,
  heldPathname: string | null,
): string {
  if (!state.isLoading) {
    return state.location.pathname;
  }
  // No pathname held yet means the first subscriber mounted mid-navigation; the
  // last resolved location is the closest record of what the rendered matches show.
  return heldPathname ?? (state.resolvedLocation ?? state.location).pathname;
}

// Shared per router so every subscriber reports the same pathname, including one
// that mounts while a navigation is pending.
const heldPathnameByRouter = new WeakMap<object, string>();

/**
 * Like `useLocation({ select: (location) => location.pathname })`, but it changes in
 * the same commit as the route params instead of one render earlier, so pathname and
 * params never disagree and a navigation renders the subscriber once.
 */
export function useCommittedPathname(): string {
  const router = useRouter();
  return useRouterState({
    select: (state) => {
      const pathname = resolveCommittedPathname(state, heldPathnameByRouter.get(router) ?? null);
      heldPathnameByRouter.set(router, pathname);
      return pathname;
    },
  });
}
