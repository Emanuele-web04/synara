import { ProviderInstanceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveProviderSessionInstanceId } from "./ProviderAdapter.ts";

describe("resolveProviderSessionInstanceId", () => {
  it.each(["gemini_work", "grok_work", "pi_work"])(
    "routes modelSelection-only starts to %s before launch",
    (rawInstanceId) => {
      const instanceId = ProviderInstanceId.makeUnsafe(rawInstanceId);
      expect(
        resolveProviderSessionInstanceId({
          modelSelection: { instanceId, model: "provider/model" },
        }),
      ).toBe(instanceId);
    },
  );

  it("prefers the explicitly resolved provider instance", () => {
    const explicit = ProviderInstanceId.makeUnsafe("pi_explicit");
    expect(
      resolveProviderSessionInstanceId({
        providerInstanceId: explicit,
        modelSelection: {
          instanceId: ProviderInstanceId.makeUnsafe("pi_model"),
          model: "pi/model",
        },
      }),
    ).toBe(explicit);
  });
});
