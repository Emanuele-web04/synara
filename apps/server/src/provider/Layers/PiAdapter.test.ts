// FILE: PiAdapter.test.ts
// Purpose: Verifies Pi adapter model discovery exposes only SDK-supported thinking levels.
// Layer: Provider adapter tests
// Depends on: PiAdapter discovery helpers and Pi model metadata shapes.

import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  applyPiRuntimeApiKeysFromEnvironment,
  createPiModelRegistry,
  getPiSupportedThinkingOptions,
  makePiStoragePaths,
  makePiExtensionModeCoordinator,
  resolvePiExtensionMode,
  resolvePiStartInstanceId,
  makePiUserInputOptions,
  PLAIN_PI_EXTENSION_THEME,
} from "./PiAdapter";

describe("makePiStoragePaths", () => {
  it("resolves modelSelection-only account identity before Pi storage setup", () => {
    expect(
      resolvePiStartInstanceId({
        modelSelection: { instanceId: "pi_work", model: "pi/model" },
      } as never),
    ).toBe("pi_work");
  });
  it("keeps legacy defaults byte-for-byte without an account boundary", () => {
    expect(
      makePiStoragePaths({
        stateDir: "/state",
        homeDir: "/home/user",
        sdkAgentDir: "/sdk/default-agent",
      }),
    ).toEqual({ agentDir: "/sdk/default-agent" });
  });

  it("uses selected Pi roots and never falls back to the global session directory", () => {
    expect(
      makePiStoragePaths({
        agentDir: "~/configured-agent",
        environment: {
          HOME: "/accounts/b",
          PI_CODING_AGENT_DIR: "/ignored/env-agent",
          PI_CODING_AGENT_SESSION_DIR: "/accounts/b/selected-sessions",
        },
        instanceId: "pi_work",
        stateDir: "/state",
        homeDir: "/home/user",
        sdkAgentDir: "/sdk/default-agent",
      }),
    ).toEqual({
      agentDir: "/accounts/b/configured-agent",
      sessionDir: "/accounts/b/selected-sessions",
    });
  });

  it("derives persistent synthetic agent and session roots for nondefault instances", () => {
    const paths = makePiStoragePaths({
      instanceId: "pi_work",
      stateDir: "/state",
      homeDir: "/home/user",
      sdkAgentDir: "/sdk/default-agent",
    });
    expect(paths.agentDir).toContain("/state/provider-homes/pi/");
    expect(paths.agentDir.endsWith("/.pi/agent")).toBe(true);
    expect(paths.sessionDir).toBe(`${paths.agentDir}/sessions`);
  });

  it("expands configured tilde paths against the synthetic account home", () => {
    const paths = makePiStoragePaths({
      agentDir: "~/.custom-pi",
      instanceId: "pi_work",
      stateDir: "/state",
      homeDir: "/real/server-home",
      sdkAgentDir: "/sdk/default-agent",
    });
    expect(paths.agentDir).toContain("/state/provider-homes/pi/");
    expect(paths.agentDir).toContain("/.custom-pi");
    expect(paths.agentDir).not.toContain("/real/server-home");
  });

  it("falls back to synthetic storage for relative configured agent dirs", () => {
    const paths = makePiStoragePaths({
      agentDir: "relative-agent",
      instanceId: "pi_work",
      stateDir: "/state",
      homeDir: "/real/server-home",
      sdkAgentDir: "/sdk/default-agent",
    });
    expect(paths.agentDir).toContain("/state/provider-homes/pi/");
    expect(paths.agentDir).toContain("/.pi/agent");
  });
});

describe("resolvePiExtensionMode", () => {
  it("preserves default-only extension behavior", () => {
    expect(
      resolvePiExtensionMode({
        isolatedAccount: false,
        hasExtensionEnabledDefault: false,
        hasIsolatedMode: false,
      }),
    ).toEqual({ noExtensions: false });
  });

  it("forces noExtensions for isolated accounts and coexisting default discovery", () => {
    expect(
      resolvePiExtensionMode({
        isolatedAccount: true,
        hasExtensionEnabledDefault: false,
        hasIsolatedMode: false,
      }),
    ).toEqual({ noExtensions: true });
    expect(
      resolvePiExtensionMode({
        isolatedAccount: false,
        hasExtensionEnabledDefault: false,
        hasIsolatedMode: true,
      }),
    ).toEqual({ noExtensions: true });
  });

  it("rejects isolated startup while an extension-enabled default is active", () => {
    expect(() =>
      resolvePiExtensionMode({
        isolatedAccount: true,
        hasExtensionEnabledDefault: true,
        hasIsolatedMode: false,
      }),
    ).toThrow(/Stop extension-enabled default Pi sessions/);
  });
});

describe("Pi extension mode in-flight reservations", () => {
  const coordinator = () =>
    makePiExtensionModeCoordinator(() => ({
      hasExtensionEnabledDefault: false,
      hasIsolatedMode: false,
    }));

  it("rejects concurrent isolated work after extension-enabled discovery reserves first", async () => {
    const modes = coordinator();
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const defaultDiscovery = (async () => {
      const reservation = modes.reserve(false);
      try {
        await discoveryGate;
      } finally {
        reservation.release();
      }
    })();
    await Promise.resolve();
    const [isolatedStart] = await Promise.allSettled([
      Promise.resolve().then(() => modes.reserve(true)),
    ]);
    expect(isolatedStart.status).toBe("rejected");
    releaseDiscovery();
    await defaultDiscovery;
    expect(modes.reserve(true).noExtensions).toBe(true);
  });

  it("forces concurrent default work into noExtensions after isolated start reserves first", async () => {
    const modes = coordinator();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const isolatedStart = (async () => {
      const reservation = modes.reserve(true);
      try {
        await startGate;
      } finally {
        reservation.release();
      }
    })();
    await Promise.resolve();
    const defaultDiscovery = await Promise.resolve().then(() => modes.reserve(false));
    expect(defaultDiscovery.noExtensions).toBe(true);
    defaultDiscovery.release();
    releaseStart();
    await Promise.all([isolatedStart]);
    expect(modes.reserve(false).noExtensions).toBe(false);
  });

  it("allows same-thread default to isolated replacement without exposing the transition", () => {
    const modes = makePiExtensionModeCoordinator(() => ({
      hasExtensionEnabledDefault: true,
      hasIsolatedMode: false,
    }));
    expect(() => modes.reserve(true)).toThrow(/Stop extension-enabled default Pi sessions/);
    const replacement = modes.reserve(true, {
      hasExtensionEnabledDefault: false,
      hasIsolatedMode: false,
    });
    expect(replacement.noExtensions).toBe(true);
    expect(() => modes.reserve(false)).toThrow(/account-mode transition/);
    replacement.release();
  });

  it("allows same-thread isolated to default replacement in noExtensions mode", () => {
    const modes = makePiExtensionModeCoordinator(() => ({
      hasExtensionEnabledDefault: false,
      hasIsolatedMode: true,
    }));
    const replacement = modes.reserve(false, {
      hasExtensionEnabledDefault: false,
      hasIsolatedMode: false,
    });
    expect(replacement.noExtensions).toBe(false);
    replacement.release();
  });
});

function makePiModel(input: {
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
  return {
    reasoning: input.reasoning,
    ...(input.thinkingLevelMap !== undefined ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
  };
}

describe("getPiSupportedThinkingOptions", () => {
  it("hides thinking controls for non-reasoning models", () => {
    expect(getPiSupportedThinkingOptions(makePiModel({ reasoning: false }))).toEqual([]);
  });

  it("advertises xhigh only when the concrete Pi model supports it", () => {
    const withoutXHigh = getPiSupportedThinkingOptions(makePiModel({ reasoning: true }));
    const withXHigh = getPiSupportedThinkingOptions(
      makePiModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    );

    expect(withoutXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(withXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("respects provider-level disabled thinking levels", () => {
    const options = getPiSupportedThinkingOptions(
      makePiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
        },
      }),
    );

    expect(options.map((option) => option.value)).toEqual(["minimal", "low", "medium", "high"]);
  });
});

describe("applyPiRuntimeApiKeysFromEnvironment", () => {
  it("uses the same runtime auth storage for API keys and model registry", () => {
    const setRuntimeApiKey = vi.fn();
    const authStorage = {
      setRuntimeApiKey,
      removeRuntimeApiKey: vi.fn(),
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
      getApiKey: vi.fn(async () => undefined),
      hasAuth: vi.fn(() => false),
      getAuthStatus: vi.fn(() => ({ configured: false })),
      getOAuthProviders: vi.fn(() => []),
      reload: vi.fn(),
    } as unknown as AuthStorage;
    const registry = {} as ModelRegistry;
    const piSdk = {
      AuthStorage: {
        create: vi.fn(() => authStorage),
      },
      ModelRegistry: {
        create: vi.fn(() => registry),
      },
    } as unknown as Parameters<typeof createPiModelRegistry>[1];

    const context = createPiModelRegistry("/agent", piSdk, {
      OPENAI_API_KEY: "instance-openai-key",
    });

    expect(piSdk.AuthStorage.create).toHaveBeenCalledWith("/agent/auth.json");
    expect(setRuntimeApiKey).toHaveBeenCalledWith("openai", "instance-openai-key");
    expect(piSdk.ModelRegistry.create).toHaveBeenCalledWith(authStorage, "/agent/models.json");
    expect(context.authStorage).toBe(authStorage);
    expect(context.registry).toBe(registry);
  });

  it("maps Pi provider-instance API keys into runtime auth without mutating process.env", () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "global-openai-key";
    const runtimeKeys = new Map<string, string>();

    try {
      applyPiRuntimeApiKeysFromEnvironment(
        {
          setRuntimeApiKey(provider, apiKey) {
            runtimeKeys.set(provider, apiKey);
          },
        },
        {
          OPENAI_API_KEY: "instance-openai-key",
          ANTHROPIC_API_KEY: "anthropic-api-key",
          ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth-token",
          OPENCODE_API_KEY: "opencode-key",
        },
      );
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }

    expect(runtimeKeys.get("openai")).toBe("instance-openai-key");
    expect(runtimeKeys.get("anthropic")).toBe("anthropic-oauth-token");
    expect(runtimeKeys.get("opencode")).toBe("opencode-key");
    expect(runtimeKeys.get("opencode-go")).toBe("opencode-key");
    expect(process.env.OPENAI_API_KEY).toBe(previousOpenAiKey);
  });

  it("blocks ambient API-key fallback for a non-default Pi instance registry", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-account-a";
    const setRuntimeApiKey = vi.fn();
    const authStorage = {
      setRuntimeApiKey,
      removeRuntimeApiKey: vi.fn(),
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
      getApiKey: vi.fn(async () => process.env.OPENAI_API_KEY),
      hasAuth: vi.fn(() => process.env.OPENAI_API_KEY !== undefined),
      getAuthStatus: vi.fn(() => ({
        configured: process.env.OPENAI_API_KEY !== undefined,
        source: "environment" as const,
        label: "OPENAI_API_KEY",
      })),
      getOAuthProviders: vi.fn(() => []),
      reload: vi.fn(),
    } as unknown as AuthStorage;
    const piSdk = {
      AuthStorage: {
        create: vi.fn(() => authStorage),
      },
      ModelRegistry: {
        create: vi.fn(() => ({}) as ModelRegistry),
      },
    } as unknown as Parameters<typeof createPiModelRegistry>[1];

    let context: ReturnType<typeof createPiModelRegistry>;
    try {
      context = createPiModelRegistry("/agent", piSdk, undefined, "pi_work");
      expect(await context.authStorage.getApiKey("openai")).toBeUndefined();
      expect(context.authStorage.hasAuth("openai")).toBe(false);
      expect(context.authStorage.getAuthStatus("openai")).toEqual({ configured: false });
      await expect(
        context.registry.getApiKeyAndHeaders({
          provider: "openai",
          id: "gpt-isolated",
        } as unknown as Model<Api>),
      ).resolves.toEqual({
        ok: false,
        error: 'No API key found for "openai"',
      });
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }

    expect(setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("preserves instance auth.json resolution while blocking ambient fallback", async () => {
    const authStorage = {
      setRuntimeApiKey: vi.fn(),
      removeRuntimeApiKey: vi.fn(),
      get: vi.fn((provider: string) =>
        provider === "openai"
          ? { type: "api_key" as const, key: "stored-instance-key" }
          : undefined,
      ),
      has: vi.fn((provider: string) => provider === "openai"),
      getApiKey: vi.fn(async (provider: string) =>
        provider === "openai" ? "stored-instance-key" : undefined,
      ),
      hasAuth: vi.fn((provider: string) => provider === "openai"),
      getAuthStatus: vi.fn((provider: string) =>
        provider === "openai"
          ? { configured: true, source: "stored" as const }
          : { configured: false },
      ),
      getOAuthProviders: vi.fn(() => []),
      reload: vi.fn(),
    } as unknown as AuthStorage;
    const piSdk = {
      AuthStorage: {
        create: vi.fn(() => authStorage),
      },
      ModelRegistry: {
        create: vi.fn(() => ({}) as ModelRegistry),
      },
    } as unknown as Parameters<typeof createPiModelRegistry>[1];

    const context = createPiModelRegistry("/agent", piSdk, undefined, "pi_work");

    await expect(context.authStorage.getApiKey("openai")).resolves.toBe("stored-instance-key");
    expect(context.authStorage.hasAuth("openai")).toBe(true);
    expect(context.authStorage.getAuthStatus("openai")).toEqual({
      configured: true,
      source: "stored",
    });
  });

  it("does not fall through to an ambient key after an expired OAuth refresh returns null", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-account-a";
    const expiredCredential = {
      type: "oauth" as const,
      refresh: "expired-refresh-token",
      access: "expired-access-token",
      expires: Date.now() - 1_000,
    };
    const originalGetApiKey = vi.fn(async () => process.env.OPENAI_API_KEY);
    const refreshOAuthTokenWithLock = vi.fn(async () => null);
    const authStorage = {
      setRuntimeApiKey: vi.fn(),
      removeRuntimeApiKey: vi.fn(),
      get: vi.fn((provider: string) => (provider === "openai" ? expiredCredential : undefined)),
      has: vi.fn((provider: string) => provider === "openai"),
      getApiKey: originalGetApiKey,
      hasAuth: vi.fn(() => true),
      getAuthStatus: vi.fn(() => ({ configured: true, source: "stored" as const })),
      getOAuthProviders: vi.fn(() => [
        {
          id: "openai",
          name: "OpenAI",
          getApiKey: (credential: typeof expiredCredential) => credential.access,
        },
      ]),
      reload: vi.fn(),
      refreshOAuthTokenWithLock,
    } as unknown as AuthStorage;
    const piSdk = {
      AuthStorage: {
        create: vi.fn(() => authStorage),
      },
      ModelRegistry: {
        create: vi.fn(() => ({}) as ModelRegistry),
      },
    } as unknown as Parameters<typeof createPiModelRegistry>[1];

    try {
      const context = createPiModelRegistry("/agent", piSdk, undefined, "pi_work");

      await expect(context.authStorage.getApiKey("openai")).resolves.toBeUndefined();
      await expect(
        context.registry.getApiKeyAndHeaders({
          provider: "openai",
          id: "gpt-isolated",
        } as unknown as Model<Api>),
      ).resolves.toEqual({
        ok: false,
        error: 'No API key found for "openai"',
      });
      expect(refreshOAuthTokenWithLock).toHaveBeenCalledWith("openai");
      expect(originalGetApiKey).not.toHaveBeenCalled();
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });

  it("preserves a successful locked OAuth refresh for an isolated instance", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-account-a";
    let storedCredential = {
      type: "oauth" as const,
      refresh: "expired-refresh-token",
      access: "expired-access-token",
      expires: Date.now() - 1_000,
    };
    const originalGetApiKey = vi.fn(async () => process.env.OPENAI_API_KEY);
    const refreshOAuthTokenWithLock = vi.fn(async () => {
      storedCredential = {
        type: "oauth",
        refresh: "new-refresh-token",
        access: "refreshed-instance-key",
        expires: Date.now() + 60_000,
      };
      return {
        apiKey: "refreshed-instance-key",
        newCredentials: storedCredential,
      };
    });
    const authStorage = {
      setRuntimeApiKey: vi.fn(),
      removeRuntimeApiKey: vi.fn(),
      get: vi.fn((provider: string) => (provider === "openai" ? storedCredential : undefined)),
      has: vi.fn((provider: string) => provider === "openai"),
      getApiKey: originalGetApiKey,
      hasAuth: vi.fn(() => true),
      getAuthStatus: vi.fn(() => ({ configured: true, source: "stored" as const })),
      getOAuthProviders: vi.fn(() => [
        {
          id: "openai",
          name: "OpenAI",
          getApiKey: (credential: typeof storedCredential) => credential.access,
        },
      ]),
      reload: vi.fn(),
      refreshOAuthTokenWithLock,
    } as unknown as AuthStorage;
    const piSdk = {
      AuthStorage: {
        create: vi.fn(() => authStorage),
      },
      ModelRegistry: {
        create: vi.fn(() => ({}) as ModelRegistry),
      },
    } as unknown as Parameters<typeof createPiModelRegistry>[1];

    try {
      const context = createPiModelRegistry("/agent", piSdk, undefined, "pi_work");

      await expect(context.authStorage.getApiKey("openai")).resolves.toBe("refreshed-instance-key");
      await expect(
        context.registry.getApiKeyAndHeaders({
          provider: "openai",
          id: "gpt-isolated",
        } as unknown as Model<Api>),
      ).resolves.toEqual({
        ok: true,
        apiKey: "refreshed-instance-key",
      });
      expect(refreshOAuthTokenWithLock).toHaveBeenCalledTimes(1);
      expect(originalGetApiKey).not.toHaveBeenCalled();
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });

  it("resolves custom provider config from the selected environment, literals, and commands", async () => {
    const previousCustomKey = process.env.CUSTOM_KEY;
    const previousCustomHeader = process.env.CUSTOM_HEADER;
    const previousCustomModelHeader = process.env.CUSTOM_MODEL_HEADER;
    process.env.CUSTOM_KEY = "ambient-account-a";
    process.env.CUSTOM_HEADER = "ambient-header-a";
    process.env.CUSTOM_MODEL_HEADER = "ambient-model-header-a";
    const originalGetApiKey = vi.fn(async () => process.env.CUSTOM_KEY);
    const authStorage = {
      setRuntimeApiKey: vi.fn(),
      removeRuntimeApiKey: vi.fn(),
      get: vi.fn(() => undefined),
      has: vi.fn(() => false),
      getApiKey: originalGetApiKey,
      hasAuth: vi.fn(() => false),
      getAuthStatus: vi.fn(() => ({ configured: false })),
      getOAuthProviders: vi.fn(() => []),
      reload: vi.fn(),
    } as unknown as AuthStorage;
    const ambientBackedRegistryApiKey = vi.fn(async () => process.env.CUSTOM_KEY);
    const ambientBackedRequestAuth = vi.fn(async () => ({
      ok: true as const,
      apiKey: process.env.CUSTOM_KEY,
    }));
    const commandConfig = `!${JSON.stringify(process.execPath)} -p ${JSON.stringify(
      "process.env.CUSTOM_KEY",
    )}`;
    const registry = {
      providerRequestConfigs: new Map([
        ["custom", { apiKey: "CUSTOM_KEY", headers: { "X-Custom": "CUSTOM_HEADER" } }],
        ["custom-literal", { apiKey: "literal-api-key" }],
        ["custom-command", { apiKey: commandConfig }],
      ]),
      modelRequestHeaders: new Map<string, Record<string, string>>([
        ["custom:custom-model", { "X-Per-Model": "CUSTOM_MODEL_HEADER" }],
      ]),
      getApiKeyForProvider: ambientBackedRegistryApiKey,
      getApiKeyAndHeaders: ambientBackedRequestAuth,
      getProviderAuthStatus: vi.fn(() => ({
        configured: true,
        source: "environment" as const,
        label: "CUSTOM_KEY",
      })),
    } as unknown as ModelRegistry;
    const piSdk = {
      AuthStorage: {
        create: vi.fn(() => authStorage),
      },
      ModelRegistry: {
        create: vi.fn(() => registry),
      },
    } as unknown as Parameters<typeof createPiModelRegistry>[1];

    try {
      const context = createPiModelRegistry(
        "/agent",
        piSdk,
        {
          CUSTOM_KEY: "selected-account-b",
          CUSTOM_HEADER: "selected-header-b",
          CUSTOM_MODEL_HEADER: "selected-model-header-b",
        },
        "pi_work",
      );

      await expect(context.registry.getApiKeyForProvider("custom")).resolves.toBe(
        "selected-account-b",
      );
      await expect(context.registry.getApiKeyForProvider("custom-literal")).resolves.toBe(
        "literal-api-key",
      );
      await expect(context.registry.getApiKeyForProvider("custom-command")).resolves.toBe(
        "selected-account-b",
      );
      await expect(
        context.registry.getApiKeyAndHeaders({
          provider: "custom",
          id: "custom-model",
          headers: { "X-Model": "model-header" },
        } as unknown as Model<Api>),
      ).resolves.toEqual({
        ok: true,
        apiKey: "selected-account-b",
        headers: {
          "X-Custom": "selected-header-b",
          "X-Model": "model-header",
          "X-Per-Model": "selected-model-header-b",
        },
      });
      expect(context.registry.getProviderAuthStatus("custom")).toEqual({
        configured: true,
        source: "environment",
        label: "CUSTOM_KEY",
      });
      expect(originalGetApiKey).not.toHaveBeenCalled();
      expect(ambientBackedRegistryApiKey).not.toHaveBeenCalled();
      expect(ambientBackedRequestAuth).not.toHaveBeenCalled();
    } finally {
      if (previousCustomKey === undefined) {
        delete process.env.CUSTOM_KEY;
      } else {
        process.env.CUSTOM_KEY = previousCustomKey;
      }
      if (previousCustomHeader === undefined) {
        delete process.env.CUSTOM_HEADER;
      } else {
        process.env.CUSTOM_HEADER = previousCustomHeader;
      }
      if (previousCustomModelHeader === undefined) {
        delete process.env.CUSTOM_MODEL_HEADER;
      } else {
        process.env.CUSTOM_MODEL_HEADER = previousCustomModelHeader;
      }
    }
  });

  it("keeps identical auth.json commands cached inside their immutable instance environments", async () => {
    const previousCustomKey = process.env.CUSTOM_KEY;
    process.env.CUSTOM_KEY = "ambient-account";
    const commandConfig = `!${JSON.stringify(process.execPath)} -p ${JSON.stringify(
      "process.env.CUSTOM_KEY",
    )}`;
    const createContext = (environment: Record<string, string>, instanceId: string) => {
      const authStorage = {
        setRuntimeApiKey: vi.fn(),
        removeRuntimeApiKey: vi.fn(),
        get: vi.fn((provider: string) =>
          provider === "custom-command"
            ? { type: "api_key" as const, key: commandConfig }
            : undefined,
        ),
        has: vi.fn((provider: string) => provider === "custom-command"),
        getApiKey: vi.fn(async () => process.env.CUSTOM_KEY),
        hasAuth: vi.fn(() => true),
        getAuthStatus: vi.fn(() => ({ configured: true, source: "stored" as const })),
        getOAuthProviders: vi.fn(() => []),
        reload: vi.fn(),
      } as unknown as AuthStorage;
      const piSdk = {
        AuthStorage: {
          create: vi.fn(() => authStorage),
        },
        ModelRegistry: {
          create: vi.fn(() => ({}) as ModelRegistry),
        },
      } as unknown as Parameters<typeof createPiModelRegistry>[1];
      return createPiModelRegistry("/agent", piSdk, environment, instanceId);
    };

    try {
      const accountAEnvironment = { CUSTOM_KEY: "selected-account-a" };
      const accountA = createContext(accountAEnvironment, "pi_account_a");
      accountAEnvironment.CUSTOM_KEY = "mutated-after-snapshot";
      const accountB = createContext({ CUSTOM_KEY: "selected-account-b" }, "pi_account_b");

      await expect(
        Promise.all([
          accountA.authStorage.getApiKey("custom-command"),
          accountB.authStorage.getApiKey("custom-command"),
        ]),
      ).resolves.toEqual(["selected-account-a", "selected-account-b"]);
    } finally {
      if (previousCustomKey === undefined) {
        delete process.env.CUSTOM_KEY;
      } else {
        process.env.CUSTOM_KEY = previousCustomKey;
      }
    }
  });

  it("preserves ambient fallback for the default Pi instance", async () => {
    const authStorage = {
      setRuntimeApiKey: vi.fn(),
      has: vi.fn(() => false),
      getApiKey: vi.fn(async () => "ambient-default-key"),
      hasAuth: vi.fn(() => true),
      getAuthStatus: vi.fn(() => ({
        configured: true,
        source: "environment" as const,
        label: "OPENAI_API_KEY",
      })),
    } as unknown as AuthStorage;
    const piSdk = {
      AuthStorage: {
        create: vi.fn(() => authStorage),
      },
      ModelRegistry: {
        create: vi.fn(() => ({}) as ModelRegistry),
      },
    } as unknown as Parameters<typeof createPiModelRegistry>[1];

    const context = createPiModelRegistry("/agent", piSdk);

    await expect(context.authStorage.getApiKey("openai")).resolves.toBe("ambient-default-key");
    expect(context.authStorage.hasAuth("openai")).toBe(true);
    expect(context.authStorage.getAuthStatus("openai")).toMatchObject({
      source: "environment",
    });
  });
});

describe("isolated Pi provider routing", () => {
  const makeRegistry = (
    environment: Record<string, string>,
    credential?: { provider: string; key: string },
    options?: {
      models?: Array<Model<Api>>;
      providerRequestConfigs?: Map<string, Record<string, unknown>>;
      modelRequestHeaders?: Map<string, Record<string, string>>;
    },
  ) => {
    const authStorage = {
      setRuntimeApiKey: vi.fn(),
      removeRuntimeApiKey: vi.fn(),
      get: vi.fn((provider: string) =>
        credential?.provider === provider
          ? { type: "api_key" as const, key: credential.key }
          : undefined,
      ),
      has: vi.fn((provider: string) => credential?.provider === provider),
      getApiKey: vi.fn(),
      hasAuth: vi.fn(),
      getAuthStatus: vi.fn(() => ({ configured: false })),
      getOAuthProviders: vi.fn(() => []),
      reload: vi.fn(),
    } as unknown as AuthStorage;
    const registry = {
      models: options?.models ?? [],
      providerRequestConfigs: options?.providerRequestConfigs ?? new Map(),
      modelRequestHeaders: options?.modelRequestHeaders ?? new Map(),
      getApiKeyAndHeaders: vi.fn(),
      getApiKeyForProvider: vi.fn(),
      getProviderAuthStatus: vi.fn(() => ({ configured: false })),
    } as unknown as ModelRegistry;
    const sdk = {
      AuthStorage: { create: vi.fn(() => authStorage) },
      ModelRegistry: { create: vi.fn(() => registry) },
    } as unknown as Parameters<typeof createPiModelRegistry>[1];
    return createPiModelRegistry("/agent", sdk, environment, "pi_work").registry;
  };

  it.each([
    ["amazon-bedrock", "stored-bedrock", "Amazon Bedrock"],
    ["azure-openai-responses", "stored-azure", "Azure OpenAI"],
    ["google-vertex", "gcp-vertex-credentials", "Vertex ADC"],
  ])("fails closed for isolated %s ambient-chain auth", async (provider, key, message) => {
    const registry = makeRegistry({}, { provider, key });
    await expect(
      registry.getApiKeyAndHeaders({ provider, id: "model" } as Model<Api>),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining(message) });
  });

  it("resolves Cloudflare routing only from the selected instance", async () => {
    const sharedModel = {
      provider: "cloudflare-ai-gateway",
      id: "model",
      baseUrl:
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}",
    } as Model<Api>;
    const registryA = makeRegistry(
      { CLOUDFLARE_ACCOUNT_ID: "account-a", CLOUDFLARE_GATEWAY_ID: "gateway-a" },
      undefined,
      { models: [sharedModel] },
    );
    const registryB = makeRegistry(
      { CLOUDFLARE_ACCOUNT_ID: "account-b", CLOUDFLARE_GATEWAY_ID: "gateway-b" },
      undefined,
      { models: [sharedModel] },
    );
    const modelB = (registryB as unknown as { models: Model<Api>[] }).models[0]!;
    const modelA = (registryA as unknown as { models: Model<Api>[] }).models[0]!;
    await registryB.getApiKeyAndHeaders(modelB);
    await registryA.getApiKeyAndHeaders(modelA);
    expect(modelA.baseUrl).toContain("/account-a/gateway-a");
    expect(modelB.baseUrl).toContain("/account-b/gateway-b");
    expect(sharedModel.baseUrl).toContain("{CLOUDFLARE_ACCOUNT_ID}");
  });

  it("suppresses ambient OpenAI and Anthropic routing headers", async () => {
    const openai = makeRegistry({ OPENAI_API_KEY: "key-b" });
    await expect(
      openai.getApiKeyAndHeaders({
        provider: "openai",
        id: "model",
        api: "openai-responses",
      } as Model<Api>),
    ).resolves.toMatchObject({
      ok: true,
      headers: { "OpenAI-Organization": null, "OpenAI-Project": null },
    });
    const anthropic = makeRegistry({ ANTHROPIC_API_KEY: "key-b" });
    await expect(
      anthropic.getApiKeyAndHeaders({
        provider: "anthropic",
        id: "model",
        api: "anthropic-messages",
      } as Model<Api>),
    ).resolves.toMatchObject({ ok: true, headers: { Authorization: null } });
  });

  it("preserves explicit mixed-case models.json routing headers", async () => {
    const openai = makeRegistry({ OPENAI_API_KEY: "key-b" }, undefined, {
      providerRequestConfigs: new Map([
        [
          "openai",
          {
            headers: {
              "openai-organization": "explicit-org",
              "OPENAI-PROJECT": "explicit-project",
            },
          },
        ],
      ]),
    });
    const openaiAuth = await openai.getApiKeyAndHeaders({
      provider: "openai",
      id: "model",
      api: "openai-responses",
    } as Model<Api>);
    expect(openaiAuth).toMatchObject({
      ok: true,
      headers: { "openai-organization": "explicit-org", "OPENAI-PROJECT": "explicit-project" },
    });
    expect((openaiAuth as { headers?: Record<string, unknown> }).headers).not.toHaveProperty(
      "OpenAI-Organization",
    );

    const anthropic = makeRegistry({ ANTHROPIC_API_KEY: "key-b" }, undefined, {
      modelRequestHeaders: new Map([
        ["anthropic:model", { aUtHoRiZaTiOn: "Bearer explicit-token" }],
      ]),
    });
    await expect(
      anthropic.getApiKeyAndHeaders({
        provider: "anthropic",
        id: "model",
        api: "anthropic-messages",
      } as Model<Api>),
    ).resolves.toMatchObject({
      ok: true,
      headers: { aUtHoRiZaTiOn: "Bearer explicit-token" },
    });
  });
});

describe("Pi extension UI helpers", () => {
  it("keeps original select values while showing normalized unique labels", () => {
    const mappings = makePiUserInputOptions(["  OpenRouter  ", "", "OpenRouter"]);

    expect(mappings.map((mapping) => mapping.value)).toEqual(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.option.label)).toEqual([
      "OpenRouter",
      "Option 2",
      "OpenRouter (2)",
    ]);
  });

  it("provides a no-color theme object for UI-gated extensions", () => {
    expect(PLAIN_PI_EXTENSION_THEME.fg("accent", "ready")).toBe("ready");
    expect(PLAIN_PI_EXTENSION_THEME.bold("done")).toBe("done");
    expect(PLAIN_PI_EXTENSION_THEME.getThinkingBorderColor("medium")("thinking")).toBe("thinking");
  });
});
