import type { NativeApi, ProviderKind, ProviderListModelsInput } from "@t3tools/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isInitialModelDiscoveryPending,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";
import * as nativeApi from "../nativeApi";

function mockListModels(impl: (input: ProviderListModelsInput) => Promise<unknown>) {
  const listModels = vi.fn(impl);
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    provider: { listModels },
  } as unknown as NativeApi);
  return listModels;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("providerModelsQueryOptions", () => {
  it("degrades to an empty 'error' result when a provider's discovery fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListModels(async () => {
      throw new Error("Cursor CLI is not installed.");
    });

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(providerModelsQueryOptions({ provider: "cursor" }));

    expect(result).toEqual({ models: [], source: "error", cached: false });
  });

  it("keeps other providers' models when one provider's discovery fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const codexModels = [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }];
    mockListModels(async ({ provider }) => {
      if (provider === "cursor") {
        throw new Error("Cursor CLI is not authenticated.");
      }
      return { models: codexModels, source: "codex-app-server", cached: false };
    });

    const queryClient = new QueryClient();
    const [cursorResult, codexResult] = await Promise.all([
      queryClient.fetchQuery(providerModelsQueryOptions({ provider: "cursor" })),
      queryClient.fetchQuery(providerModelsQueryOptions({ provider: "codex" })),
    ]);

    // The failing provider degrades on its own...
    expect(cursorResult.models).toEqual([]);
    expect(cursorResult.source).toBe("error");
    // ...while every other provider keeps its discovered models.
    expect(codexResult.models).toEqual(codexModels);
    expect(codexResult.source).toBe("codex-app-server");
  });

  it("never rejects, so a failing CLI cannot blank the shared model picker", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockListModels(async () => {
      throw new Error("Timed out while discovering Cursor models via CLI.");
    });

    const queryClient = new QueryClient();
    await expect(
      queryClient.fetchQuery(providerModelsQueryOptions({ provider: "cursor" })),
    ).resolves.toMatchObject({ source: "error" });

    expect(providerModelsQueryOptions({ provider: "cursor" }).retry).toBe(false);
  });

  it("forwards optional discovery inputs and returns discovered models on success", async () => {
    const listModels = mockListModels(async () => ({
      models: [{ slug: "auto", name: "Auto" }],
      source: "cursor.cli",
      cached: false,
    }));

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(
      providerModelsQueryOptions({
        provider: "cursor",
        binaryPath: "/usr/bin/cursor-agent",
        apiEndpoint: "https://example.test",
      }),
    );

    expect(listModels).toHaveBeenCalledWith({
      provider: "cursor",
      binaryPath: "/usr/bin/cursor-agent",
      apiEndpoint: "https://example.test",
    });
    expect(result.source).toBe("cursor.cli");
    expect(result.models).toEqual([{ slug: "auto", name: "Auto" }]);
  });

  it("scopes query keys per provider so discovery results never collide", () => {
    const cursorKey = providerModelsQueryOptions({ provider: "cursor" as ProviderKind }).queryKey;
    const codexKey = providerModelsQueryOptions({ provider: "codex" as ProviderKind }).queryKey;
    expect(cursorKey).not.toEqual(codexKey);
  });
});

describe("isInitialModelDiscoveryPending", () => {
  it("gates the picker during the initial fetch but not on background refetches", async () => {
    let resolveListModels: (value: unknown) => void = () => {};
    mockListModels(
      () =>
        new Promise((resolve) => {
          resolveListModels = resolve;
        }),
    );
    const discovered = {
      models: [{ slug: "auto", name: "Auto" }],
      source: "cursor.cli",
      cached: false,
    };

    const queryClient = new QueryClient();
    const observer = new QueryObserver(
      queryClient,
      providerModelsQueryOptions({ provider: "cursor" }),
    );
    const unsubscribe = observer.subscribe(() => {});

    // placeholderData keeps the query in "success" status during the first
    // fetch, so isLoading stays false — only isFetching && isPlaceholderData
    // marks the initial discovery as pending.
    expect(observer.getCurrentResult().isLoading).toBe(false);
    expect(isInitialModelDiscoveryPending(observer.getCurrentResult())).toBe(true);

    resolveListModels(discovered);
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().isFetching).toBe(false);
    });
    expect(isInitialModelDiscoveryPending(observer.getCurrentResult())).toBe(false);

    // A background refetch over already-settled data must not re-gate the picker.
    const refetch = observer.refetch();
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().isFetching).toBe(true);
    });
    expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
    expect(isInitialModelDiscoveryPending(observer.getCurrentResult())).toBe(false);

    resolveListModels(discovered);
    await refetch;
    unsubscribe();
  });
});
