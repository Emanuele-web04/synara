import { type NativeApi } from "@synara/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import { providerModelsQueryOptions } from "./providerDiscoveryReactQuery";

vi.mock("../nativeApi", () => ({ ensureNativeApi: vi.fn() }));

it("coalesces observed capacity recovery while keeping the last catalog visible", async () => {
  const capacity = Object.assign(new Error("Capacity exhausted"), {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: 250,
  });
  const previous = {
    models: [{ slug: "previous", name: "Previous" }],
    source: "runtime",
    cached: false,
  };
  const recovered = {
    models: [{ slug: "recovered", name: "Recovered" }],
    source: "runtime",
    cached: false,
  };
  const listModels = vi.fn().mockRejectedValueOnce(capacity).mockResolvedValue(recovered);
  const nativeSpy = vi
    .mocked(nativeApi.ensureNativeApi)
    .mockReturnValue({ provider: { listModels } } as unknown as NativeApi);
  const client = new QueryClient();
  const options = {
    ...providerModelsQueryOptions({ provider: "codex" }),
    staleTime: 0,
    retryDelay: 0,
  };
  client.setQueryData(options.queryKey, previous);
  const first = new QueryObserver(client, options);
  const second = new QueryObserver(client, options);
  let catalogDuringCapacity: unknown;
  const stopFirst = first.subscribe((snapshot) => {
    if (snapshot.error === capacity) catalogDuringCapacity = snapshot.data;
  });
  const stopSecond = second.subscribe(() => {});
  try {
    await expect.poll(() => catalogDuringCapacity).toEqual(previous);
    expect(listModels).toHaveBeenCalledTimes(1);
    await expect.poll(() => first.getCurrentResult().data).toEqual(recovered);
    expect(second.getCurrentResult().data).toEqual(recovered);
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(first.getCurrentResult().error).toBeNull();
  } finally {
    stopFirst();
    stopSecond();
    client.clear();
    nativeSpy.mockReset();
  }
});
