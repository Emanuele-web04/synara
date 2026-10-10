// FILE: appSettings.test.ts
// Purpose: Verifies app settings normalization, model options, and provider dispatch options.
// Layer: Web settings tests
// Exports: Vitest suites for appSettings.ts

import { Schema } from "effect";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS_VIEW,
  ProviderInstanceId,
} from "@synara/contracts";
import { codexAccountInstanceId } from "@synara/shared/providerInstances";
import { describe, expect, it } from "vitest";

import {
  AppSettingsSchema,
  buildProviderInstanceSettingsPatch,
  applyLocalAppSettingsPatch,
  appSettingsPatchToServerSettingsPatch,
  buildInitialServerSettingsMigrationPatch,
  DEFAULT_CHAT_FONT_SIZE_PX,
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  DEFAULT_TERMINAL_FONT_SIZE_PX,
  didProviderCommandDiscoverySettingsChange,
  didProviderEnablementChange,
  getAppModelOptions,
  getCodexProviderDiscoveryOptions,
  getCustomBinaryPathForProvider,
  getCustomBinaryPathForProviderInstance,
  getDefaultNativeFontSmoothing,
  getCustomModelsByProvider,
  getCustomModelsForProviderInstance,
  getManageableProviderInstances,
  getProviderInstanceOptions,
  getUnsupportedProviderInstanceOptions,
  getServerDisabledProviders,
  isGitTextGenerationSettingsDirty,
  getProviderStartOptions,
  mergeProviderInstanceConfigPatch,
  mergeProviderStartOptions,
  normalizeChatFontSizePx,
  normalizeInitialStoredAppSettingsForServerMigration,
  normalizeStoredAppSettings,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSizePx,
  patchCustomModelsForProviderInstance,
  removeManageableProviderInstance,
  resolveAppModelSelection,
  resolveFollowUpDispatchMode,
  resolveSelectableProviderInstanceId,
  resolveTerminalFontFamilyStack,
  serverSettingsToAppSettings,
} from "./appSettings";

describe("provider process priority settings", () => {
  it("defaults on and forwards explicit opt-out and reset to the server", () => {
    expect(Schema.decodeSync(AppSettingsSchema)({}).lowerProviderProcessPriority).toBe(true);
    expect(appSettingsPatchToServerSettingsPatch({ lowerProviderProcessPriority: false })).toEqual({
      lowerProviderProcessPriority: false,
    });
    expect(appSettingsPatchToServerSettingsPatch({ lowerProviderProcessPriority: true })).toEqual({
      lowerProviderProcessPriority: true,
    });
  });
});

describe("source control writing settings", () => {
  it("defaults old settings to repository conventions and saves both preferences to the server", () => {
    const settings = Schema.decodeSync(AppSettingsSchema)({});
    expect(settings.sourceControlWritingStyle).toBe("repository");
    expect(settings.sourceControlCustomInstructions).toBe("");
    expect(
      appSettingsPatchToServerSettingsPatch({
        sourceControlWritingStyle: "custom",
        sourceControlCustomInstructions: "Use short bullets.",
      }),
    ).toEqual({
      sourceControlWritingStyle: "custom",
      sourceControlCustomInstructions: "Use short bullets.",
    });
    expect(
      appSettingsPatchToServerSettingsPatch({ sourceControlWritingStyle: "conventional" }),
    ).toEqual({ sourceControlWritingStyle: "conventional" });
    expect(appSettingsPatchToServerSettingsPatch({ sourceControlCustomInstructions: "" })).toEqual({
      sourceControlCustomInstructions: "",
    });
  });
});

describe("computer control defaults", () => {
  it("leaves computer control off until a preference is explicitly saved", () => {
    expect(AppSettingsSchema.makeUnsafe({}).computerControlEnabled).toBe(false);
    const decoded = Schema.decodeUnknownSync(AppSettingsSchema)({ autoOpenComputerPane: false });
    expect(normalizeStoredAppSettings(decoded).computerControlEnabled).toBe(false);
  });

  it("migrates the legacy per-chat computer control default", () => {
    const decoded = Schema.decodeUnknownSync(AppSettingsSchema)({
      allowComputerControlInNewChats: true,
    });
    const normalized = normalizeStoredAppSettings(decoded);
    expect(normalized.computerControlEnabled).toBe(true);
    expect(normalized).not.toHaveProperty("allowComputerControlInNewChats");
  });

  it("defaults the in-chat preview to the compact footprint", () => {
    expect(AppSettingsSchema.makeUnsafe({}).computerPreviewSize).toBe("compact");
    const decoded = Schema.decodeUnknownSync(AppSettingsSchema)({ computerPreviewSize: "large" });
    expect(normalizeStoredAppSettings(decoded).computerPreviewSize).toBe("large");
  });
});

describe("server-backed provider enablement", () => {
  it("reads disabled providers from the server settings view", () => {
    expect(
      getServerDisabledProviders({
        ...DEFAULT_SERVER_SETTINGS_VIEW,
        providers: {
          ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
          opencode: {
            ...DEFAULT_SERVER_SETTINGS_VIEW.providers.opencode,
            enabled: false,
          },
          pi: {
            ...DEFAULT_SERVER_SETTINGS_VIEW.providers.pi,
            enabled: false,
          },
        },
      }),
    ).toEqual(["opencode", "pi"]);
  });

  it("keeps server-backed provider disablement out of local settings", () => {
    const stored = AppSettingsSchema.makeUnsafe({
      disabledProviders: ["opencode"],
      hiddenProviders: ["pi"],
    });

    expect(normalizeStoredAppSettings(stored)).toMatchObject({
      disabledProviders: [],
      hiddenProviders: ["pi"],
    });
    expect(
      applyLocalAppSettingsPatch(stored, {
        disabledProviders: ["codex", "opencode"],
        hiddenProviders: ["grok"],
      }),
    ).toMatchObject({
      disabledProviders: [],
      hiddenProviders: ["grok"],
    });
  });

  it("persists disable and re-enable patches for every provider", () => {
    const disabledPatch = appSettingsPatchToServerSettingsPatch({
      disabledProviders: ["opencode", "pi"],
    });
    expect(disabledPatch.providers?.opencode?.enabled).toBe(false);
    expect(disabledPatch.providers?.pi?.enabled).toBe(false);
    expect(disabledPatch.providers?.codex?.enabled).toBe(true);

    const reenabledPatch = appSettingsPatchToServerSettingsPatch({ disabledProviders: [] });
    expect(reenabledPatch.providers?.opencode?.enabled).toBe(true);
    expect(reenabledPatch.providers?.pi?.enabled).toBe(true);

    const combinedPatch = appSettingsPatchToServerSettingsPatch({
      disabledProviders: [],
      openCodeBinaryPath: "/custom/opencode",
    });
    expect(combinedPatch.providers?.opencode).toMatchObject({
      binaryPath: "/custom/opencode",
      enabled: true,
    });
  });

  it("sends sparse enablement patches against the latest server view", () => {
    const currentSettings = {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providers: {
        ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
        opencode: {
          ...DEFAULT_SERVER_SETTINGS_VIEW.providers.opencode,
          enabled: false,
        },
      },
    };
    const patch = appSettingsPatchToServerSettingsPatch(
      { disabledProviders: ["opencode", "pi"] },
      currentSettings,
    );

    expect(patch.providers).toEqual({ pi: { enabled: false } });
  });

  it("omits unchanged provider defaults from a reset patch", () => {
    const patch = appSettingsPatchToServerSettingsPatch(
      {
        disabledProviders: [],
        openCodeBinaryPath: DEFAULT_SERVER_SETTINGS_VIEW.providers.opencode.binaryPath,
      },
      DEFAULT_SERVER_SETTINGS_VIEW,
    );

    expect(patch.providers).toBeUndefined();
  });

  it("invalidates discovery for initial and changed streamed provider settings", () => {
    const disabledOpenCode = {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providers: {
        ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
        opencode: {
          ...DEFAULT_SERVER_SETTINGS_VIEW.providers.opencode,
          enabled: false,
        },
      },
    };

    expect(didProviderEnablementChange(undefined, disabledOpenCode)).toBe(true);
    expect(
      didProviderEnablementChange(DEFAULT_SERVER_SETTINGS_VIEW, DEFAULT_SERVER_SETTINGS_VIEW),
    ).toBe(false);
    expect(didProviderEnablementChange(DEFAULT_SERVER_SETTINGS_VIEW, disabledOpenCode)).toBe(true);
  });

  it("invalidates command discovery when another client toggles Claude Artifacts", () => {
    const artifactsOn = {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providers: {
        ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS_VIEW.providers.claudeAgent,
          enableArtifacts: true,
        },
      },
    };

    expect(
      didProviderCommandDiscoverySettingsChange(DEFAULT_SERVER_SETTINGS_VIEW, artifactsOn),
    ).toBe(true);
    expect(didProviderCommandDiscoverySettingsChange(artifactsOn, artifactsOn)).toBe(false);
    // The first snapshot is covered by didProviderEnablementChange.
    expect(didProviderCommandDiscoverySettingsChange(undefined, artifactsOn)).toBe(false);
  });
});

describe("resolveFollowUpDispatchMode", () => {
  it("uses the selected behavior only while a turn is live", () => {
    expect(
      resolveFollowUpDispatchMode({
        behavior: "steer",
        hasLiveTurn: false,
      }),
    ).toBe("queue");
    expect(
      resolveFollowUpDispatchMode({
        behavior: "steer",
        hasLiveTurn: true,
      }),
    ).toBe("steer");
  });

  it("uses Ctrl/Cmd+Enter as a one-message inversion", () => {
    expect(
      resolveFollowUpDispatchMode({
        behavior: "queue",
        hasLiveTurn: true,
        useOppositeBehavior: true,
      }),
    ).toBe("steer");
    expect(
      resolveFollowUpDispatchMode({
        behavior: "steer",
        hasLiveTurn: true,
        useOppositeBehavior: true,
      }),
    ).toBe("queue");
  });
});

describe("getAppModelOptions", () => {
  it("does not expose Anthropic models in Pi before authenticated discovery", () => {
    expect(getAppModelOptions("pi", [])).toEqual([]);
  });

  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      provider: "codex",
      isCustom: true,
    });
  });

  it("keeps Cursor transport parameters out of selected-model hints", () => {
    const options = getAppModelOptions("cursor", [], "grok-4.5[thinking=true]");

    expect(
      options.filter((option) => option.slug.startsWith("grok-4.5")).map((option) => option.slug),
    ).toEqual(["grok-4.5"]);
  });
});

describe("isGitTextGenerationSettingsDirty", () => {
  it("compares the normalized provider and model defaults", () => {
    const defaults = AppSettingsSchema.makeUnsafe({});

    expect(isGitTextGenerationSettingsDirty(defaults, defaults)).toBe(false);
    expect(
      isGitTextGenerationSettingsDirty(
        { ...defaults, textGenerationProvider: "opencode", textGenerationModel: "custom/model" },
        defaults,
      ),
    ).toBe(true);
  });
});

describe("code review sort", () => {
  it("defaults existing settings to newest and preserves a stored activity order", () => {
    const decode = Schema.decodeUnknownSync(AppSettingsSchema);
    expect(decode({}).githubInboxSort).toBe("created");
    expect(decode({ githubInboxSort: "updated" }).githubInboxSort).toBe("updated");
  });
});

describe("removed settings", () => {
  it("ignores a code review list width stored before widths became fractions", () => {
    const decoded = Schema.decodeUnknownSync(AppSettingsSchema)({
      githubInboxListWidth: 420,
      githubInboxKind: "issue",
    });
    expect(decoded).not.toHaveProperty("githubInboxListWidth");
    expect(decoded.githubInboxKind).toBe("issue");
  });
});

describe("environment panel defaults", () => {
  it("starts optional text sections disabled without overriding explicit preferences", () => {
    const defaults = AppSettingsSchema.makeUnsafe({});
    expect(defaults).toMatchObject({
      showEnvironmentInstructions: false,
      showEnvironmentNotepad: false,
    });

    const enabled = AppSettingsSchema.makeUnsafe({
      showEnvironmentInstructions: true,
      showEnvironmentNotepad: true,
    });
    expect(enabled).toMatchObject({
      showEnvironmentInstructions: true,
      showEnvironmentNotepad: true,
    });
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(
      resolveAppModelSelection(
        "codex",
        {
          codex: ["galapagos-alpha"],
          claudeAgent: [],
          cursor: [],
          devin: [],
          antigravity: [],
          grok: [],
          droid: [],
          opencode: [],
          pi: [],
          omp: [],
        },
        "galapagos-alpha",
      ),
    ).toBe("galapagos-alpha");
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(
      resolveAppModelSelection(
        "codex",
        {
          codex: [],
          claudeAgent: [],
          cursor: [],
          devin: [],
          antigravity: [],
          grok: [],
          droid: [],
          opencode: [],
          pi: [],
          omp: [],
        },
        "",
      ),
    ).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });
});

describe("chat font size defaults", () => {
  it("clamps chat font size updates into the supported range", () => {
    expect(normalizeChatFontSizePx(9)).toBe(11);
    expect(normalizeChatFontSizePx(18.4)).toBe(18);
    expect(normalizeChatFontSizePx(Number.NaN)).toBe(DEFAULT_CHAT_FONT_SIZE_PX);
  });
});

describe("terminal font size defaults", () => {
  it("clamps terminal font size updates into the supported range", () => {
    expect(normalizeTerminalFontSizePx(8)).toBe(10);
    expect(normalizeTerminalFontSizePx(20.4)).toBe(20);
    expect(normalizeTerminalFontSizePx(99)).toBe(22);
    expect(normalizeTerminalFontSizePx(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE_PX);
  });
});

describe("terminal font family settings", () => {
  it("leaves the bundled terminal font stack active for empty values", () => {
    expect(resolveTerminalFontFamilyStack("")).toBeNull();
    expect(resolveTerminalFontFamilyStack("   ")).toBeNull();
  });

  it("quotes a single multi-word font and appends a monospace fallback", () => {
    expect(resolveTerminalFontFamilyStack("Fira Code")).toBe('"Fira Code", monospace');
    expect(resolveTerminalFontFamilyStack("Menlo")).toBe("Menlo, monospace");
  });

  it("preserves explicit font stacks while adding a generic fallback when missing", () => {
    expect(resolveTerminalFontFamilyStack('"Fira Code", Menlo')).toBe(
      '"Fira Code", Menlo, monospace',
    );
    expect(resolveTerminalFontFamilyStack('"Fira Code", ui-monospace')).toBe(
      '"Fira Code", ui-monospace',
    );
  });

  it("strips characters that could break the terminal font CSS variable", () => {
    expect(normalizeTerminalFontFamily("Fira; Code{}\n<>")).toBe("Fira Code");
  });
});

describe("normalizeStoredAppSettings", () => {
  it("defaults native font smoothing by platform", () => {
    expect(getDefaultNativeFontSmoothing("MacIntel")).toBe(true);
    expect(getDefaultNativeFontSmoothing("Win32")).toBe(false);
    expect(getDefaultNativeFontSmoothing("Linux x86_64")).toBe(false);
  });

  it("uses the current platform default for existing settings without a stored value", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))("{}");

    expect(decodedSettings.enableNativeFontSmoothing).toBe(getDefaultNativeFontSmoothing());
  });

  it("preserves an explicitly stored updated_at project sort order", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(
      JSON.stringify({
        sidebarProjectSortOrder: "updated_at",
        chatFontSizePx: 99,
        terminalFontSizePx: 3,
        customCodexModels: [
          " custom/internal-model ",
          "gpt-5.4",
          "custom/internal-model",
          "5.3",
          "",
        ],
      }),
    );

    expect(normalizeStoredAppSettings(decodedSettings)).toMatchObject({
      sidebarProjectSortOrder: "updated_at",
      chatFontSizePx: 18,
      terminalFontSizePx: 10,
      customCodexModels: ["custom/internal-model"],
    });
  });

  it("redacts provider instance secrets so plaintext never persists locally", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(
      JSON.stringify({
        providerInstances: {
          grok_work: {
            driver: "grok",
            environment: [
              { name: "XAI_API_KEY", value: "super-secret", sensitive: true },
              { name: "XAI_BASE_URL", value: "https://example.test", sensitive: false },
            ],
          },
          opencode_work: {
            driver: "opencode",
            config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "server-secret" },
          },
        },
      }),
    );

    const normalized = normalizeStoredAppSettings(decodedSettings);
    expect(normalized.providerInstances.grok_work?.environment).toEqual([
      { name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
      { name: "XAI_BASE_URL", value: "https://example.test", sensitive: false },
    ]);
    expect(normalized.providerInstances.opencode_work?.config).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "",
      serverPasswordRedacted: true,
    });
  });

  it("builds the initial server migration patch from legacy plaintext before storage redaction", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(
      JSON.stringify({
        providerInstances: {
          grok_work: {
            driver: "grok",
            environment: [{ name: "XAI_API_KEY", value: "super-secret", sensitive: true }],
          },
          opencode_work: {
            driver: "opencode",
            config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "server-secret" },
          },
        },
      }),
    );

    expect(buildInitialServerSettingsMigrationPatch(decodedSettings).providerInstances).toEqual({
      grok_work: {
        driver: "grok",
        environment: [{ name: "XAI_API_KEY", value: "super-secret", sensitive: true }],
      },
      opencode_work: {
        driver: "opencode",
        config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "server-secret" },
      },
    });
    expect(normalizeStoredAppSettings(decodedSettings).providerInstances).toEqual({
      grok_work: {
        driver: "grok",
        environment: [{ name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true }],
      },
      opencode_work: {
        driver: "opencode",
        config: {
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "",
          serverPasswordRedacted: true,
        },
      },
    });
  });

  it("keeps legacy provider secrets until the server migration is committed", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(
      JSON.stringify({
        providerInstances: {
          grok_work: {
            driver: "grok",
            environment: [{ name: "XAI_API_KEY", value: "super-secret", sensitive: true }],
          },
          opencode_work: {
            driver: "opencode",
            config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "server-secret" },
          },
        },
      }),
    );

    expect(
      normalizeInitialStoredAppSettingsForServerMigration(decodedSettings, false).providerInstances,
    ).toEqual({
      grok_work: {
        driver: "grok",
        environment: [{ name: "XAI_API_KEY", value: "super-secret", sensitive: true }],
      },
      opencode_work: {
        driver: "opencode",
        config: { serverUrl: "http://127.0.0.1:4096", serverPassword: "server-secret" },
      },
    });
    expect(
      normalizeInitialStoredAppSettingsForServerMigration(decodedSettings, true).providerInstances,
    ).toEqual({
      grok_work: {
        driver: "grok",
        environment: [{ name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true }],
      },
      opencode_work: {
        driver: "opencode",
        config: {
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "",
          serverPasswordRedacted: true,
        },
      },
    });
  });

  it("drops default provider command names so they do not look like custom paths", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(
      JSON.stringify({
        claudeBinaryPath: "claude",
        codexBinaryPath: "codex",
        cursorBinaryPath: "cursor-agent",
        antigravityBinaryPath: "agy",
        grokBinaryPath: "grok",
        droidBinaryPath: "droid",
        openCodeBinaryPath: "opencode",
        piBinaryPath: "pi",
      }),
    );
    const normalized = normalizeStoredAppSettings(decodedSettings);

    expect(normalized).toMatchObject({
      claudeBinaryPath: "",
      codexBinaryPath: "",
      cursorBinaryPath: "",
      antigravityBinaryPath: "",
      grokBinaryPath: "",
      droidBinaryPath: "",
      openCodeBinaryPath: "",
      piBinaryPath: "",
      ompBinaryPath: "",
      ompAgentDir: "",
    });
    expect(getCustomBinaryPathForProvider(normalized, "opencode")).toBe("");
  });

  it("keeps server-valid Codex account ids that need slugged instance ids", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(
      JSON.stringify({
        codexAccounts: [
          {
            id: "work@example.com",
            label: "Work Email",
            homePath: "/Users/you/.codex",
            shadowHomePath: "/Users/you/.codex-work",
          },
        ],
        selectedCodexAccountId: "work@example.com",
      }),
    );
    const normalized = normalizeStoredAppSettings(decodedSettings);
    const instanceId = codexAccountInstanceId("work@example.com");

    expect(normalized.codexAccounts).toEqual([
      {
        id: "work@example.com",
        label: "Work Email",
        homePath: "/Users/you/.codex",
        shadowHomePath: "/Users/you/.codex-work",
      },
    ]);
    expect(normalized.selectedCodexAccountId).toBe("work@example.com");
    expect(getProviderInstanceOptions(normalized)).toContainEqual(
      expect.objectContaining({
        instanceId,
        provider: "codex",
        label: "Work Email",
      }),
    );
  });
});

describe("getProviderStartOptions", () => {
  it("returns only populated provider overrides", () => {
    expect(
      getProviderStartOptions({
        claudeBinaryPath: "/usr/local/bin/claude",
        codexBinaryPath: "",
        codexHomePath: "/Users/you/.codex",
        codexAccounts: [],
        selectedCodexAccountId: "default",
        cursorApiEndpoint: "http://localhost:3000",
        cursorBinaryPath: "/usr/local/bin/agent",
        antigravityBinaryPath: "/usr/local/bin/agy",
        grokBinaryPath: "/usr/local/bin/grok",
        droidBinaryPath: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "",
        devinBinaryPath: "/usr/local/bin/devin",
        ompBinaryPath: "",
        ompAgentDir: "",
      }),
    ).toEqual({
      claudeAgent: {
        binaryPath: "/usr/local/bin/claude",
      },
      codex: {
        homePath: "/Users/you/.codex",
      },
      cursor: {
        apiEndpoint: "http://localhost:3000",
        binaryPath: "/usr/local/bin/agent",
      },
      antigravity: {
        binaryPath: "/usr/local/bin/agy",
      },
      grok: {
        binaryPath: "/usr/local/bin/grok",
      },
      devin: {
        binaryPath: "/usr/local/bin/devin",
      },
    });
  });

  it("returns undefined when no provider overrides are configured", () => {
    expect(
      getProviderStartOptions({
        claudeBinaryPath: "",
        codexBinaryPath: "",
        codexHomePath: "",
        codexAccounts: [],
        selectedCodexAccountId: "default",
        cursorApiEndpoint: "",
        cursorBinaryPath: "",
        antigravityBinaryPath: "",
        grokBinaryPath: "",
        droidBinaryPath: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "",
        devinBinaryPath: "",
        ompBinaryPath: "",
        ompAgentDir: "",
      }),
    ).toBeUndefined();
  });

  it("resolves the selected Codex account into provider start options", () => {
    expect(
      getProviderStartOptions({
        claudeBinaryPath: "",
        codexBinaryPath: "",
        codexHomePath: "/Users/you/.codex",
        codexAccounts: [
          {
            id: "work",
            label: "Work",
            homePath: "",
            shadowHomePath: "/Users/you/.codex_work",
          },
        ],
        selectedCodexAccountId: "work",
        cursorApiEndpoint: "",
        cursorBinaryPath: "",
        antigravityBinaryPath: "",
        grokBinaryPath: "",
        droidBinaryPath: "",
        devinBinaryPath: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "",
        ompBinaryPath: "",
        ompAgentDir: "",
      }),
    ).toEqual({
      codex: {
        accountId: "work",
        homePath: "/Users/you/.codex",
        shadowHomePath: "/Users/you/.codex_work",
      },
    });
  });

  it("uses an explicit default Codex instance instead of the legacy selected account", () => {
    expect(
      getProviderStartOptions(
        {
          claudeBinaryPath: "",
          codexBinaryPath: "",
          codexHomePath: "/Users/you/.codex",
          codexAccounts: [
            {
              id: "work",
              label: "Work",
              homePath: "",
              shadowHomePath: "/Users/you/.codex_work",
            },
          ],
          selectedCodexAccountId: "work",
          cursorApiEndpoint: "",
          cursorBinaryPath: "",
          devinBinaryPath: "",
          antigravityBinaryPath: "",
          grokBinaryPath: "",
          droidBinaryPath: "",
          openCodeBinaryPath: "",
          openCodeExperimentalWebSockets: false,
          openCodeServerUrl: "",
          piAgentDir: "",
          piBinaryPath: "",
          ompBinaryPath: "",
          ompAgentDir: "",
        },
        "codex",
      ),
    ).toEqual({
      codex: {
        homePath: "/Users/you/.codex",
      },
    });
  });

  it("resolves a legacy Codex account instance into account-isolated options", () => {
    expect(
      getProviderStartOptions(
        {
          claudeBinaryPath: "",
          codexBinaryPath: "",
          codexHomePath: "/Users/you/.codex",
          codexAccounts: [
            {
              id: "work",
              label: "Work",
              homePath: "/Users/work/.codex",
              shadowHomePath: "/Users/work/.codex-shadow",
            },
          ],
          selectedCodexAccountId: "default",
          cursorApiEndpoint: "",
          cursorBinaryPath: "",
          devinBinaryPath: "",
          antigravityBinaryPath: "",
          grokBinaryPath: "",
          droidBinaryPath: "",
          openCodeBinaryPath: "",
          openCodeExperimentalWebSockets: false,
          openCodeServerUrl: "",
          piAgentDir: "",
          piBinaryPath: "",
          ompBinaryPath: "",
          ompAgentDir: "",
        },
        "codex_work",
      ),
    ).toEqual({
      codex: {
        accountId: "work",
        homePath: "/Users/work/.codex",
        shadowHomePath: "/Users/work/.codex-shadow",
      },
    });
  });

  it("overlays explicit Claude provider instance HOME options", () => {
    expect(
      getProviderStartOptions(
        {
          claudeBinaryPath: "/usr/local/bin/claude",
          claudeHomePath: "/Users/base",
          codexBinaryPath: "",
          codexHomePath: "",
          codexAccounts: [],
          selectedCodexAccountId: "default",
          cursorApiEndpoint: "",
          cursorBinaryPath: "",
          devinBinaryPath: "",
          antigravityBinaryPath: "",
          grokBinaryPath: "",
          droidBinaryPath: "",
          openCodeBinaryPath: "",
          openCodeExperimentalWebSockets: false,
          openCodeServerUrl: "",
          piAgentDir: "",
          piBinaryPath: "",
          ompBinaryPath: "",
          ompAgentDir: "",
          providerInstances: {
            claude_work: {
              driver: "claudeAgent",
              displayName: "Claude Work",
              enabled: true,
              config: {
                binaryPath: "/custom/bin/claude",
                homePath: "/Users/work",
              },
            },
          },
        },
        "claude_work",
      ),
    ).toEqual({
      claudeAgent: {
        binaryPath: "/custom/bin/claude",
        homePath: "/Users/work",
      },
    });
  });

  it("does not inherit the selected Codex account into a custom Codex instance", () => {
    const result = getProviderStartOptions(
      {
        claudeBinaryPath: "",
        codexBinaryPath: "",
        codexHomePath: "/Users/default/.codex",
        codexAccounts: [
          {
            id: "selected",
            label: "Selected",
            homePath: "/Users/selected/.codex",
            shadowHomePath: "/Users/selected/.codex-shadow",
          },
        ],
        selectedCodexAccountId: "selected",
        cursorApiEndpoint: "",
        cursorBinaryPath: "",
        devinBinaryPath: "",
        antigravityBinaryPath: "",
        grokBinaryPath: "",
        droidBinaryPath: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "",
        ompBinaryPath: "",
        ompAgentDir: "",
        providerInstances: {
          codex_work: {
            driver: "codex",
            enabled: true,
            config: { homePath: "/Users/work/.codex" },
          },
        },
      },
      "codex_work",
    );

    expect(result).toEqual({ codex: { homePath: "/Users/work/.codex" } });
  });

  it("keeps legacy launch settings for a configured default instance", () => {
    const result = getProviderStartOptions(
      {
        claudeBinaryPath: "/opt/bin/claude",
        codexBinaryPath: "",
        codexHomePath: "",
        codexAccounts: [],
        selectedCodexAccountId: "default",
        cursorApiEndpoint: "",
        cursorBinaryPath: "",
        devinBinaryPath: "",
        antigravityBinaryPath: "",
        grokBinaryPath: "",
        droidBinaryPath: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "",
        ompBinaryPath: "",
        ompAgentDir: "",
        providerInstances: {
          claudeAgent: {
            driver: "claudeAgent",
            enabled: true,
            config: { customModels: ["claude/custom"] },
          },
        },
      },
      "claudeAgent",
    );

    expect(result).toEqual({ claudeAgent: { binaryPath: "/opt/bin/claude" } });
  });

  it("emits an empty Codex options object when switching back to default among accounts", () => {
    expect(
      getProviderStartOptions({
        claudeBinaryPath: "",
        codexBinaryPath: "",
        codexHomePath: "",
        codexAccounts: [
          {
            id: "work",
            label: "Work",
            homePath: "",
            shadowHomePath: "/Users/you/.codex_work",
          },
        ],
        selectedCodexAccountId: "default",
        cursorApiEndpoint: "",
        cursorBinaryPath: "",
        antigravityBinaryPath: "",
        grokBinaryPath: "",
        droidBinaryPath: "",
        devinBinaryPath: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "",
        ompBinaryPath: "",
        ompAgentDir: "",
      }),
    ).toEqual({
      codex: {},
    });
  });

  it("keeps default Codex account discovery separate from custom accounts", () => {
    expect(
      getCodexProviderDiscoveryOptions({
        codexBinaryPath: "",
        codexHomePath: "",
        codexAccounts: [
          {
            id: "work",
            label: "Work",
            homePath: "",
            shadowHomePath: "/Users/you/.codex_work",
          },
        ],
        selectedCodexAccountId: "default",
      }),
    ).toEqual({
      binaryPath: null,
      homePath: null,
      shadowHomePath: null,
      accountId: "default",
    });
  });

  it("ignores default provider command names as custom binary overrides", () => {
    expect(
      getProviderStartOptions({
        claudeBinaryPath: "claude",
        codexBinaryPath: "codex",
        codexHomePath: "",
        codexAccounts: [],
        selectedCodexAccountId: "default",
        cursorApiEndpoint: "",
        cursorBinaryPath: "cursor-agent",
        antigravityBinaryPath: "agy",
        grokBinaryPath: "grok",
        devinBinaryPath: "devin",
        droidBinaryPath: "droid",
        openCodeBinaryPath: "opencode",
        openCodeExperimentalWebSockets: false,
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "pi",
        ompBinaryPath: "",
        ompAgentDir: "",
      }),
    ).toBeUndefined();
  });
});

describe("mergeProviderStartOptions", () => {
  it("returns the base when there is no overlay", () => {
    const base = { codex: { binaryPath: "/opt/codex" } };
    expect(mergeProviderStartOptions(base, undefined)).toEqual(base);
  });

  it("returns the overlay when there is no base", () => {
    const overlay = { claudeAgent: { binaryPath: "/opt/claude" } };
    expect(mergeProviderStartOptions(undefined, overlay)).toEqual(overlay);
  });

  it("keeps base providers the overlay does not name", () => {
    expect(
      mergeProviderStartOptions(
        { codex: { binaryPath: "/opt/codex" }, claudeAgent: { permissionMode: "plan" } },
        { claudeAgent: { binaryPath: "/opt/claude" } },
      ),
    ).toEqual({
      codex: { binaryPath: "/opt/codex" },
      claudeAgent: { permissionMode: "plan", binaryPath: "/opt/claude" },
    });
  });

  it("lets the overlay win only the keys it sets on a shared provider", () => {
    expect(
      mergeProviderStartOptions(
        { codex: { binaryPath: "/opt/codex", homePath: "/home/me/.codex" } },
        { codex: { binaryPath: "/group/codex" } },
      ),
    ).toEqual({
      codex: { binaryPath: "/group/codex", homePath: "/home/me/.codex" },
    });
  });
});

describe("getProviderInstanceOptions", () => {
  it("disables every account of a globally disabled provider and preserves account switches", () => {
    const settings = {
      ...AppSettingsSchema.makeUnsafe({}),
      disabledProviders: ["codex" as const],
      codexAccounts: [{ id: "work", label: "Work", homePath: "", shadowHomePath: "" }],
      providerInstances: {
        codex_personal: { driver: "codex", enabled: true },
        codex_off: { driver: "codex", enabled: false },
      },
    };
    const options = getProviderInstanceOptions(settings);
    expect(
      options.filter((option) => option.provider === "codex").map((option) => option.enabled),
    ).toEqual([false, false, false, false]);
    expect(options.find((option) => option.provider === "claudeAgent")?.enabled).toBe(true);
    const restored = getProviderInstanceOptions({ ...settings, disabledProviders: [] });
    expect(restored.find((option) => option.instanceId === "codex_personal")?.enabled).toBe(true);
    expect(restored.find((option) => option.instanceId === "codex_off")?.enabled).toBe(false);
  });

  it("keeps derived Codex account instance ids schema-valid for long account ids", () => {
    const accountId = `a${"b".repeat(63)}`;
    const options = getProviderInstanceOptions({
      codexAccounts: [
        {
          id: accountId,
          label: "Long Codex Account",
          homePath: "",
          shadowHomePath: "",
        },
      ],
      codexHomePath: "",
      providerInstances: {},
      selectedCodexAccountId: "default",
    });

    const accountOption = options.find((option) => option.label === "Long Codex Account");
    expect(accountOption?.instanceId.length).toBeLessThanOrEqual(64);
    expect(Schema.is(ProviderInstanceId)(accountOption?.instanceId)).toBe(true);
  });

  it("keeps the provider's own name on a default account that only stores overrides", () => {
    const options = getProviderInstanceOptions({
      codexAccounts: [],
      codexHomePath: "",
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", accentColor: "#7c3aed" },
        opencode: { driver: "opencode", displayName: "Team OpenCode" },
        codex_work: { driver: "codex", accentColor: "#16a34a" },
      },
      selectedCodexAccountId: "default",
    });
    const byId = new Map(options.map((option) => [String(option.instanceId), option]));

    expect(byId.get("claudeAgent")).toMatchObject({
      label: "Claude",
      accentColor: "#7c3aed",
      isDefault: true,
    });
    expect(byId.get("opencode")).toMatchObject({ label: "Team OpenCode", isDefault: true });
    // A named-by-id account falls back to its humanized id.
    expect(byId.get("codex_work")).toMatchObject({
      label: "Codex Work",
      accentColor: "#16a34a",
      isDefault: false,
    });
    expect(byId.get("codex")?.accentColor).toBeUndefined();
  });

  it("keeps a migrated Codex account's saved name when its explicit entry only overrides", () => {
    const instanceId = codexAccountInstanceId("work");
    const options = getProviderInstanceOptions({
      codexAccounts: [{ id: "work", label: "Office", homePath: "", shadowHomePath: "" }],
      codexHomePath: "",
      providerInstances: { [instanceId]: { driver: "codex", enabled: false } },
      selectedCodexAccountId: "default",
    });

    expect(options.find((option) => option.instanceId === instanceId)).toMatchObject({
      label: "Office",
      enabled: false,
    });
  });

  it("keeps unsupported instances visible for missing-driver affordances", () => {
    expect(
      getUnsupportedProviderInstanceOptions({
        providerInstances: {
          fork_work: {
            driver: "customFork",
            displayName: "Fork Work",
            enabled: true,
          },
        },
      }),
    ).toEqual([
      {
        instanceId: "fork_work",
        driver: "customFork",
        label: "Fork Work",
        enabled: true,
        isDefault: false,
        supported: false,
      },
    ]);
  });

  it("surfaces legacy derived Codex accounts as manageable rows", () => {
    const instanceId = codexAccountInstanceId("work@example.com");

    expect(
      getManageableProviderInstances(
        {
          codexAccounts: [
            {
              id: "work@example.com",
              label: "Work",
              homePath: "/Users/you/.codex-work",
              shadowHomePath: "/Users/you/.codex-work-shadow",
            },
          ],
          codexBinaryPath: "/opt/codex",
          codexHomePath: "",
          providerInstances: {
            [instanceId]: {
              driver: "codex",
              enabled: false,
              config: { binaryPath: "/opt/work-codex" },
            },
          },
          selectedCodexAccountId: "work@example.com",
        },
        "codex",
      ),
    ).toEqual([
      {
        instanceId,
        legacyCodexAccountId: "work@example.com",
        instance: {
          driver: "codex",
          displayName: "Work",
          enabled: false,
          config: {
            accountId: "work@example.com",
            binaryPath: "/opt/work-codex",
            homePath: "/Users/you/.codex-work",
            shadowHomePath: "/Users/you/.codex-work-shadow",
          },
        },
      },
    ]);
  });

  it("removes a legacy Codex account and its exact-instance preferences together", () => {
    const instanceId = codexAccountInstanceId("work@example.com");

    expect(
      removeManageableProviderInstance(
        {
          codexAccounts: [
            {
              id: "work@example.com",
              label: "Work",
              homePath: "",
              shadowHomePath: "",
            },
          ],
          codexHomePath: "",
          providerInstances: {
            [instanceId]: { driver: "codex", enabled: false },
          },
          selectedCodexAccountId: "work@example.com",
        },
        instanceId,
      ),
    ).toEqual({
      codexAccounts: [],
      providerInstances: {},
      selectedCodexAccountId: "default",
    });
  });
});

describe("buildProviderInstanceSettingsPatch", () => {
  const instanceId = codexAccountInstanceId("work@example.com");
  const migrated = {
    codexAccounts: [
      {
        id: "work@example.com",
        label: "Work",
        homePath: "/Users/you/.codex-work",
        shadowHomePath: "",
      },
      { id: "side", label: "Side", homePath: "", shadowHomePath: "" },
    ],
    codexHomePath: "",
    providerInstances: {},
    selectedCodexAccountId: "work@example.com",
  };

  it("routes a migrated account's rename and homes to its codexAccounts entry", () => {
    expect(
      buildProviderInstanceSettingsPatch(
        migrated,
        instanceId,
        { displayName: "Office", config: { shadowHomePath: "/Users/you/.codex-shadow" } },
        "work@example.com",
      ),
    ).toEqual({
      codexAccounts: [
        {
          id: "work@example.com",
          label: "Office",
          homePath: "/Users/you/.codex-work",
          shadowHomePath: "/Users/you/.codex-shadow",
        },
        { id: "side", label: "Side", homePath: "", shadowHomePath: "" },
      ],
    });
  });

  it("clears a stale explicit copy of the identity it moves, keeping other overrides", () => {
    expect(
      buildProviderInstanceSettingsPatch(
        {
          ...migrated,
          providerInstances: {
            [instanceId]: {
              driver: "codex",
              displayName: "Stale name",
              enabled: false,
              config: {
                homePath: "/stale/home",
                shadowHomePath: "/stale/shadow",
                binaryPath: "/opt/work-codex",
              },
            },
          },
        },
        instanceId,
        { config: { homePath: "/Users/you/.codex-office" } },
        "work@example.com",
      ),
    ).toEqual({
      codexAccounts: [
        {
          id: "work@example.com",
          label: "Work",
          homePath: "/Users/you/.codex-office",
          shadowHomePath: "",
        },
        { id: "side", label: "Side", homePath: "", shadowHomePath: "" },
      ],
      providerInstances: {
        [instanceId]: {
          driver: "codex",
          enabled: false,
          config: { binaryPath: "/opt/work-codex" },
        },
      },
    });
  });

  it("keeps a migrated account's other edits on an explicit entry that carries no identity", () => {
    expect(
      buildProviderInstanceSettingsPatch(
        migrated,
        instanceId,
        { enabled: false, accentColor: "#16a34a", config: { binaryPath: "/opt/work-codex" } },
        "work@example.com",
      ),
    ).toEqual({
      providerInstances: {
        [instanceId]: {
          driver: "codex",
          accentColor: "#16a34a",
          enabled: false,
          config: { binaryPath: "/opt/work-codex" },
        },
      },
    });
  });

  it("edits an explicit account in place and clears what the patch empties", () => {
    expect(
      buildProviderInstanceSettingsPatch(
        {
          ...migrated,
          providerInstances: {
            claude_work: {
              driver: "claudeAgent",
              displayName: "Work",
              accentColor: "#2563eb",
              enabled: true,
              config: { configDir: "~/.claude-work" },
            },
          },
        },
        "claude_work",
        { displayName: "  ", accentColor: null, config: { configDir: "~/.claude-office" } },
      ),
    ).toEqual({
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          enabled: true,
          config: { configDir: "~/.claude-office" },
        },
      },
    });
  });

  it("gives a default account its first explicit entry", () => {
    expect(
      buildProviderInstanceSettingsPatch(migrated, "claudeAgent", { displayName: "Personal" }),
    ).toEqual({
      providerInstances: { claudeAgent: { driver: "claudeAgent", displayName: "Personal" } },
    });
  });

  it("ignores an account that does not exist", () => {
    expect(
      buildProviderInstanceSettingsPatch(migrated, "codex_gone", { enabled: false }),
    ).toBeNull();
  });
});

describe("provider instance configuration", () => {
  it("does not leak a provider-wide binary path into a custom instance", () => {
    expect(
      getCustomBinaryPathForProviderInstance(
        {
          claudeBinaryPath: "/legacy/bin/claude",
          claudeHomePath: "",
          codexAccounts: [],
          codexBinaryPath: "",
          codexHomePath: "",
          selectedCodexAccountId: "default",
          cursorBinaryPath: "",
          cursorApiEndpoint: "",
          devinBinaryPath: "",
          antigravityBinaryPath: "",
          grokBinaryPath: "",
          droidBinaryPath: "",
          openCodeBinaryPath: "",
          openCodeExperimentalWebSockets: false,
          openCodeServerUrl: "",
          piBinaryPath: "",
          ompBinaryPath: "",
          ompAgentDir: "",
          piAgentDir: "",
          providerInstances: {
            claude_work: { driver: "claudeAgent", enabled: true, config: {} },
          },
        },
        "claudeAgent",
        "claude_work",
      ),
    ).toBe("");
  });

  it("drops a stale redaction marker when replacing a secret", () => {
    expect(
      mergeProviderInstanceConfigPatch(
        { serverPassword: "", serverPasswordRedacted: true },
        { serverPassword: "new-secret" },
      ),
    ).toEqual({ serverPassword: "new-secret" });
  });
});

describe("resolveSelectableProviderInstanceId", () => {
  it("uses the selected Codex account when only the provider is requested", () => {
    const settings = {
      codexAccounts: [
        {
          id: "work@example.com",
          label: "Work",
          homePath: "",
          shadowHomePath: "",
        },
      ],
      codexHomePath: "",
      providerInstances: {},
      selectedCodexAccountId: "work@example.com",
    } as const;

    expect(resolveSelectableProviderInstanceId(settings, "codex")).toBe(
      codexAccountInstanceId("work@example.com"),
    );
  });

  it("keeps a requested enabled provider instance", () => {
    const settings = {
      codexAccounts: [],
      codexHomePath: "",
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          enabled: true,
          config: { homePath: "/tmp/claude-work" },
        },
      },
      selectedCodexAccountId: "default",
    } as const;

    expect(resolveSelectableProviderInstanceId(settings, "claudeAgent", "claude_work")).toBe(
      "claude_work",
    );
  });

  it("falls back from a deleted or disabled custom instance to the provider default", () => {
    const settings = {
      codexAccounts: [],
      codexHomePath: "",
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          enabled: false,
          config: { homePath: "/tmp/claude-work" },
        },
      },
      selectedCodexAccountId: "default",
    } as const;

    expect(resolveSelectableProviderInstanceId(settings, "claudeAgent", "claude_work")).toBe(
      "claudeAgent",
    );
    expect(resolveSelectableProviderInstanceId(settings, "claudeAgent", "claude_deleted")).toBe(
      "claudeAgent",
    );
  });
});

describe("provider-indexed custom model settings", () => {
  const settings = {
    customCodexModels: ["custom/codex-model"],
    customClaudeModels: ["claude/custom-opus"],
    customCursorModels: ["cursor/custom-model"],
    customAntigravityModels: ["Gemini 3.5 Flash (Experimental)"],
    customGrokModels: ["grok/custom-fast"],
    customDroidModels: ["claude-opus-4-8-custom"],
    customDevinModels: ["devin/custom-model"],
    customOpenCodeModels: ["openrouter/gpt-oss-120b"],
    customPiModels: ["anthropic/custom-pi"],
    customOmpModels: [],
  } as const;

  it("stores default-instance custom models in the provider instance map", () => {
    expect(
      patchCustomModelsForProviderInstance(
        {
          codexAccounts: [],
          codexHomePath: "",
          providerInstances: {},
        },
        { instanceId: "claudeAgent", provider: "claudeAgent", isDefault: true },
        ["claude/default-instance"],
      ),
    ).toEqual({
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent",
          config: { customModels: ["claude/default-instance"] },
        },
      },
    });
  });

  it("patches custom models for a selected provider instance", () => {
    const providerSettings = {
      ...settings,
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          enabled: true,
          displayName: "Claude Work",
          config: { homePath: "/tmp/claude-work" },
        },
      },
    } as const;

    expect(
      patchCustomModelsForProviderInstance(
        providerSettings,
        {
          instanceId: "claude_work",
          provider: "claudeAgent",
          isDefault: false,
        },
        ["claude/work-only"],
      ),
    ).toEqual({
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          enabled: true,
          displayName: "Claude Work",
          config: { homePath: "/tmp/claude-work", customModels: ["claude/work-only"] },
        },
      },
    });
  });

  it("patches custom models for the default provider instance into providerInstances", () => {
    expect(
      patchCustomModelsForProviderInstance(
        {
          codexAccounts: [],
          codexHomePath: "",
          providerInstances: {},
          selectedCodexAccountId: "default",
        },
        {
          instanceId: "claudeAgent",
          provider: "claudeAgent",
          isDefault: true,
        },
        ["claude/default-instance"],
      ),
    ).toEqual({
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent",
          // Launch settings are not copied: derived default instances merge the
          // live legacy settings in at derivation time, so later edits to the
          // provider settings keep applying.
          config: {
            customModels: ["claude/default-instance"],
          },
        },
      },
    });
  });

  it("preserves server settings when saving custom models for default provider instances", () => {
    expect(
      patchCustomModelsForProviderInstance(
        {
          codexAccounts: [],
          codexHomePath: "",
          providerInstances: {},
          selectedCodexAccountId: "default",
        },
        {
          instanceId: "opencode",
          provider: "opencode",
          isDefault: true,
        },
        ["openrouter/custom-opencode"],
      ),
    ).toEqual({
      providerInstances: {
        opencode: {
          driver: "opencode",
          config: {
            customModels: ["openrouter/custom-opencode"],
          },
        },
      },
    });
  });

  it("materializes Codex account-derived instances when saving custom models", () => {
    expect(
      patchCustomModelsForProviderInstance(
        {
          codexAccounts: [
            {
              id: "work",
              label: "Work",
              homePath: "/tmp/codex-work",
              shadowHomePath: "/tmp/codex-shadow",
            },
          ],
          codexHomePath: "/tmp/codex-default",
          providerInstances: {},
          selectedCodexAccountId: "work",
        },
        {
          instanceId: "codex_work",
          provider: "codex",
          isDefault: false,
        },
        ["custom/work-codex"],
      ),
    ).toEqual({
      providerInstances: {
        codex_work: {
          driver: "codex",
          displayName: "Work",
          // Account launch fields stay in the legacy codexAccounts entry and are
          // merged into the derived instance, so the patch stores only models.
          config: {
            customModels: ["custom/work-codex"],
          },
        },
      },
    });
  });

  it("drops stale redaction markers when replacing provider instance secrets", () => {
    expect(
      mergeProviderInstanceConfigPatch(
        {
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "",
          serverPasswordRedacted: true,
        },
        { serverPassword: "new-secret" },
      ),
    ).toEqual({
      serverUrl: "http://127.0.0.1:4096",
      serverPassword: "new-secret",
    });
  });
  it("builds a complete provider-indexed custom model record", () => {
    expect(getCustomModelsByProvider(settings)).toEqual({
      codex: ["custom/codex-model"],
      claudeAgent: ["claude/custom-opus"],
      cursor: ["cursor/custom-model"],
      antigravity: ["Gemini 3.5 Flash (Experimental)"],
      grok: ["grok/custom-fast"],
      droid: ["claude-opus-4-8-custom"],
      devin: ["devin/custom-model"],
      opencode: ["openrouter/gpt-oss-120b"],
      pi: ["anthropic/custom-pi"],
      omp: [],
    });
  });

  it("reads custom models from the selected provider instance without leaking provider buckets", () => {
    const derivedCodexInstanceId = codexAccountInstanceId("work@example.com");
    const modelSettings = {
      ...settings,
      codexAccounts: [
        {
          id: "work@example.com",
          label: "Work Email",
          homePath: "",
          shadowHomePath: "",
        },
      ],
      codexHomePath: "",
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          enabled: true,
          config: { customModels: ["claude/work-only"] },
        },
        claude_empty: {
          driver: "claudeAgent",
          enabled: true,
          config: {},
        },
        codex_work: {
          driver: "codex",
          enabled: true,
          config: {},
        },
      },
    } as const;

    expect(
      getCustomModelsForProviderInstance(modelSettings, {
        instanceId: "claudeAgent",
        provider: "claudeAgent",
        isDefault: true,
      }),
    ).toEqual(["claude/custom-opus"]);
    expect(
      getCustomModelsForProviderInstance(modelSettings, {
        instanceId: "claude_work",
        provider: "claudeAgent",
        isDefault: false,
      }),
    ).toEqual(["claude/work-only"]);
    expect(
      getCustomModelsForProviderInstance(modelSettings, {
        instanceId: "claude_empty",
        provider: "claudeAgent",
        isDefault: false,
      }),
    ).toEqual([]);
    expect(
      getCustomModelsForProviderInstance(modelSettings, {
        instanceId: "codex_work",
        provider: "codex",
        isDefault: false,
      }),
    ).toEqual([]);
    expect(
      getCustomModelsForProviderInstance(modelSettings, {
        instanceId: derivedCodexInstanceId,
        provider: "codex",
        isDefault: false,
      }),
    ).toEqual(["custom/codex-model"]);
  });
});

describe("AppSettingsSchema", () => {
  it("keeps sent-message anchoring enabled for settings saved before the preference existed", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));

    expect(decode(JSON.stringify({ chatFontSizePx: 17 }))).toMatchObject({
      anchorSentMessagesToTop: true,
      chatFontSizePx: 17,
    });
  });

  it("preserves disabled sent-message anchoring across persistence until defaults are restored", () => {
    const codec = Schema.fromJsonString(AppSettingsSchema);
    const decode = Schema.decodeSync(codec);
    const defaults = decode("{}");
    const settings = applyLocalAppSettingsPatch(defaults, { anchorSentMessagesToTop: false });
    const restored = decode(Schema.encodeSync(codec)(settings));

    expect(restored).toMatchObject({ anchorSentMessagesToTop: false });
    expect(applyLocalAppSettingsPatch(restored, defaults)).toMatchObject({
      anchorSentMessagesToTop: true,
    });
  });

  it("opens Tasks as the list until the user picks the Kanban view", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));
    expect(decode(JSON.stringify({})).tasksViewMode).toBe("list");
    expect(decode(JSON.stringify({ tasksViewMode: "kanban" })).tasksViewMode).toBe("kanban");
  });

  it("migrates persisted Gemini provider settings to Antigravity", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));
    const decoded = decode(
      JSON.stringify({
        textGenerationProvider: "gemini",
        defaultProvider: "gemini",
        hiddenProviders: ["gemini"],
        providerOrder: ["codex", "gemini"],
        hiddenModels: [{ provider: "gemini", slug: "gemini-3.1-pro-preview" }],
        geminiBinaryPath: "/custom/bin/gemini",
        customGeminiModels: ["gemini-custom-preview"],
      }),
    );

    expect(decoded).toMatchObject({
      textGenerationProvider: "antigravity",
      defaultProvider: "antigravity",
      hiddenProviders: ["antigravity"],
      providerOrder: ["codex", "antigravity"],
      hiddenModels: [{ provider: "antigravity", slug: "gemini-3.1-pro-preview" }],
    });
    expect(normalizeStoredAppSettings(decoded)).toMatchObject({
      antigravityBinaryPath: "/custom/bin/gemini",
      customAntigravityModels: ["gemini-custom-preview"],
    });
    expect(normalizeStoredAppSettings(decoded)).not.toHaveProperty("geminiBinaryPath");
    expect(normalizeStoredAppSettings(decoded)).not.toHaveProperty("customGeminiModels");
  });

  it("migrates persisted Kilo provider settings without transferring them to OpenCode", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));
    const decoded = decode(
      JSON.stringify({
        textGenerationProvider: "kilo",
        defaultProvider: "kilo",
        hiddenProviders: ["kilo", "grok"],
        providerOrder: ["codex", "kilo", "pi"],
        hiddenModels: [{ provider: "kilo", slug: "kilo/kilo-auto/free" }],
      }),
    );

    // Single-value settings fall back to the runtime that hosted Kilo sessions;
    // list entries (hidden/disabled/order) are dropped so Kilo preferences do
    // not transfer onto the separate OpenCode subscription.
    expect(decoded).toMatchObject({
      textGenerationProvider: "opencode",
      defaultProvider: "opencode",
      hiddenProviders: ["grok"],
      providerOrder: ["codex", "pi"],
      hiddenModels: [],
    });
  });

  it("drops unknown provider names from persisted lists instead of failing decode", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));
    const decoded = decode(
      JSON.stringify({
        hiddenProviders: ["some-future-provider", "codex"],
        providerOrder: ["gemini", "codex"],
        railUsageProviders: ["some-future-provider", "codex", "gemini"],
        chatFontSizePx: 17,
      }),
    );

    expect(decoded).toMatchObject({
      hiddenProviders: ["codex"],
      providerOrder: ["antigravity", "codex"],
      railUsageProviders: ["codex", "antigravity"],
      chatFontSizePx: 17,
    });
  });

  it("migrates sidebar provider selections to their default account ids", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));
    expect(normalizeStoredAppSettings(decode("{}")).railUsageInstanceIds).toEqual([
      "codex",
      "claudeAgent",
    ]);
    expect(
      normalizeStoredAppSettings(decode(JSON.stringify({ railUsageProviders: ["gemini"] })))
        .railUsageInstanceIds,
    ).toEqual(["antigravity"]);
    expect(
      normalizeStoredAppSettings(decode(JSON.stringify({ railUsageProviders: [] })))
        .railUsageInstanceIds,
    ).toEqual([]);
  });

  it("persists two Claude accounts and an explicit empty sidebar selection", () => {
    const codec = Schema.fromJsonString(AppSettingsSchema);
    const decode = Schema.decodeSync(codec);
    const updated = applyLocalAppSettingsPatch(decode("{}"), {
      railUsageInstanceIds: ["claudeAgent", "claude_work"],
    });
    expect(
      normalizeStoredAppSettings(decode(Schema.encodeSync(codec)(updated))).railUsageInstanceIds,
    ).toEqual(["claudeAgent", "claude_work"]);
    const withDisabledChoice = applyLocalAppSettingsPatch(updated, {
      railUsageInstanceIds: ["claudeAgent", "claude_work", "codex"],
    });
    expect(
      normalizeStoredAppSettings(decode(Schema.encodeSync(codec)(withDisabledChoice)))
        .railUsageInstanceIds,
    ).toEqual(["claudeAgent", "claude_work", "codex"]);
    const hidden = applyLocalAppSettingsPatch(updated, { railUsageInstanceIds: [] });
    expect(
      normalizeStoredAppSettings(decode(Schema.encodeSync(codec)(hidden))).railUsageInstanceIds,
    ).toEqual([]);
  });

  it("drops malformed sidebar account ids without resetting unrelated preferences", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));
    const decoded = decode(
      JSON.stringify({
        railUsageInstanceIds: ["claude_work", "invalid id", "", "../account"],
        chatFontSizePx: 17,
      }),
    );
    expect(decoded.railUsageInstanceIds).toEqual(["claude_work"]);
    expect(decoded.chatFontSizePx).toBe(17);
  });

  it("drops rail ids this build does not know and ignores the retired classic-sidebar keys", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));
    const decoded = decode(
      JSON.stringify({
        sidebarLayout: "classic",
        railItemOrder: ["some-future-item", "kanban", "home"],
        hiddenRailItems: ["some-future-item", "studio"],
        sidebarNavOrder: ["some-future-item", "kanban"],
        hiddenSidebarNavItems: ["some-future-item"],
      }),
    );

    expect(decoded).toMatchObject({
      railItemOrder: ["kanban", "home"],
      hiddenRailItems: ["studio"],
    });
    // Settings saved while the classic sidebar existed still decode; its keys are dropped.
    expect(decoded).not.toHaveProperty("sidebarLayout");
    expect(decoded).not.toHaveProperty("sidebarNavOrder");
    expect(decoded).not.toHaveProperty("hiddenSidebarNavItems");
  });

  it("defaults the Environment panel closed and preserves an explicit open preference", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));

    expect(decode("{}").environmentPanelDefaultOpen).toBe(false);
    expect(
      decode(JSON.stringify({ environmentPanelDefaultOpen: true })).environmentPanelDefaultOpen,
    ).toBe(true);
  });

  it("keeps usage popover details collapsed by default and preserves an explicit choice", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));

    expect(decode("{}").usageDetailsDefaultOpen).toBe(false);
    expect(decode("{}").usagePopoverShowResetCredits).toBe(true);
    expect(decode("{}").usagePopoverShowUsageLines).toBe(true);
    expect(
      decode(JSON.stringify({ usagePopoverShowUsageLines: false })).usagePopoverShowUsageLines,
    ).toBe(false);
    expect(decode(JSON.stringify({ usageDetailsDefaultOpen: true })).usageDetailsDefaultOpen).toBe(
      true,
    );
  });

  it("preserves a disabled simulator auto-open preference across settings persistence", () => {
    const codec = Schema.fromJsonString(AppSettingsSchema);
    const decode = Schema.decodeSync(codec);
    const defaults = decode("{}");
    expect(defaults.autoOpenDevicePane).toBe(true);

    const settings = applyLocalAppSettingsPatch(defaults, { autoOpenDevicePane: false });
    expect(decode(Schema.encodeSync(codec)(settings)).autoOpenDevicePane).toBe(false);
  });

  it("fills decoding defaults for persisted settings that predate newer keys", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));

    expect(
      decode(
        JSON.stringify({
          codexBinaryPath: "/usr/local/bin/codex",
          confirmThreadDelete: false,
        }),
      ),
    ).toMatchObject({
      claudeBinaryPath: "",
      uiDensity: "comfortable",
      chatFontSizePx: 13,
      terminalFontSizePx: 12,
      codexBinaryPath: "/usr/local/bin/codex",
      codexHomePath: "",
      grokBinaryPath: "",
      defaultThreadEnvMode: "local",
      confirmThreadDelete: false,
      confirmTerminalTabClose: true,
      desktopAppIcon: "default",
      useCustomTitleBar: true,
      enableAppSnap: false,
      appSnapShortcut: { kind: "both-option-keys" },
      appSnapPlaySound: true,
      enableAssistantStreaming: true,
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
      sidebarProjectSortOrder: "manual",
      sidebarThreadSortOrder: "updated_at",
      showGroupsSection: true,
      showAutomationRunThreads: true,
      timestampFormat: "locale",
      customCodexModels: [],
      customClaudeModels: [],
      customCursorModels: [],
      customGrokModels: [],
      customDroidModels: [],
      customOpenCodeModels: [],
      customPiModels: [],
      customOmpModels: [],
    });
  });

  it("migrates the former AppSnap feature flag", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));

    expect(
      normalizeStoredAppSettings(decode(JSON.stringify({ enableAppshots: true }))),
    ).toMatchObject({
      enableAppSnap: true,
    });
    expect(
      normalizeStoredAppSettings(decode(JSON.stringify({ enableAppshots: true }))),
    ).not.toHaveProperty("enableAppshots");
  });
});

describe("keepAwakeMode mapping", () => {
  it("defaults to off when absent from stored settings", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));
    expect(decode("{}").keepAwakeMode).toBe("off");
  });

  it("maps the server setting into app settings", () => {
    const mapped = serverSettingsToAppSettings({
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      keepAwakeMode: "always",
    });
    expect(mapped.keepAwakeMode).toBe("always");
  });

  it("maps the app setting into a server patch", () => {
    expect(appSettingsPatchToServerSettingsPatch({ keepAwakeMode: "agent" })).toEqual({
      keepAwakeMode: "agent",
    });
    expect(
      appSettingsPatchToServerSettingsPatch({ enableAssistantStreaming: true }),
    ).not.toHaveProperty("keepAwakeMode");
  });
});
