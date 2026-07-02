// FILE: serverReactQuery.test.ts
// Purpose: Locks down server React Query polling profiles and cache options.
// Layer: Web data-fetching unit tests

import { describe, expect, it } from "vitest";

import {
  LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS,
  serverAllProviderUsageQueryOptions,
  serverLocalServersQueryOptions,
  sidebarLocalServersQueryOptions,
} from "./serverReactQuery";

describe("serverLocalServersQueryOptions", () => {
  it("uses the visible polling interval by default", () => {
    const options = serverLocalServersQueryOptions(true);

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS);
  });

  it("disables polling when disabled", () => {
    const options = serverLocalServersQueryOptions(false);

    expect(options.enabled).toBe(false);
    expect(options.refetchInterval).toBe(false);
  });

  it("keeps sidebar attribution enabled without idle polling", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: false,
      hasProjects: true,
    });

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("uses visible polling while a Synara-owned project run is active", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: true,
      hasProjects: true,
    });

    expect(options.enabled).toBe(true);
    expect(options.refetchInterval).toBe(LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS);
  });

  it("disables sidebar attribution when no projects or project runs exist", () => {
    const options = sidebarLocalServersQueryOptions({
      hasActiveProjectRun: false,
      hasProjects: false,
    });

    expect(options.enabled).toBe(false);
    expect(options.refetchInterval).toBe(false);
  });
});

describe("serverAllProviderUsageQueryOptions", () => {
  it("can be disabled by provider-scoped usage surfaces", () => {
    const options = serverAllProviderUsageQueryOptions(false);

    expect(options.enabled).toBe(false);
  });
});
