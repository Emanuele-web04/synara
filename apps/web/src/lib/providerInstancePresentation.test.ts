import { describe, expect, it } from "vitest";

import { resolveProviderInstanceLabel } from "./providerInstancePresentation";

describe("provider instance presentation", () => {
  it("does not relabel a missing account as the first configured account", () => {
    expect(
      resolveProviderInstanceLabel([{ instanceId: "codex", label: "Personal" }], "codex_deleted"),
    ).toBe("Missing account");
  });
});
