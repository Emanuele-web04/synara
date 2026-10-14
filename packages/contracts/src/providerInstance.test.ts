import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderInstanceConfigMap } from "./providerInstance";

const providerInstancesCodec = Schema.toCodecJson(ProviderInstanceConfigMap);

describe("ProviderInstanceConfigMap JSON codec", () => {
  it("preserves provider launch config when settings cross the JSON boundary", () => {
    const providerInstances = {
      claude_work: {
        driver: "claudeAgent",
        displayName: "Work Claude",
        config: { homePath: "/accounts/work", cliAlias: "claude-work" },
      },
    };
    const wire = JSON.parse(
      JSON.stringify(Schema.encodeUnknownSync(providerInstancesCodec)(providerInstances)),
    );

    expect(wire).toEqual(providerInstances);
    expect(Schema.decodeUnknownSync(providerInstancesCodec)(wire)).toEqual(providerInstances);
  });
});
