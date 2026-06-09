// FILE: serverReactQuery.test.ts
// Purpose: Locks down server React Query polling profiles and cache options.
// Layer: Web data-fetching unit tests

import { describe, expect, it } from "vitest";

import {
  LOCAL_SERVERS_BACKGROUND_REFETCH_INTERVAL_MS,
  LOCAL_SERVERS_VISIBLE_REFETCH_INTERVAL_MS,
  serverAllProviderUsageQueryOptions,
  serverLocalServersQueryOptions,
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

  it("allows the sidebar to use the cheaper background polling interval", () => {
    const options = serverLocalServersQueryOptions({
      enabled: true,
      refetchInterval: LOCAL_SERVERS_BACKGROUND_REFETCH_INTERVAL_MS,
    });

    expect(options.refetchInterval).toBe(LOCAL_SERVERS_BACKGROUND_REFETCH_INTERVAL_MS);
  });
});

describe("serverAllProviderUsageQueryOptions", () => {
  it("can be disabled by provider-scoped usage surfaces", () => {
    const options = serverAllProviderUsageQueryOptions(false);

    expect(options.enabled).toBe(false);
  });
});
