import { describe, expect, it } from "vitest";

import {
  makeUnresolvedAutomationModelSelection,
  resolveAutomationProviderIdentity,
} from "./automationProviderIdentity";

describe("automation provider identity migration", () => {
  for (const provider of ["antigravity", "droid", "devin"] as const) {
    it(`recognizes ${provider} as a default provider identity`, () => {
      expect(
        resolveAutomationProviderIdentity(
          { provider, model: "model" },
          { [provider]: { binaryPath: `/opt/${provider}` } },
        ),
      ).toEqual({
        safe: true,
        modelSelection: { instanceId: provider, model: "model" },
      });
    });

    it(`tombstones ${provider} environment overrides`, () => {
      expect(
        resolveAutomationProviderIdentity(
          { provider, model: "model" },
          { [provider]: { environment: {} } },
        ),
      ).toEqual({ safe: false });
      expect(
        makeUnresolvedAutomationModelSelection(
          { provider, model: "model" },
          { [provider]: { environment: {} } },
        ),
      ).toEqual({
        provider,
        modelSelection: {
          instanceId: `synara_unresolved_automation_${provider}`,
          model: "model",
        },
      });
    });
  }
});
