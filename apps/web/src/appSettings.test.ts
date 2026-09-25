// FILE: appSettings.test.ts
// Purpose: Verifies app settings normalization, model options, and provider dispatch options.
// Layer: Web settings tests
// Exports: Vitest suites for appSettings.ts

import { Schema } from "effect";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  AppSettingsSchema,
  applyLocalAppSettingsPatch,
  appSettingsPatchToServerSettingsPatch,
  DEFAULT_CHAT_FONT_SIZE_PX,
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  DEFAULT_TERMINAL_FONT_SIZE_PX,
  didProviderCommandDiscoverySettingsChange,
  didProviderEnablementChange,
  getAppModelOptions,
  getCustomBinaryPathForProvider,
  getDefaultNativeFontSmoothing,
  getCustomModelsByProvider,
  getGitTextGenerationModelOptions,
  getServerDisabledProviders,
  isGitTextGenerationSettingsDirty,
  getProviderStartOptions,
  normalizeChatFontSizePx,
  normalizeStoredAppSettings,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSizePx,
  resolveAppModelSelection,
  resolveFollowUpDispatchMode,
  resolveTerminalFontFamilyStack,
} from "./appSettings";

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

describe("getGitTextGenerationModelOptions", () => {
  it("merges codex and OpenCode model options for git writing settings", () => {
    const options = getGitTextGenerationModelOptions({
      customCodexModels: ["custom/codex-model"],
      customOpenCodeModels: ["openrouter/gpt-oss-120b"],
      textGenerationModel: "openai/gpt-5",
      textGenerationProvider: "opencode",
    });

    expect(options.some((option) => option.slug === "gpt-5.4-mini")).toBe(true);
    expect(options.some((option) => option.slug === "openai/gpt-5")).toBe(true);
    expect(options.some((option) => option.slug === "openrouter/gpt-oss-120b")).toBe(true);
  });

  it("prefers runtime-discovered OpenCode models for git writing settings", () => {
    const options = getGitTextGenerationModelOptions(
      {
        customCodexModels: [],
        customOpenCodeModels: [],
        textGenerationModel: "openrouter/custom-model",
        textGenerationProvider: "opencode",
      },
      {
        opencode: [{ slug: "openrouter/gpt-oss-120b", name: "GPT OSS 120B" }],
      },
    );

    expect(options.some((option) => option.slug === "openrouter/gpt-oss-120b")).toBe(true);
    expect(options.some((option) => option.slug === "openrouter/custom-model")).toBe(true);
  });

  it("omits chat-only providers that have no Git text-generation backend", () => {
    const options = getGitTextGenerationModelOptions({
      customCodexModels: [],
      customClaudeModels: ["claude-opus-4-8"],
      customGrokModels: ["grok-4.6"],
      customOpenCodeModels: [],
      textGenerationModel: "gpt-5.6-luna",
      textGenerationProvider: "codex",
    });

    expect(options.some((option) => option.provider === "claudeAgent")).toBe(false);
    expect(options.some((option) => option.provider === "grok")).toBe(false);
    expect(options.some((option) => option.provider === "antigravity")).toBe(false);
    expect(options.some((option) => option.provider === "pi")).toBe(false);
    expect(options.some((option) => option.provider === "devin")).toBe(false);
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
    });
    expect(getCustomBinaryPathForProvider(normalized, "opencode")).toBe("");
  });
});

describe("getProviderStartOptions", () => {
  it("returns only populated provider overrides", () => {
    expect(
      getProviderStartOptions({
        claudeBinaryPath: "/usr/local/bin/claude",
        codexBinaryPath: "",
        codexHomePath: "/Users/you/.codex",
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
      }),
    ).toBeUndefined();
  });

  it("ignores default provider command names as custom binary overrides", () => {
    expect(
      getProviderStartOptions({
        claudeBinaryPath: "claude",
        codexBinaryPath: "codex",
        codexHomePath: "",
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
      }),
    ).toBeUndefined();
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
  } as const;

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
    });
  });
});

describe("AppSettingsSchema", () => {
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
      }),
    );

    expect(decoded).toMatchObject({
      hiddenProviders: ["codex"],
      providerOrder: ["antigravity", "codex"],
    });
  });

  it("defaults the Environment panel closed and preserves an explicit open preference", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));

    expect(decode("{}").environmentPanelDefaultOpen).toBe(false);
    expect(
      decode(JSON.stringify({ environmentPanelDefaultOpen: true })).environmentPanelDefaultOpen,
    ).toBe(true);
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
      showStudioSection: true,
      showAutomationRunThreads: true,
      timestampFormat: "locale",
      customCodexModels: [],
      customClaudeModels: [],
      customCursorModels: [],
      customGrokModels: [],
      customDroidModels: [],
      customOpenCodeModels: [],
      customPiModels: [],
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
