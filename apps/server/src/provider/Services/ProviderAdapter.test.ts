import { ProviderInstanceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveProviderSessionInstanceId } from "./ProviderAdapter.ts";

describe("resolveProviderSessionInstanceId", () => {
  it.each([
    ["grok", "grok_work"],
    ["pi", "pi_work"],
  ] as const)("routes %s modelSelection-only starts before launch", (provider, rawInstanceId) => {
    const instanceId = ProviderInstanceId.makeUnsafe(rawInstanceId);
    expect(
      resolveProviderSessionInstanceId({
        modelSelection: { provider, instanceId, model: "provider/model" },
      }),
    ).toBe(instanceId);
  });

  it("prefers the explicitly resolved provider instance", () => {
    const explicit = ProviderInstanceId.makeUnsafe("pi_explicit");
    expect(
      resolveProviderSessionInstanceId({
        providerInstanceId: explicit,
        modelSelection: {
          provider: "pi",
          instanceId: ProviderInstanceId.makeUnsafe("pi_model"),
          model: "pi/model",
        },
      }),
    ).toBe(explicit);
  });
});
