// FILE: providerInstances.test.ts
// Purpose: Verifies provider-instance routing helpers preserve exact account ids safely.
// Layer: Shared runtime utility tests

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceId as ProviderInstanceIdType,
  type ServerSettings,
} from "@synara/contracts";
import { Schema } from "effect";

import {
  codexAccountInstanceId,
  deriveProviderInstances,
  isUnresolvedAutomationInstanceId,
  providerStartOptionsFromInstance,
  resolveProviderInstance,
  unresolvedAutomationInstanceId,
} from "./providerInstances";

function providerInstanceId(value: string): ProviderInstanceIdType {
  return value as ProviderInstanceIdType;
}

function settingsWithLegacyCodexWorkInstance(explicit: ProviderInstanceConfig): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        accounts: [
          {
            id: "work",
            label: "Work",
            homePath: "/legacy/codex-work",
            shadowHomePath: "/legacy/codex-work-shadow",
          },
        ],
      },
    },
    providerInstances: {
      codex_work: explicit,
    },
  };
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

  it("does not allow an explicit entry to retarget a canonical built-in instance id", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex: {
          driver: "claudeAgent" as const,
          enabled: true,
          config: { binaryPath: "/malicious/claude" },
        },
      },
    };

    const resolved = resolveProviderInstance(settings, {
      instanceId: providerInstanceId("codex"),
    });

    expect(resolved?.instanceId).toBe("codex");
    expect(resolved?.driver).toBe("codex");
    expect(resolved?.config.binaryPath).not.toBe("/malicious/claude");
  });

  it("reserves unresolved automation ids even when settings configure an exact collision", () => {
    const unresolvedId = unresolvedAutomationInstanceId("codex");
    const normalId = providerInstanceId("codex_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [unresolvedId]: {
          driver: "codex" as const,
          enabled: true,
          config: { accountId: "must-never-resolve" },
        },
        [normalId]: {
          driver: "codex" as const,
          enabled: true,
          config: { accountId: "work" },
        },
      },
    };

    expect(isUnresolvedAutomationInstanceId(unresolvedId)).toBe(true);
    expect(resolveProviderInstance(settings, { instanceId: unresolvedId })).toBeNull();
    expect(
      deriveProviderInstances(settings).some((instance) => instance.instanceId === unresolvedId),
    ).toBe(false);
    expect(resolveProviderInstance(settings, { instanceId: normalId })?.instanceId).toBe(normalId);
  });

  it("fails closed when an explicit Codex instance retargets a derived account id", () => {
    const settings = settingsWithLegacyCodexWorkInstance({
      driver: "codex",
      enabled: true,
      config: { accountId: "personal" },
    });

    expect(
      resolveProviderInstance(settings, { instanceId: providerInstanceId("codex_work") }),
    ).toBeNull();
    expect(
      deriveProviderInstances(settings).some((instance) => instance.instanceId === "codex_work"),
    ).toBe(false);
  });

  it("fails closed when an explicit instance changes a derived Codex account's driver", () => {
    const settings = settingsWithLegacyCodexWorkInstance({
      driver: "claudeAgent",
      enabled: true,
      config: { homePath: "/legacy/codex-work" },
    });

    expect(
      resolveProviderInstance(settings, { instanceId: providerInstanceId("codex_work") }),
    ).toBeNull();
    expect(
      deriveProviderInstances(settings).some((instance) => instance.instanceId === "codex_work"),
    ).toBe(false);
  });

  it.each([
    ["home path", { config: { homePath: "/different/codex-work" } }],
    ["shadow home path", { config: { shadowHomePath: "/different/codex-work-shadow" } }],
    ["environment", { environment: [{ name: "CODEX_HOME", value: "/different/codex-work" }] }],
  ] satisfies ReadonlyArray<readonly [string, Partial<ProviderInstanceConfig>]>)(
    "fails closed when an explicit instance changes a derived Codex account's %s",
    (_label, override) => {
      const settings = settingsWithLegacyCodexWorkInstance({
        driver: "codex",
        enabled: true,
        ...override,
      });

      expect(
        resolveProviderInstance(settings, { instanceId: providerInstanceId("codex_work") }),
      ).toBeNull();
    },
  );

  it("keeps safe non-identity overrides for a matching derived Codex account", () => {
    const settings = settingsWithLegacyCodexWorkInstance({
      driver: "codex",
      displayName: "Codex Work Override",
      enabled: true,
      environment: [],
      config: {
        accountId: "work",
        homePath: "/legacy/codex-work",
        shadowHomePath: "/legacy/codex-work-shadow",
        binaryPath: "/opt/codex",
        customModels: ["custom/work"],
      },
    });

    const resolved = resolveProviderInstance(settings, {
      instanceId: providerInstanceId("codex_work"),
    });
    expect(resolved?.driver).toBe("codex");
    expect(resolved?.config.accountId).toBe("work");
    expect(resolved?.config.binaryPath).toBe("/opt/codex");
    expect(resolved?.config.customModels).toEqual(["custom/work"]);
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

  it("preserves an explicitly empty default-instance environment as an account boundary", () => {
    const resolved = resolveProviderInstance(
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          grok: {
            driver: "grok",
            environment: [],
          },
        },
      },
      { provider: "grok" },
    );

    expect(providerStartOptionsFromInstance(resolved!)?.grok?.environment).toEqual({});
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
