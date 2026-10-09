// FILE: src/filters.ts
// Purpose: Hash-route parsing plus the shared filter state. Filters live in the
// hash query (`#/issues?days=7&kind=crash`) so a filtered view is shareable.

import { useCallback, useEffect, useMemo, useState } from "react";

import { EMPTY_FILTERS, type Filters } from "./api";

export const PRODUCT_SECTIONS = ["overview", "providers", "tokens", "reliability"] as const;
export type ProductSection = (typeof PRODUCT_SECTIONS)[number];

export type Route =
  | { view: "overview" }
  | { view: "issues" }
  | { view: "issue"; key: string }
  | { view: "usage" }
  | { view: "product"; section?: ProductSection }
  | { view: "releases" };

export function parseHash(hash: string): { route: Route; filters: Filters } {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  const filters: Filters = { ...EMPTY_FILTERS };
  const days = Number(params.get("days") ?? "");
  if (Number.isFinite(days) && days >= 1) filters.days = Math.min(365, Math.floor(days));
  for (const name of ["version", "platform", "kind", "q"] as const) {
    const value = params.get(name);
    if (value) filters[name] = value;
  }
  const issueMatch = /^issues\/(.+)$/.exec(path);
  if (issueMatch) {
    let key = issueMatch[1]!;
    try {
      key = decodeURIComponent(key);
    } catch {
      // keep the raw segment; the server validates it
    }
    return { route: { view: "issue", key }, filters };
  }
  if (path === "issues") return { route: { view: "issues" }, filters };
  if (path === "usage") return { route: { view: "usage" }, filters };
  if (path === "product") return { route: { view: "product" }, filters };
  if (path.startsWith("product/")) {
    const section = path.slice("product/".length);
    return {
      route: PRODUCT_SECTIONS.some((value) => value === section)
        ? { view: "product", section: section as ProductSection }
        : { view: "product" },
      filters,
    };
  }
  if (path === "releases") return { route: { view: "releases" }, filters };
  return { route: { view: "overview" }, filters };
}

export function routeHash(route: Route, filters: Filters): string {
  const path =
    route.view === "issues"
      ? "issues"
      : route.view === "issue"
        ? `issues/${encodeURIComponent(route.key)}`
        : route.view === "usage"
          ? "usage"
          : route.view === "product"
            ? `product${route.section ? `/${route.section}` : ""}`
            : route.view === "releases"
              ? "releases"
              : "";
  const params = new URLSearchParams();
  if (filters.days !== EMPTY_FILTERS.days) params.set("days", String(filters.days));
  if (filters.version) params.set("version", filters.version);
  if (filters.platform) params.set("platform", filters.platform);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.q) params.set("q", filters.q);
  const query = params.toString();
  return `#/${path}${query ? `?${query}` : ""}`;
}

export function navigate(route: Route, filters: Filters, opts?: { replace?: boolean }): void {
  const hash = routeHash(route, filters);
  if (opts?.replace) {
    // Debounced edits (search) must not stack history entries per keystroke.
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = hash;
}

function readLocation(): { route: Route; filters: Filters } {
  return parseHash(window.location.hash);
}

/** Current hash route; re-renders on hashchange. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => readLocation().route);
  useEffect(() => {
    const onHash = () => setRoute(readLocation().route);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

/** Hash-query filters shared by every view. */
export function useFilters(): {
  filters: Filters;
  setFilters: (patch: Partial<Filters>, opts?: { replace?: boolean }) => void;
} {
  const [state, setState] = useState(readLocation);
  useEffect(() => {
    const onHash = () => setState(readLocation());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const setFilters = useCallback((patch: Partial<Filters>, opts?: { replace?: boolean }) => {
    const { route, filters } = readLocation();
    navigate(route, { ...filters, ...patch }, opts);
  }, []);
  return useMemo(() => ({ filters: state.filters, setFilters }), [state.filters, setFilters]);
}
