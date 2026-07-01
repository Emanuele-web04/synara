// FILE: appSettings.test.ts
// Purpose: Verifies app settings normalization, model options, and provider dispatch options.
// Layer: Web settings tests
// Exports: Vitest suites for appSettings.ts

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { codexAccountInstanceId } from "@t3tools/shared/providerInstances";

import {
  AppSettingsSchema,
  DEFAULT_CHAT_FONT_SIZE_PX,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_TERMINAL_FONT_SIZE_PX,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  DEFAULT_TIMESTAMP_FORMAT,
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
  getProviderStartOptions,
  mergeProviderInstanceConfigPatch,
  MODEL_PROVIDER_SETTINGS,
  normalizeChatFontSizePx,
  normalizeCustomModelSlugs,
  normalizeStoredAppSettings,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSizePx,
  patchCustomModels,
  patchCustomModelsForProviderInstance,
  resolveAppModelSelection,
  resolveSelectableProviderInstanceId,
  resolveTerminalFontFamilyStack,
} from "./appSettings";

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

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
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
  it("merges Codex, Claude, and OpenCode model options for git writing settings", () => {
    const options = getGitTextGenerationModelOptions({
      customCodexModels: ["custom/codex-model"],
      customClaudeModels: ["claude/custom-opus"],
      customKiloModels: [],
      customOpenCodeModels: ["openrouter/gpt-oss-120b"],
      textGenerationModel: "openai/gpt-5",
      textGenerationProvider: "opencode",
    });

    expect(options.some((option) => option.slug === "gpt-5.4-mini")).toBe(true);
    expect(options.some((option) => option.slug === "claude/custom-opus")).toBe(true);
    expect(options.some((option) => option.slug === "openai/gpt-5")).toBe(true);
    expect(options.some((option) => option.slug === "openrouter/gpt-oss-120b")).toBe(true);
  });

  it("preserves a currently selected transient git writing model", () => {
    const options = getGitTextGenerationModelOptions({
      customCodexModels: [],
      customClaudeModels: [],
      customKiloModels: [],
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
      customClaudeModels: [],
      customKiloModels: [],
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
});

describe("getGitTextGenerationPickerOptions", () => {
  it("builds git-writing model options from each provider instance custom model list", () => {
    const options = getGitTextGenerationPickerOptions({
      customCodexModels: ["custom/default-codex"],
      customClaudeModels: [],
      customCursorModels: [],
      customGeminiModels: [],
      customGrokModels: [],
      customKiloModels: [],
      customOpenCodeModels: [],
      customPiModels: [],
      codexAccounts: [],
      codexHomePath: "",
      selectedCodexAccountId: "default",
      textGenerationModel: "custom/work-codex",
      textGenerationProvider: "codex",
      textGenerationProviderInstanceId: "codex_work",
      providerInstances: {
        codex_work: {
          driver: "codex",
          enabled: true,
          config: {
            customModels: ["custom/work-codex"],
          },
        },
      },
    });

    const defaultModels = options
      .filter((entry) => entry.instance.instanceId === "codex")
      .map((entry) => entry.option.slug);
    const workModels = options
      .filter((entry) => entry.instance.instanceId === "codex_work")
      .map((entry) => entry.option.slug);

    expect(defaultModels).toContain("custom/default-codex");
    expect(defaultModels).not.toContain("custom/work-codex");
    expect(workModels).toContain("custom/work-codex");
    expect(workModels).not.toContain("custom/default-codex");
  });

  it("includes Claude provider instances in git-writing model options", () => {
    const options = getGitTextGenerationPickerOptions({
      customCodexModels: [],
      customClaudeModels: ["claude/default-opus"],
      customCursorModels: [],
      customGeminiModels: [],
      customGrokModels: [],
      customKiloModels: [],
      customOpenCodeModels: [],
      customPiModels: [],
      codexAccounts: [],
      codexHomePath: "",
      selectedCodexAccountId: "default",
      textGenerationModel: "claude/work-opus",
      textGenerationProvider: "claudeAgent",
      textGenerationProviderInstanceId: "claude_work",
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          enabled: true,
          displayName: "Claude Work",
          config: {
            customModels: ["claude/work-opus"],
          },
        },
      },
    });

    const defaultClaudeModels = options
      .filter((entry) => entry.instance.instanceId === "claudeAgent")
      .map((entry) => entry.option.slug);
    const workClaudeModels = options
      .filter((entry) => entry.instance.instanceId === "claude_work")
      .map((entry) => entry.option.slug);

    expect(defaultClaudeModels).toContain("claude/default-opus");
    expect(defaultClaudeModels).not.toContain("claude/work-opus");
    expect(workClaudeModels).toContain("claude/work-opus");
    expect(workClaudeModels).not.toContain("claude/default-opus");
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
          gemini: [],
          grok: [],
          kilo: [],
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
          gemini: [],
          grok: [],
          kilo: [],
          opencode: [],
          pi: [],
        },
        "",
      ),
    ).toBe("gpt-5.5");
  });

  it("resolves display names through the shared resolver", () => {
    expect(
      resolveAppModelSelection(
        "codex",
        {
          codex: [],
          claudeAgent: [],
          cursor: [],
          gemini: [],
          grok: [],
          kilo: [],
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
          gemini: [],
          grok: [],
          kilo: [],
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
          gemini: [],
          grok: [],
          kilo: [],
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

  it("drops default provider command names so they do not look like custom paths", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(
      JSON.stringify({
        claudeBinaryPath: "claude",
        codexBinaryPath: "codex",
        cursorBinaryPath: "cursor-agent",
        geminiBinaryPath: "gemini",
        grokBinaryPath: "grok",
        kiloBinaryPath: "kilo",
        openCodeBinaryPath: "opencode",
        piBinaryPath: "pi",
      }),
    );
    const normalized = normalizeStoredAppSettings(decodedSettings);

    expect(normalized).toMatchObject({
      claudeBinaryPath: "",
      codexBinaryPath: "",
      cursorBinaryPath: "",
      geminiBinaryPath: "",
      grokBinaryPath: "",
      kiloBinaryPath: "",
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

  it("normalizes settings-backed model favourites by provider instance", () => {
    const decodedSettings = Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(
      JSON.stringify({
        favorites: [
          { provider: "claude_work", model: " claude-sonnet-4-6 " },
          { provider: "claude_work", model: "claude-sonnet-4-6" },
          { provider: "codex", model: "gpt-5" },
        ],
      }),
    );

    expect(normalizeStoredAppSettings(decodedSettings).favorites).toEqual([
      { provider: "claude_work", model: "claude-sonnet-4-6" },
      { provider: "codex", model: "gpt-5" },
    ]);
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
        geminiBinaryPath: "/usr/local/bin/gemini",
        grokBinaryPath: "/usr/local/bin/grok",
        kiloBinaryPath: "",
        kiloServerPassword: "",
        kiloServerUrl: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerPassword: "",
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "",
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
      gemini: {
        binaryPath: "/usr/local/bin/gemini",
      },
      grok: {
        binaryPath: "/usr/local/bin/grok",
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
        geminiBinaryPath: "",
        grokBinaryPath: "",
        kiloBinaryPath: "",
        kiloServerPassword: "",
        kiloServerUrl: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerPassword: "",
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "",
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
        geminiBinaryPath: "",
        grokBinaryPath: "",
        kiloBinaryPath: "",
        kiloServerPassword: "",
        kiloServerUrl: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerPassword: "",
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
          geminiBinaryPath: "",
          grokBinaryPath: "",
          kiloBinaryPath: "",
          kiloServerPassword: "",
          kiloServerUrl: "",
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
          geminiBinaryPath: "",
          grokBinaryPath: "",
          kiloBinaryPath: "",
          kiloServerPassword: "",
          kiloServerUrl: "",
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
          geminiBinaryPath: "",
          grokBinaryPath: "",
          kiloBinaryPath: "",
          kiloServerPassword: "",
          kiloServerUrl: "",
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

  it("builds custom Codex instance options without selected-account fallbacks", () => {
    expect(
      getProviderStartOptions(
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
          geminiBinaryPath: "",
          grokBinaryPath: "",
          kiloBinaryPath: "",
          kiloServerPassword: "",
          kiloServerUrl: "",
          openCodeBinaryPath: "",
          openCodeExperimentalWebSockets: false,
          openCodeServerPassword: "",
          openCodeServerUrl: "",
          piAgentDir: "",
          piBinaryPath: "",
          providerInstances: {
            codex_work: {
              driver: "codex",
              displayName: "Codex Work",
              enabled: true,
              config: {
                homePath: "/Users/work/.codex",
              },
            },
          },
        },
        "codex_work",
      ),
    ).toEqual({
      codex: {
        homePath: "/Users/work/.codex",
      },
    });
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
        geminiBinaryPath: "",
        grokBinaryPath: "",
        kiloBinaryPath: "",
        kiloServerPassword: "",
        kiloServerUrl: "",
        openCodeBinaryPath: "",
        openCodeExperimentalWebSockets: false,
        openCodeServerPassword: "",
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
        geminiBinaryPath: "gemini",
        grokBinaryPath: "grok",
        kiloBinaryPath: "kilo",
        kiloServerPassword: "",
        kiloServerUrl: "",
        openCodeBinaryPath: "opencode",
        openCodeExperimentalWebSockets: false,
        openCodeServerPassword: "",
        openCodeServerUrl: "",
        piAgentDir: "",
        piBinaryPath: "pi",
      }),
    ).toBeUndefined();
  });
});

describe("getCustomBinaryPathForProviderInstance", () => {
  const baseSettings = {
    claudeBinaryPath: "/legacy/bin/claude",
    codexBinaryPath: "",
    codexHomePath: "",
    codexAccounts: [],
    selectedCodexAccountId: "default",
    cursorApiEndpoint: "",
    cursorBinaryPath: "",
    geminiBinaryPath: "",
    grokBinaryPath: "",
    kiloBinaryPath: "",
    kiloServerPassword: "",
    kiloServerUrl: "",
    openCodeBinaryPath: "",
    openCodeExperimentalWebSockets: false,
    openCodeServerPassword: "",
    openCodeServerUrl: "",
    piAgentDir: "",
    piBinaryPath: "",
  } as const;

  it("uses the legacy provider path for the default provider instance", () => {
    expect(
      getCustomBinaryPathForProviderInstance(
        { ...baseSettings, providerInstances: {} },
        "claudeAgent",
        "claudeAgent",
      ),
    ).toBe("/legacy/bin/claude");
  });

  it("uses the exact provider instance overlay path", () => {
    expect(
      getCustomBinaryPathForProviderInstance(
        {
          ...baseSettings,
          providerInstances: {
            claude_work: {
              driver: "claudeAgent",
              enabled: true,
              config: { binaryPath: "/work/bin/claude" },
            },
          },
        },
        "claudeAgent",
        "claude_work",
      ),
    ).toBe("/work/bin/claude");
  });

  it("does not leak the provider-wide path into a custom provider instance", () => {
    expect(
      getCustomBinaryPathForProviderInstance(
        {
          ...baseSettings,
          providerInstances: {
            claude_personal: {
              driver: "claudeAgent",
              enabled: true,
              config: {},
            },
          },
        },
        "claudeAgent",
        "claude_personal",
      ),
    ).toBe("");
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

  it("keeps unsupported provider instances visible for missing-driver affordances", () => {
    expect(
      getUnsupportedProviderInstanceOptions({
        providerInstances: {
          fork_work: {
            driver: "customFork",
            displayName: "Fork Work",
            enabled: true,
            config: {},
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

describe("resolveSelectableProviderInstanceId", () => {
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
    customGeminiModels: ["gemini/custom-flash"],
    customGrokModels: ["grok/custom-fast"],
    customKiloModels: ["kilo/kilo-auto/free"],
    customOpenCodeModels: ["openrouter/gpt-oss-120b"],
    customPiModels: ["anthropic/custom-pi"],
  } as const;

  it("exports one provider config per provider", () => {
    expect(MODEL_PROVIDER_SETTINGS.map((config) => config.provider)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
    ]);
  });

  it("reads custom models for each provider", () => {
    expect(getCustomModelsForProvider(settings, "codex")).toEqual(["custom/codex-model"]);
    expect(getCustomModelsForProvider(settings, "claudeAgent")).toEqual(["claude/custom-opus"]);
    expect(getCustomModelsForProvider(settings, "cursor")).toEqual(["cursor/custom-model"]);
    expect(getCustomModelsForProvider(settings, "gemini")).toEqual(["gemini/custom-flash"]);
    expect(getCustomModelsForProvider(settings, "grok")).toEqual(["grok/custom-fast"]);
    expect(getCustomModelsForProvider(settings, "kilo")).toEqual(["kilo/kilo-auto/free"]);
    expect(getCustomModelsForProvider(settings, "opencode")).toEqual(["openrouter/gpt-oss-120b"]);
    expect(getCustomModelsForProvider(settings, "pi")).toEqual(["anthropic/custom-pi"]);
  });

  it("reads default custom models for each provider", () => {
    const defaults = {
      customCodexModels: ["default/codex-model"],
      customClaudeModels: ["claude/default-opus"],
      customCursorModels: ["cursor/default-model"],
      customGeminiModels: ["gemini/default-flash"],
      customGrokModels: ["grok/default-fast"],
      customKiloModels: ["kilo/default-auto"],
      customOpenCodeModels: ["openai/gpt-5"],
      customPiModels: ["anthropic/default-pi"],
    } as const;

    expect(getDefaultCustomModelsForProvider(defaults, "codex")).toEqual(["default/codex-model"]);
    expect(getDefaultCustomModelsForProvider(defaults, "claudeAgent")).toEqual([
      "claude/default-opus",
    ]);
    expect(getDefaultCustomModelsForProvider(defaults, "cursor")).toEqual(["cursor/default-model"]);
    expect(getDefaultCustomModelsForProvider(defaults, "gemini")).toEqual(["gemini/default-flash"]);
    expect(getDefaultCustomModelsForProvider(defaults, "grok")).toEqual(["grok/default-fast"]);
    expect(getDefaultCustomModelsForProvider(defaults, "kilo")).toEqual(["kilo/default-auto"]);
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

  it("patches custom models for gemini", () => {
    expect(patchCustomModels("gemini", ["gemini/custom-flash"])).toEqual({
      customGeminiModels: ["gemini/custom-flash"],
    });
  });

  it("patches custom models for grok", () => {
    expect(patchCustomModels("grok", ["grok/custom-fast"])).toEqual({
      customGrokModels: ["grok/custom-fast"],
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

  it("patches custom models for kilo", () => {
    expect(patchCustomModels("kilo", ["kilo/kilo-auto/free"])).toEqual({
      customKiloModels: ["kilo/kilo-auto/free"],
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
      codexAccounts: [],
      codexHomePath: "",
      selectedCodexAccountId: "default",
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
      gemini: ["gemini/custom-flash"],
      grok: ["grok/custom-fast"],
      kilo: ["kilo/kilo-auto/free"],
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
      modelOptionsByProvider.gemini.some((option) => option.slug === "gemini/custom-flash"),
    ).toBe(true);
    expect(modelOptionsByProvider.grok.some((option) => option.slug === "grok/custom-fast")).toBe(
      true,
    );
    expect(
      modelOptionsByProvider.kilo.some((option) => option.slug === "kilo/kilo-auto/free"),
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
      customGeminiModels: [" auto-gemini-3 ", "gemini/custom-flash", "gemini/custom-flash"],
      customGrokModels: [" grok-build ", "grok/custom-fast", "grok/custom-fast"],
      customKiloModels: [" kilo/kilo-auto/free ", "kilo/kilo-auto/free"],
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
      modelOptionsByProvider.gemini.filter((option) => option.slug === "gemini/custom-flash"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.cursor.filter((option) => option.slug === "cursor/custom-model"),
    ).toHaveLength(1);
    expect(modelOptionsByProvider.gemini.some((option) => option.slug === "auto-gemini-3")).toBe(
      true,
    );
    expect(
      modelOptionsByProvider.grok.filter((option) => option.slug === "grok/custom-fast"),
    ).toHaveLength(1);
    expect(modelOptionsByProvider.grok.some((option) => option.slug === "grok-build-0.1")).toBe(
      true,
    );
    expect(modelOptionsByProvider.grok.some((option) => option.slug === "grok-build")).toBe(true);
    expect(
      modelOptionsByProvider.kilo.filter((option) => option.slug === "kilo/kilo-auto/free"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.opencode.filter((option) => option.slug === "openrouter/gpt-oss-120b"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.pi.filter((option) => option.slug === "anthropic/custom-pi"),
    ).toHaveLength(1);
  });

  it("reads custom models from the selected provider instance without leaking provider buckets", () => {
    const modelSettings = {
      ...settings,
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
  });
});

describe("AppSettingsSchema", () => {
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
      geminiBinaryPath: "",
      grokBinaryPath: "",
      defaultThreadEnvMode: "local",
      confirmThreadDelete: false,
      confirmTerminalTabClose: true,
      enableAssistantStreaming: true,
      sidebarProjectSortOrder: DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
      sidebarThreadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
      timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
      customCodexModels: [],
      customClaudeModels: [],
      customCursorModels: [],
      customGeminiModels: [],
      customGrokModels: [],
      customKiloModels: [],
      customOpenCodeModels: [],
      customPiModels: [],
    });
  });
});
