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
  applyLocalAppSettingsPatch,
  appSettingsPatchToServerSettingsPatch,
  buildInitialServerSettingsMigrationPatch,
  CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS,
  DEFAULT_CHAT_FONT_SIZE_PX,
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_TERMINAL_FONT_SIZE_PX,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  DEFAULT_TIMESTAMP_FORMAT,
  didProviderEnablementChange,
  getAppModelOptions,
  getCodexProviderDiscoveryOptions,
  getCustomBinaryPathForProvider,
  getCustomBinaryPathForProviderInstance,
  getDefaultNativeFontSmoothing,
  getCustomModelOptionsByProvider,
  getCustomModelsByProvider,
  getCustomModelsForProvider,
  getCustomModelsForProviderInstance,
  getDefaultCustomModelsForProvider,
  getGitTextGenerationModelOptions,
  getGitTextGenerationPickerOptions,
  getProviderInstanceOptions,
  getUnsupportedProviderInstanceOptions,
  getServerDisabledProviders,
  isGitTextGenerationSettingsDirty,
  getProviderStartOptions,
  mergeProviderInstanceConfigPatch,
  MODEL_PROVIDER_SETTINGS,
  normalizeChatFontSizePx,
  normalizeCustomModelSlugs,
  normalizeInitialStoredAppSettingsForServerMigration,
  normalizeStoredAppSettings,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSizePx,
  patchCustomModels,
  patchCustomModelsForProviderInstance,
  resolveAppModelSelection,
  resolveFollowUpDispatchMode,
  resolveTerminalFontFamilyStack,
} from "./appSettings";

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
});

describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });

  it("normalizes provider-specific aliases for claude", () => {
    expect(normalizeCustomModelSlugs(["sonnet"], "claudeAgent")).toEqual([]);
    expect(normalizeCustomModelSlugs(["claude/custom-sonnet"], "claudeAgent")).toEqual([
      "claude/custom-sonnet",
    ]);
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
  it("does not expose a hardcoded Antigravity model catalog", () => {
    expect(getAppModelOptions("antigravity", [])).toEqual([]);
  });

  it("does not expose Anthropic models in Pi before authenticated discovery", () => {
    expect(getAppModelOptions("pi", [])).toEqual([]);
  });

  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-6-astra",
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

  it("formats unknown GPT custom models with a readable label", () => {
    const options = getAppModelOptions("codex", ["gpt-5.1-codex-max"]);

    expect(options.at(-1)).toEqual({
      slug: "gpt-5.1-codex-max",
      name: "GPT-5.1 Codex Max",
      provider: "codex",
      isCustom: true,
    });
  });

  it("keeps a saved custom provider model available as an exact slug option", () => {
    const options = getAppModelOptions("claudeAgent", ["claude/custom-opus"], "claude/custom-opus");

    expect(options.some((option) => option.slug === "claude/custom-opus" && option.isCustom)).toBe(
      true,
    );
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

  it("preserves a currently selected transient git writing model", () => {
    const options = getGitTextGenerationModelOptions({
      customCodexModels: [],
      customOpenCodeModels: [],
      textGenerationModel: "openrouter/custom-model",
      textGenerationProvider: "opencode",
    });

    expect(options.at(-1)).toEqual({
      slug: "openrouter/custom-model",
      name: "Custom Model",
      provider: "opencode",
      isCustom: true,
    });
  });

  it("humanizes transient OpenCode git-writing models instead of showing the raw slug", () => {
    const options = getGitTextGenerationModelOptions({
      customCodexModels: [],
      customOpenCodeModels: [],
      textGenerationModel: "opencode-go/kimi-k2.6",
      textGenerationProvider: "opencode",
    });

    expect(options.at(-1)).toEqual({
      slug: "opencode-go/kimi-k2.6",
      name: "Kimi K2.6",
      provider: "opencode",
      isCustom: true,
    });
  });

  it("offers built-in Droid and Cursor models to a user currently on Codex", () => {
    const options = getGitTextGenerationModelOptions({
      customCodexModels: [],
      customOpenCodeModels: [],
      textGenerationModel: "gpt-5.6-luna",
      textGenerationProvider: "codex",
    });

    expect(options.some((option) => option.provider === "droid" && option.slug === "auto")).toBe(
      true,
    );
    expect(
      options.some((option) => option.provider === "cursor" && option.slug === "composer-2.5"),
    ).toBe(true);
    expect(options.some((option) => option.provider === "codex")).toBe(true);
  });

  it("includes custom Cursor models in the git writing picker", () => {
    const options = getGitTextGenerationModelOptions({
      customCodexModels: [],
      customCursorModels: ["cursor/custom-composer"],
      customOpenCodeModels: [],
      textGenerationModel: "gpt-5.6-luna",
      textGenerationProvider: "codex",
    });

    expect(
      options.some(
        (option) => option.provider === "cursor" && option.slug === "cursor/custom-composer",
      ),
    ).toBe(true);
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

  it("keeps runtime-discovered git-writing models isolated by provider instance", () => {
    const options = getGitTextGenerationPickerOptions(
      {
        customCodexModels: [],
        customClaudeModels: [],
        customCursorModels: [],
        customAntigravityModels: [],
        customGrokModels: [],
        customDroidModels: [],
        customDevinModels: [],
        customOpenCodeModels: [],
        customPiModels: [],
        codexAccounts: [],
        codexHomePath: "",
        selectedCodexAccountId: "default",
        textGenerationModel: "openrouter/work-model",
        textGenerationProvider: "opencode",
        textGenerationProviderInstanceId: "opencode_work",
        providerInstances: {
          opencode_work: {
            driver: "opencode",
            enabled: true,
            displayName: "OpenCode Work",
          },
        },
      },
      {
        opencode: [{ slug: "openrouter/personal-model", name: "Personal Model" }],
        opencode_work: [{ slug: "openrouter/work-model", name: "Work Model" }],
      },
    );

    const defaultModels = options
      .filter((entry) => entry.instance.instanceId === "opencode")
      .map((entry) => entry.option.slug);
    const workModels = options
      .filter((entry) => entry.instance.instanceId === "opencode_work")
      .map((entry) => entry.option.slug);

    expect(defaultModels).toContain("openrouter/personal-model");
    expect(defaultModels).not.toContain("openrouter/work-model");
    expect(workModels).toContain("openrouter/work-model");
    expect(workModels).not.toContain("openrouter/personal-model");
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

  it("resolves display names through the shared resolver", () => {
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
        "GPT-5.3 Codex",
      ),
    ).toBe("gpt-5.3-codex");
  });

  it("resolves aliases through the shared resolver", () => {
    expect(
      resolveAppModelSelection(
        "claudeAgent",
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
        "sonnet",
      ),
    ).toBe("claude-sonnet-5");
  });

  it("resolves transient selected custom models included in app model options", () => {
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
        "custom/selected-model",
      ),
    ).toBe("custom/selected-model");
  });
});

describe("timestamp format defaults", () => {
  it("defaults timestamp format to locale", () => {
    expect(DEFAULT_TIMESTAMP_FORMAT).toBe("locale");
  });
});

describe("chat font size defaults", () => {
  it("defaults chat font size to 12px", () => {
    expect(DEFAULT_CHAT_FONT_SIZE_PX).toBe(12);
  });

  it("clamps chat font size updates into the supported range", () => {
    expect(normalizeChatFontSizePx(9)).toBe(11);
    expect(normalizeChatFontSizePx(18.4)).toBe(18);
    expect(normalizeChatFontSizePx(Number.NaN)).toBe(DEFAULT_CHAT_FONT_SIZE_PX);
  });
});

describe("terminal font size defaults", () => {
  it("defaults terminal font size to 12px", () => {
    expect(DEFAULT_TERMINAL_FONT_SIZE_PX).toBe(12);
  });

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

describe("sidebar sort defaults", () => {
  it("defaults project sorting to manual", () => {
    expect(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER).toBe("manual");
  });

  it("defaults thread sorting to updated_at", () => {
    expect(DEFAULT_SIDEBAR_THREAD_SORT_ORDER).toBe("updated_at");
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
        customCodexModels: [" custom/internal-model ", "gpt-5.4", "custom/internal-model"],
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

describe("provider-specific custom models", () => {
  it("includes provider-specific custom slugs in non-codex model lists", () => {
    const claudeOptions = getAppModelOptions("claudeAgent", ["claude/custom-opus"]);

    expect(claudeOptions.some((option) => option.slug === "claude/custom-opus")).toBe(true);
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
          openCodeServerPassword: "",
          openCodeServerUrl: "",
          piAgentDir: "",
          piBinaryPath: "",
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
          openCodeServerPassword: "",
          openCodeServerUrl: "",
          piAgentDir: "",
          piBinaryPath: "",
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
          openCodeServerPassword: "",
          openCodeServerUrl: "",
          piAgentDir: "",
          piBinaryPath: "",
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
      }),
    ).toBeUndefined();
  });
});

describe("getProviderInstanceOptions", () => {
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
  } as const;

  it("exports one provider config per provider", () => {
    expect(MODEL_PROVIDER_SETTINGS.map((config) => config.provider)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "devin",
      "antigravity",
      "grok",
      "droid",
      "opencode",
      "pi",
    ]);
  });

  it("keeps Droid persistence compatible without advertising unsupported custom slugs", () => {
    expect(CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS.map((config) => config.provider)).not.toContain(
      "droid",
    );
  });

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
          enabled: true,
          config: { customModels: ["claude/default-instance"] },
        },
      },
    });
  });

  it("reads custom models for each provider", () => {
    expect(getCustomModelsForProvider(settings, "codex")).toEqual(["custom/codex-model"]);
    expect(getCustomModelsForProvider(settings, "claudeAgent")).toEqual(["claude/custom-opus"]);
    expect(getCustomModelsForProvider(settings, "cursor")).toEqual(["cursor/custom-model"]);
    expect(getCustomModelsForProvider(settings, "grok")).toEqual(["grok/custom-fast"]);
    expect(getCustomModelsForProvider(settings, "droid")).toEqual(["claude-opus-4-8-custom"]);
    expect(getCustomModelsForProvider(settings, "devin")).toEqual(["devin/custom-model"]);
    expect(getCustomModelsForProvider(settings, "opencode")).toEqual(["openrouter/gpt-oss-120b"]);
    expect(getCustomModelsForProvider(settings, "pi")).toEqual(["anthropic/custom-pi"]);
  });

  it("reads default custom models for each provider", () => {
    const defaults = {
      customCodexModels: ["default/codex-model"],
      customClaudeModels: ["claude/default-opus"],
      customCursorModels: ["cursor/default-model"],
      customAntigravityModels: ["Gemini 3.5 Flash (Experimental)"],
      customGrokModels: ["grok/default-fast"],
      customDroidModels: ["droid/default-model"],
      customDevinModels: ["adaptive"],
      customOpenCodeModels: ["openai/gpt-5"],
      customPiModels: ["anthropic/default-pi"],
    } as const;

    expect(getDefaultCustomModelsForProvider(defaults, "codex")).toEqual(["default/codex-model"]);
    expect(getDefaultCustomModelsForProvider(defaults, "claudeAgent")).toEqual([
      "claude/default-opus",
    ]);
    expect(getDefaultCustomModelsForProvider(defaults, "cursor")).toEqual(["cursor/default-model"]);
    expect(getDefaultCustomModelsForProvider(defaults, "antigravity")).toEqual([
      "Gemini 3.5 Flash (Experimental)",
    ]);
    expect(getDefaultCustomModelsForProvider(defaults, "grok")).toEqual(["grok/default-fast"]);
    expect(getDefaultCustomModelsForProvider(defaults, "droid")).toEqual(["droid/default-model"]);
    expect(getDefaultCustomModelsForProvider(defaults, "devin")).toEqual(["adaptive"]);
    expect(getDefaultCustomModelsForProvider(defaults, "opencode")).toEqual(["openai/gpt-5"]);
    expect(getDefaultCustomModelsForProvider(defaults, "pi")).toEqual(["anthropic/default-pi"]);
  });

  it("patches custom models for codex", () => {
    expect(patchCustomModels("codex", ["custom/codex-model"])).toEqual({
      customCodexModels: ["custom/codex-model"],
    });
  });

  it("patches custom models for claude", () => {
    expect(patchCustomModels("claudeAgent", ["claude/custom-opus"])).toEqual({
      customClaudeModels: ["claude/custom-opus"],
    });
  });

  it("patches custom models for Antigravity", () => {
    expect(patchCustomModels("antigravity", ["Gemini 3.5 Flash (Experimental)"])).toEqual({
      customAntigravityModels: ["Gemini 3.5 Flash (Experimental)"],
    });
  });

  it("patches custom models for grok", () => {
    expect(patchCustomModels("grok", ["grok/custom-fast"])).toEqual({
      customGrokModels: ["grok/custom-fast"],
    });
  });

  it("patches custom models for droid", () => {
    expect(patchCustomModels("droid", ["droid/custom-model"])).toEqual({
      customDroidModels: ["droid/custom-model"],
    });
  });

  it("patches custom models for devin", () => {
    expect(patchCustomModels("devin", ["devin/custom-model"])).toEqual({
      customDevinModels: ["devin/custom-model"],
    });
  });

  it("patches custom models for cursor", () => {
    expect(patchCustomModels("cursor", ["cursor/custom-model"])).toEqual({
      customCursorModels: ["cursor/custom-model"],
    });
  });

  it("patches custom models for opencode", () => {
    expect(patchCustomModels("opencode", ["openrouter/gpt-oss-120b"])).toEqual({
      customOpenCodeModels: ["openrouter/gpt-oss-120b"],
    });
  });

  it("patches custom models for pi", () => {
    expect(patchCustomModels("pi", ["anthropic/custom-pi"])).toEqual({
      customPiModels: ["anthropic/custom-pi"],
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
    });
  });

  it("builds provider-indexed model options including custom models", () => {
    const modelOptionsByProvider = getCustomModelOptionsByProvider(settings);

    expect(
      modelOptionsByProvider.codex.some((option) => option.slug === "custom/codex-model"),
    ).toBe(true);
    expect(
      modelOptionsByProvider.claudeAgent.some((option) => option.slug === "claude/custom-opus"),
    ).toBe(true);
    expect(
      modelOptionsByProvider.cursor.some((option) => option.slug === "cursor/custom-model"),
    ).toBe(true);
    expect(
      modelOptionsByProvider.antigravity.some(
        (option) => option.slug === "Gemini 3.5 Flash (Experimental)",
      ),
    ).toBe(true);
    expect(modelOptionsByProvider.grok.some((option) => option.slug === "grok/custom-fast")).toBe(
      true,
    );
    expect(
      modelOptionsByProvider.devin.some((option) => option.slug === "devin/custom-model"),
    ).toBe(true);
    expect(
      modelOptionsByProvider.opencode.some((option) => option.slug === "openrouter/gpt-oss-120b"),
    ).toBe(true);
    expect(modelOptionsByProvider.pi.some((option) => option.slug === "anthropic/custom-pi")).toBe(
      true,
    );
  });

  it("normalizes and deduplicates custom model options per provider", () => {
    const modelOptionsByProvider = getCustomModelOptionsByProvider({
      customCodexModels: ["  custom/codex-model ", "gpt-5.4", "custom/codex-model"],
      customClaudeModels: [" sonnet ", "claude/custom-opus", "claude/custom-opus"],
      customCursorModels: [" composer-2 ", "cursor/custom-model", "cursor/custom-model"],
      customAntigravityModels: [
        " Gemini 3.5 Flash ",
        "Gemini 3.5 Flash (Experimental)",
        "Gemini 3.5 Flash (Experimental)",
      ],
      customGrokModels: [" grok-build ", "grok/custom-fast", "grok/custom-fast"],
      customDroidModels: [" opus ", "droid/custom-model", "droid/custom-model"],
      customDevinModels: [" adaptive ", "devin/custom-model", "devin/custom-model"],
      customOpenCodeModels: [
        " openai/gpt-5 ",
        "openrouter/gpt-oss-120b",
        "openrouter/gpt-oss-120b",
      ],
      customPiModels: [
        " anthropic/claude-sonnet-4-5 ",
        "anthropic/custom-pi",
        "anthropic/custom-pi",
      ],
    });

    expect(
      modelOptionsByProvider.codex.filter((option) => option.slug === "custom/codex-model"),
    ).toHaveLength(1);
    expect(modelOptionsByProvider.codex.some((option) => option.slug === "gpt-5.4")).toBe(true);
    expect(
      modelOptionsByProvider.claudeAgent.filter((option) => option.slug === "claude/custom-opus"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.claudeAgent.some((option) => option.slug === "claude-sonnet-5"),
    ).toBe(true);
    expect(
      modelOptionsByProvider.droid.filter((option) => option.slug === "droid/custom-model"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.cursor.filter((option) => option.slug === "cursor/custom-model"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.antigravity.filter(
        (option) => option.slug === "Gemini 3.5 Flash (Experimental)",
      ),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.grok.filter((option) => option.slug === "grok/custom-fast"),
    ).toHaveLength(1);
    expect(modelOptionsByProvider.grok.some((option) => option.slug === "grok-4.6")).toBe(true);
    expect(
      modelOptionsByProvider.grok.filter((option) => option.slug === "grok-build"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.devin.filter((option) => option.slug === "devin/custom-model"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.opencode.filter((option) => option.slug === "openrouter/gpt-oss-120b"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.pi.filter((option) => option.slug === "anthropic/custom-pi"),
    ).toHaveLength(1);
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
      chatFontSizePx: DEFAULT_CHAT_FONT_SIZE_PX,
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
      sidebarProjectSortOrder: DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
      sidebarThreadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
      showStudioSection: true,
      showAutomationRunThreads: true,
      timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
      customCodexModels: [],
      customClaudeModels: [],
      customCursorModels: [],
      customGrokModels: [],
      customDroidModels: [],
      customOpenCodeModels: [],
      customPiModels: [],
    });
  });

  it("preserves the selected desktop app icon", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));

    expect(decode(JSON.stringify({ desktopAppIcon: "icon" })).desktopAppIcon).toBe("icon");
  });

  it("preserves the custom title bar preference", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema));

    expect(decode(JSON.stringify({ useCustomTitleBar: false })).useCustomTitleBar).toBe(false);
    expect(decode(JSON.stringify({})).useCustomTitleBar).toBe(true);
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
