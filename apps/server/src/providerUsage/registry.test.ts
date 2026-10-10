import { describe, expect, it } from "vitest";

import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";

import { PROVIDER_USAGE_FETCHERS } from "./registry";

describe("provider usage registry", () => {
  it("registers a fetcher for every usage-capable provider", () => {
    expect(PROVIDER_USAGE_PROVIDERS.every((provider) => PROVIDER_USAGE_FETCHERS[provider])).toBe(
      true,
    );
  });
});
