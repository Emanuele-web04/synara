import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderListModelsResult } from "./providerDiscovery";

const decodeProviderListModelsResult = Schema.decodeUnknownSync(ProviderListModelsResult);

describe("ProviderListModelsResult", () => {
  it("preserves optional runtime model descriptions", () => {
    const result = decodeProviderListModelsResult({
      models: [
        {
          slug: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          description: "0.4x Factory token rate",
        },
        {
          slug: "custom:GPT-5.6-Luna-0",
          name: "GPT-5.6 Luna",
        },
      ],
      source: "droid-acp",
    });

    expect(result.models[0]?.description).toBe("0.4x Factory token rate");
    expect(result.models[1]?.description).toBeUndefined();
  });
});
