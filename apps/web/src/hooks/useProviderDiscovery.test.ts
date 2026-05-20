import { describe, expect, it } from "vitest";

import { resolveActiveHermesProfileName } from "../lib/hermesProfile";

describe("useProviderDiscovery hermes profile bootstrap", () => {
  it("uses the active profile marker before the first list row", () => {
    expect(
      resolveActiveHermesProfileName([
        { name: "work" },
        {
          name: "default",
          description: "hermes-active-profile",
        },
      ]),
    ).toBe("default");
  });
});
