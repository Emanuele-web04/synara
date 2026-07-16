import { describe, expect, it, vi } from "vitest";

import {
  isInitialModelDiscoveryPending,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    provider: {
      listModels: vi.fn(async ({ provider }: { provider: string }) => {
        if (provider === "cursor") {
          throw new Error("Cursor CLI is not installed or not on PATH");
        }
        return {
          models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
          source: "codex",
          cached: false,
        };
      }),
    },
  }),
}));

describe("isInitialModelDiscoveryPending", () => {
  it("is pending only for the first fetch (loading or placeholder fetch)", () => {
    expect(
      isInitialModelDiscoveryPending({
        isLoading: true,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    // Settled catalog + background refetch must not blank the picker (#103).
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: false,
      }),
    ).toBe(false);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: false,
        isPlaceholderData: false,
      }),
    ).toBe(false);
  });
});

describe("providerModelsQueryOptions", () => {
  it("soft-fails Cursor listModels so discovery settles as empty instead of rejecting", async () => {
    const options = providerModelsQueryOptions({ provider: "cursor", enabled: true });
    const result = await options.queryFn!({} as never);
    expect(result).toEqual({
      models: [],
      source: "error",
      cached: false,
    });
    expect(options.retry).toBe(0);
  });

  it("still returns successful catalogs for other providers", async () => {
    const options = providerModelsQueryOptions({ provider: "codex", enabled: true });
    const result = await options.queryFn!({} as never);
    expect(result).toEqual({
      models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      source: "codex",
      cached: false,
    });
  });
});
