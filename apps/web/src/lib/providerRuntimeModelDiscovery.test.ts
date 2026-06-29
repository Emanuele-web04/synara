import { describe, expect, it } from "vitest";

import {
  providerRequiresRuntimeModelDiscovery,
  resolveProviderModelsLoading,
  resolveProviderRuntimeModelDiscoveryPending,
} from "./providerRuntimeModelDiscovery";

describe("providerRuntimeModelDiscovery", () => {
  it("marks runtime-discovery providers", () => {
    expect(providerRequiresRuntimeModelDiscovery("devin")).toBe(true);
    expect(providerRequiresRuntimeModelDiscovery("codex")).toBe(false);
  });

  it("uses explicit pending flags for runtime-discovery providers", () => {
    expect(
      resolveProviderRuntimeModelDiscoveryPending("devin", {
        devin: true,
      }),
    ).toBe(true);
    expect(
      resolveProviderRuntimeModelDiscoveryPending("devin", {
        devin: false,
      }),
    ).toBe(false);
  });

  it("falls back to query state for non-runtime-discovery providers", () => {
    expect(
      resolveProviderModelsLoading(
        "codex",
        {},
        {
          isLoading: true,
          isFetching: false,
          data: undefined,
        },
      ),
    ).toBe(true);
  });
});
