import { describe, expect, it } from "vitest";

import { sanitizeProviderStartOptionsForPersistence } from "./providerOptionsSecurity";

describe("sanitizeProviderStartOptionsForPersistence", () => {
  it.each(["pi", "omp"] as const)(
    "keeps %s routing fields and an empty environment boundary",
    (provider) => {
      expect(
        sanitizeProviderStartOptionsForPersistence({
          [provider]: { agentDir: "/accounts/work", environment: { OPENAI_API_KEY: "secret" } },
        }),
      ).toEqual({ [provider]: { agentDir: "/accounts/work", environment: {} } });
    },
  );
});
