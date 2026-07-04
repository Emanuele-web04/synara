// FILE: providerInstances.test.ts
// Purpose: Verifies provider-instance routing helpers preserve exact account ids safely.
// Layer: Shared runtime utility tests

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ProviderInstanceId as ProviderInstanceIdType,
} from "@t3tools/contracts";
import { Schema } from "effect";

import {
  codexAccountInstanceId,
  providerStartOptionsFromInstance,
  resolveProviderInstance,
} from "./providerInstances";

function providerInstanceId(value: string): ProviderInstanceIdType {
  return value as ProviderInstanceIdType;
}

describe("provider instance resolution", () => {
  it("rejects explicit unknown instance ids instead of falling back", () => {
    const resolved = resolveProviderInstance(DEFAULT_SERVER_SETTINGS, {
      provider: "codex",
      instanceId: providerInstanceId("codex_removed"),
    });

    expect(resolved).toBeNull();
  });

  it("rejects explicit instance ids whose driver does not match the provider constraint", () => {
    const resolved = resolveProviderInstance(
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          work: {
            driver: "claudeAgent",
            enabled: true,
          },
        },
      },
      {
        provider: "codex",
        instanceId: providerInstanceId("work"),
      },
    );

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

  it("keeps derived default instances following live legacy launch settings", () => {
    // An explicit entry that only stores custom models must not freeze a copy
    // of the launch settings: later edits to the legacy provider settings keep
    // flowing into the derived default instance.
    const resolved = resolveProviderInstance(
      {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencode: {
            ...DEFAULT_SERVER_SETTINGS.providers.opencode,
            binaryPath: "/opt/bin/opencode-updated",
            serverUrl: "http://127.0.0.1:5000",
          },
        },
        providerInstances: {
          opencode: {
            driver: "opencode",
            enabled: true,
            config: { customModels: ["openrouter/custom"] },
          },
        },
      },
      { provider: "opencode" },
    );

    expect(resolved?.config.customModels).toEqual(["openrouter/custom"]);
    expect(resolved?.config.binaryPath).toBe("/opt/bin/opencode-updated");
    expect(resolved?.config.serverUrl).toBe("http://127.0.0.1:5000");
  });
});

describe("providerStartOptionsFromInstance codex account isolation", () => {
  const settingsWithInstance = (config: Record<string, unknown>) => ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      codex_2: {
        driver: "codex" as const,
        enabled: true,
        config,
      },
    },
  });

  it("seeds the instance id as account discriminator when no isolating config exists", () => {
    const resolved = resolveProviderInstance(settingsWithInstance({ binaryPath: "codex" }), {
      provider: "codex",
      instanceId: providerInstanceId("codex_2"),
    });

    expect(resolved).not.toBeNull();
    const options = providerStartOptionsFromInstance(resolved!);
    expect(options?.codex?.accountId).toBe("codex_2");
  });

  it("keeps an explicit account id over the seeded instance id", () => {
    const resolved = resolveProviderInstance(
      settingsWithInstance({ accountId: "work@example.com" }),
      { provider: "codex", instanceId: providerInstanceId("codex_2") },
    );

    const options = providerStartOptionsFromInstance(resolved!);
    expect(options?.codex?.accountId).toBe("work@example.com");
  });

  it("seeds home-only instances so their overlay cannot collide with the default one", () => {
    const resolved = resolveProviderInstance(
      settingsWithInstance({ homePath: "/homes/codex-work" }),
      { provider: "codex", instanceId: providerInstanceId("codex_2") },
    );

    const options = providerStartOptionsFromInstance(resolved!);
    expect(options?.codex?.accountId).toBe("codex_2");
    expect(options?.codex?.homePath).toBe("/homes/codex-work");
  });

  it("does not seed an account id when a shadow home already segments the overlay", () => {
    const resolved = resolveProviderInstance(
      settingsWithInstance({ shadowHomePath: "/homes/codex-shadow" }),
      { provider: "codex", instanceId: providerInstanceId("codex_2") },
    );

    const options = providerStartOptionsFromInstance(resolved!);
    expect(options?.codex?.accountId).toBeUndefined();
  });

  it("does not seed an account id for the default codex instance", () => {
    const resolved = resolveProviderInstance(DEFAULT_SERVER_SETTINGS, { provider: "codex" });

    expect(resolved?.isDefault).toBe(true);
    const options = providerStartOptionsFromInstance(resolved!);
    expect(options?.codex?.accountId).toBeUndefined();
  });
});
