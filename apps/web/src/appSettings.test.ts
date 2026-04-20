import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AppSettingsSchema,
  DEFAULT_CHAT_FONT_SIZE_PX,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  DEFAULT_TIMESTAMP_FORMAT,
  getAppModelOptions,
  getCustomModelOptionsByProvider,
  getCustomModelsByProvider,
  getCustomModelsForProvider,
  getDefaultCustomModelsForProvider,
  getProviderStartOptions,
  MODEL_PROVIDER_SETTINGS,
  normalizeChatFontSizePx,
  normalizeCustomModelSlugs,
  patchCustomModels,
  resolveAppModelSelection,
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
      isCustom: true,
    });
  });

  it("formats unknown GPT custom models with a readable label", () => {
    const options = getAppModelOptions("codex", ["gpt-5.1-codex-max"]);

    expect(options.at(-1)).toEqual({
      slug: "gpt-5.1-codex-max",
      name: "GPT-5.1 Codex Max",
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

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(
      resolveAppModelSelection(
        "codex",
        { codex: ["galapagos-alpha"], claudeAgent: [], gemini: [] },
        "galapagos-alpha",
      ),
    ).toBe("galapagos-alpha");
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", { codex: [], claudeAgent: [], gemini: [] }, "")).toBe(
      "gpt-5.4",
    );
  });

  it("resolves display names through the shared resolver", () => {
    expect(
      resolveAppModelSelection(
        "codex",
        { codex: [], claudeAgent: [], gemini: [] },
        "GPT-5.3 Codex",
      ),
    ).toBe("gpt-5.3-codex");
  });

  it("resolves aliases through the shared resolver", () => {
    expect(
      resolveAppModelSelection("claudeAgent", { codex: [], claudeAgent: [], gemini: [] }, "sonnet"),
    ).toBe("claude-sonnet-4-6");
  });

  it("resolves transient selected custom models included in app model options", () => {
    expect(
      resolveAppModelSelection(
        "codex",
        { codex: [], claudeAgent: [], gemini: [] },
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

describe("sidebar sort defaults", () => {
  it("defaults project sorting to updated_at", () => {
    expect(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER).toBe("updated_at");
  });

  it("defaults thread sorting to updated_at", () => {
    expect(DEFAULT_SIDEBAR_THREAD_SORT_ORDER).toBe("updated_at");
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
        geminiBinaryPath: "/usr/local/bin/gemini",
      }),
    ).toEqual({
      claudeAgent: {
        binaryPath: "/usr/local/bin/claude",
      },
      codex: {
        homePath: "/Users/you/.codex",
      },
      gemini: {
        binaryPath: "/usr/local/bin/gemini",
      },
    });
  });

  it("returns undefined when no provider overrides are configured", () => {
    expect(
      getProviderStartOptions({
        claudeBinaryPath: "",
        codexBinaryPath: "",
        codexHomePath: "",
        geminiBinaryPath: "",
      }),
    ).toBeUndefined();
  });
});

describe("provider-indexed custom model settings", () => {
  const settings = {
    customCodexModels: ["custom/codex-model"],
    customClaudeModels: ["claude/custom-opus"],
    customGeminiModels: ["gemini/custom-flash"],
  } as const;

  it("exports one provider config per provider", () => {
    expect(MODEL_PROVIDER_SETTINGS.map((config) => config.provider)).toEqual([
      "codex",
      "claudeAgent",
      "gemini",
    ]);
  });

  it("reads custom models for each provider", () => {
    expect(getCustomModelsForProvider(settings, "codex")).toEqual(["custom/codex-model"]);
    expect(getCustomModelsForProvider(settings, "claudeAgent")).toEqual(["claude/custom-opus"]);
    expect(getCustomModelsForProvider(settings, "gemini")).toEqual(["gemini/custom-flash"]);
  });

  it("reads default custom models for each provider", () => {
    const defaults = {
      customCodexModels: ["default/codex-model"],
      customClaudeModels: ["claude/default-opus"],
      customGeminiModels: ["gemini/default-flash"],
    } as const;

    expect(getDefaultCustomModelsForProvider(defaults, "codex")).toEqual(["default/codex-model"]);
    expect(getDefaultCustomModelsForProvider(defaults, "claudeAgent")).toEqual([
      "claude/default-opus",
    ]);
    expect(getDefaultCustomModelsForProvider(defaults, "gemini")).toEqual(["gemini/default-flash"]);
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

  it("builds a complete provider-indexed custom model record", () => {
    expect(getCustomModelsByProvider(settings)).toEqual({
      codex: ["custom/codex-model"],
      claudeAgent: ["claude/custom-opus"],
      gemini: ["gemini/custom-flash"],
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
      modelOptionsByProvider.gemini.some((option) => option.slug === "gemini/custom-flash"),
    ).toBe(true);
  });

  it("normalizes and deduplicates custom model options per provider", () => {
    const modelOptionsByProvider = getCustomModelOptionsByProvider({
      customCodexModels: ["  custom/codex-model ", "gpt-5.4", "custom/codex-model"],
      customClaudeModels: [" sonnet ", "claude/custom-opus", "claude/custom-opus"],
      customGeminiModels: [" auto-gemini-3 ", "gemini/custom-flash", "gemini/custom-flash"],
    });

    expect(
      modelOptionsByProvider.codex.filter((option) => option.slug === "custom/codex-model"),
    ).toHaveLength(1);
    expect(modelOptionsByProvider.codex.some((option) => option.slug === "gpt-5.4")).toBe(true);
    expect(
      modelOptionsByProvider.claudeAgent.filter((option) => option.slug === "claude/custom-opus"),
    ).toHaveLength(1);
    expect(
      modelOptionsByProvider.claudeAgent.some((option) => option.slug === "claude-sonnet-4-6"),
    ).toBe(true);
    expect(
      modelOptionsByProvider.gemini.filter((option) => option.slug === "gemini/custom-flash"),
    ).toHaveLength(1);
    expect(modelOptionsByProvider.gemini.some((option) => option.slug === "auto-gemini-3")).toBe(
      true,
    );
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
      chatFontSizePx: DEFAULT_CHAT_FONT_SIZE_PX,
      codexBinaryPath: "/usr/local/bin/codex",
      codexHomePath: "",
      geminiBinaryPath: "",
      defaultThreadEnvMode: "local",
      confirmThreadDelete: false,
      confirmTerminalTabClose: true,
      enableAssistantStreaming: false,
      sidebarProjectSortOrder: DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
      sidebarThreadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
      timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
      customCodexModels: [],
      customClaudeModels: [],
      customGeminiModels: [],
    });
  });
});
