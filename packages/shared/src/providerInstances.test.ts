// FILE: providerInstances.test.ts
// Purpose: Verifies provider-instance routing helpers preserve exact account ids safely.
// Layer: Shared runtime utility tests

import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import { Schema } from "effect";

import { codexAccountInstanceId, resolveProviderInstance } from "./providerInstances";

describe("provider instance resolution", () => {
  it("rejects explicit unknown instance ids instead of falling back", () => {
    const resolved = resolveProviderInstance(DEFAULT_SERVER_SETTINGS, {
      provider: "codex",
      instanceId: "codex_removed",
    });

    expect(resolved).toBeNull();
  });

  it("still resolves provider defaults when no explicit instance id is requested", () => {
    const resolved = resolveProviderInstance(DEFAULT_SERVER_SETTINGS, {
      provider: "claudeAgent",
    });

    expect(resolved?.instanceId).toBe("claudeAgent");
    expect(resolved?.driver).toBe("claudeAgent");
  });

  it("keeps derived Codex account instance ids within the schema limit", () => {
    const accountId = `a${"b".repeat(63)}`;
    const instanceId = codexAccountInstanceId(accountId);

    expect(instanceId.length).toBeLessThanOrEqual(64);
    expect(Schema.is(ProviderInstanceId)(instanceId)).toBe(true);
  });

  it("slugifies arbitrary Codex account ids into valid provider instance ids", () => {
    const instanceId = codexAccountInstanceId("work@example.com");

    expect(instanceId).toMatch(/^codex_work_example_com_[a-z0-9]+$/);
    expect(Schema.is(ProviderInstanceId)(instanceId)).toBe(true);
  });
});
