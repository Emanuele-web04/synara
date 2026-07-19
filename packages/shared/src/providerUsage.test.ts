import { describe, expect, it } from "vitest";

import { PROVIDER_USAGE_PROVIDERS, isProviderUsageSupported } from "./providerUsage";

describe("provider usage metadata", () => {
  it("lists exactly the providers with machine-readable account quota", () => {
    expect(PROVIDER_USAGE_PROVIDERS).toEqual(["codex", "claudeAgent", "cursor"]);
  });

  it.each(["codex", "claudeAgent", "cursor"] as const)("supports %s", (provider) => {
    expect(isProviderUsageSupported(provider)).toBe(true);
  });

  it.each(["antigravity", "grok", "droid", "kilo", "opencode", "pi"] as const)(
    "excludes %s without a machine-readable account-quota source",
    (provider) => {
      expect(isProviderUsageSupported(provider)).toBe(false);
    },
  );
});
