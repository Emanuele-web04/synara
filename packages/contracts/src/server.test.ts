import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerListProviderUsageInput } from "./server";

describe("provider usage contracts", () => {
  it("accepts a scoped account-only query without local archive enrichment", () => {
    const decode = Schema.decodeUnknownSync(ServerListProviderUsageInput);

    expect(decode({ provider: "codex", includeLocalUsage: false })).toEqual({
      provider: "codex",
      includeLocalUsage: false,
    });
  });
});
