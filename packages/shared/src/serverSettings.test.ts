import {
  DEFAULT_SERVER_SETTINGS,
  ProviderSessionStartInput,
  ServerSettings,
  ServerSettingsPatch,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  applyServerSettingsPatch,
  providerStartOptionsFromServerSettings,
  settingsChangedBeyondNewThreadDefaults,
} from "./serverSettings";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);

describe("providerStartOptionsFromServerSettings", () => {
  it("omits blank launch settings from provider session input", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "",
          homePath: "",
        },
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          binaryPath: "",
          homePath: "",
        },
        cursor: {
          ...DEFAULT_SERVER_SETTINGS.providers.cursor,
          binaryPath: "",
          apiEndpoint: "",
        },
        antigravity: {
          ...DEFAULT_SERVER_SETTINGS.providers.antigravity,
          binaryPath: "",
        },
        grok: {
          ...DEFAULT_SERVER_SETTINGS.providers.grok,
          binaryPath: "",
        },
        droid: {
          ...DEFAULT_SERVER_SETTINGS.providers.droid,
          binaryPath: "",
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          binaryPath: "",
          serverUrl: "",
        },
        pi: {
          ...DEFAULT_SERVER_SETTINGS.providers.pi,
          binaryPath: "",
          agentDir: "",
        },
        devin: {
          ...DEFAULT_SERVER_SETTINGS.providers.devin,
          binaryPath: "",
        },
        omp: {
          ...DEFAULT_SERVER_SETTINGS.providers.omp,
          binaryPath: "",
          agentDir: "",
        },
      },
    };

    const providerOptions = providerStartOptionsFromServerSettings(settings);

    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerOptions,
        runtimeMode: "full-access",
      }),
    ).not.toThrow();
    expect(providerOptions.codex).toEqual({});
    expect(providerOptions.claudeAgent).toEqual({ enableArtifacts: false });
    expect(providerOptions.cursor).toEqual({});
    expect(providerOptions.antigravity).toEqual({});
    expect(providerOptions.grok).toEqual({});
    expect(providerOptions.droid).toEqual({});
    expect(providerOptions.opencode).toEqual({ experimentalWebSockets: false });
    expect(providerOptions.pi).toEqual({});
    expect(providerOptions.devin).toEqual({});
    expect(providerOptions.omp).toEqual({});
  });

  it("preserves configured launch settings", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "/custom/bin/codex",
          homePath: "/custom/codex-home",
        },
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          binaryPath: "/custom/bin/claude",
          homePath: "/custom/claude-home",
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          binaryPath: "/custom/bin/opencode",
          serverUrl: "http://127.0.0.1:4096",
          experimentalWebSockets: true,
        },
        devin: {
          ...DEFAULT_SERVER_SETTINGS.providers.devin,
          binaryPath: "/custom/bin/devin",
        },
      },
    };

    const providerOptions = providerStartOptionsFromServerSettings(settings);

    expect(providerOptions.codex).toEqual({
      binaryPath: "/custom/bin/codex",
      homePath: "/custom/codex-home",
    });
    expect(providerOptions.claudeAgent).toEqual({
      binaryPath: "/custom/bin/claude",
      homePath: "/custom/claude-home",
      enableArtifacts: false,
    });
    expect(providerOptions.opencode).toEqual({
      binaryPath: "/custom/bin/opencode",
      serverUrl: "http://127.0.0.1:4096",
      experimentalWebSockets: true,
    });
    expect(providerOptions.devin).toEqual({ binaryPath: "/custom/bin/devin" });
  });

  it("uses the selected Codex account while preserving the shared provider binary", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "/custom/bin/codex",
          homePath: "/shared/codex-home",
          accounts: [
            {
              id: "work",
              label: "Work",
              homePath: "",
              shadowHomePath: "/accounts/work",
            },
          ],
          selectedAccountId: "work",
        },
      },
    };

    expect(providerStartOptionsFromServerSettings(settings).codex).toEqual({
      binaryPath: "/custom/bin/codex",
      homePath: "/shared/codex-home",
      shadowHomePath: "/accounts/work",
      accountId: "work",
    });
  });
});

describe("applyServerSettingsPatch newThreadDefaults", () => {
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

  it("defaults to no shared choice", () => {
    expect(DEFAULT_SERVER_SETTINGS.newThreadDefaults).toEqual({
      modelSelectionByProvider: {},
      activeProvider: null,
      runtimeMode: null,
    });
  });

  it("replaces a patched provider's selection whole and keeps the others", () => {
    const current = decodeSettings({
      newThreadDefaults: {
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.5",
            options: { reasoningEffort: "high", fastMode: true },
          },
          claudeAgent: { provider: "claudeAgent", model: "claude-opus-4-8" },
        },
        activeProvider: "codex",
        runtimeMode: "auto",
      },
    });

    const next = decodeSettings(
      applyServerSettingsPatch(
        current,
        decodePatch({
          newThreadDefaults: {
            modelSelectionByProvider: {
              codex: { provider: "codex", model: "gpt-5.5", options: { reasoningEffort: "low" } },
            },
          },
        }),
      ),
    );

    expect(next.newThreadDefaults.modelSelectionByProvider.codex).toEqual({
      provider: "codex",
      instanceId: "codex",
      model: "gpt-5.5",
      options: { reasoningEffort: "low" },
    });
    expect(next.newThreadDefaults.modelSelectionByProvider.claudeAgent?.model).toBe(
      "claude-opus-4-8",
    );
    expect(next.newThreadDefaults.activeProvider).toBe("codex");
    expect(next.newThreadDefaults.runtimeMode).toBe("auto");
  });

  it("clears the active provider and access mode with explicit nulls", () => {
    const current = decodeSettings({
      newThreadDefaults: { activeProvider: "codex", runtimeMode: "approval-required" },
    });

    const next = applyServerSettingsPatch(
      current,
      decodePatch({ newThreadDefaults: { activeProvider: null, runtimeMode: "full-access" } }),
    );

    expect(next.newThreadDefaults.activeProvider).toBeNull();
    expect(next.newThreadDefaults.runtimeMode).toBe("full-access");
  });
});

describe("settingsChangedBeyondNewThreadDefaults", () => {
  it("ignores a change to the shared new-chat defaults alone", () => {
    const picked = {
      ...DEFAULT_SERVER_SETTINGS,
      newThreadDefaults: {
        ...DEFAULT_SERVER_SETTINGS.newThreadDefaults,
        runtimeMode: "auto" as const,
      },
    };
    expect(settingsChangedBeyondNewThreadDefaults(DEFAULT_SERVER_SETTINGS, picked)).toBe(false);
    expect(
      settingsChangedBeyondNewThreadDefaults(DEFAULT_SERVER_SETTINGS, {
        ...picked,
        providers: {
          ...picked.providers,
          codex: { ...picked.providers.codex, binaryPath: "/opt/codex" },
        },
      }),
    ).toBe(true);
  });
});
