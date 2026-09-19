// FILE: theme.logic.test.ts
// Purpose: Locks down Codex-style theme parsing, normalization, and CSS token derivation.
// Layer: Web appearance domain tests
// Exports: Vitest coverage for theme.logic.

import { describe, expect, it } from "vitest";
import {
  CODE_THEME_OPTIONS,
  DEFAULT_CHROME_THEME_BY_VARIANT,
  DEFAULT_THEME_STATE,
  areThemePacksEqual,
  updateChromeTheme,
  resetThemeVariant,
  serializeThemeState,
  buildResolvedThemeTokens,
  buildThemeCssVariables,
  canParseThemeShareString,
  createThemeShareString,
  getCodeThemeSeed,
  getCodeThemeSeedPatch,
  normalizeThemeState,
  parseStoredThemeState,
  parseThemeShareString,
  parseThemeShareStringForVariant,
  resolveThemePack,
  setThemeCodeThemeId,
  updateThemePackFromShareString,
} from "./theme.logic";
import { DEFAULT_MONOSPACE_FONT_FAMILY_STACK } from "../lib/fontFamily";

const PROVIDED_THEME_STRING =
  'codex-theme-v1:{"codeThemeId":"linear","theme":{"accent":"#606acc","contrast":30,"fonts":{"code":"\\"Jetbrains Mono\\"","ui":"Inter"},"ink":"#e3e4e6","opaqueWindows":true,"semanticColors":{"diffAdded":"#69c967","diffRemoved":"#ff7e78","skill":"#c2a1ff"},"surface":"#0f0f11"},"variant":"dark"}';

describe("parseStoredThemeState", () => {
  it("migrates the legacy mode-only value into the new theme store", () => {
    expect(parseStoredThemeState("dark")).toEqual({
      ...DEFAULT_THEME_STATE,
      mode: "dark",
    });
  });

  it("normalizes partial stored packs against the per-variant defaults", () => {
    expect(
      normalizeThemeState({
        mode: "light",
        codeThemeIds: {
          dark: "linear",
        },
        chromeThemes: {
          dark: {
            accent: "#606acc",
          },
        },
      }),
    ).toMatchObject({
      chromeThemes: {
        dark: {
          accent: "#606acc",
          contrast: 0,
        },
        light: DEFAULT_THEME_STATE.chromeThemes.light,
      },
      codeThemeIds: {
        dark: "linear",
        light: DEFAULT_THEME_STATE.codeThemeIds.light,
      },
      mode: "light",
    });
  });

  it("migrates the legacy packs shape into split codeThemeId and chromeTheme stores", () => {
    const migrated = normalizeThemeState({
      mode: "dark",
      packs: {
        dark: {
          codeThemeId: "linear",
          theme: {
            accent: "#606acc",
          },
        },
      },
    });

    expect(migrated.mode).toBe("dark");
    expect(migrated.codeThemeIds.dark).toBe("linear");
    expect(migrated.chromeThemes.dark.accent).toBe("#606acc");
  });

  it("preserves a custom UI font when migrating a stored state without the system-font flag", () => {
    const migrated = normalizeThemeState({
      chromeThemes: {
        dark: {
          fonts: { ui: "Inter" },
        },
      },
    });

    expect(migrated.systemUiFont).toBe(false);
    expect(migrated.chromeThemes.dark.fonts.ui).toBe("Inter");
  });

  it("uses the system UI font for older states that did not store a custom font", () => {
    expect(normalizeThemeState({ mode: "dark" }).systemUiFont).toBe(true);
  });

  it("keeps an explicit system-font preference even when the theme stores a UI font", () => {
    expect(
      normalizeThemeState({
        chromeThemes: {
          dark: {
            fonts: { ui: "Inter" },
          },
        },
        systemUiFont: true,
      }).systemUiFont,
    ).toBe(true);
  });
});

describe("theme share strings", () => {
  it("round-trips a normalized pack through the share-string format", () => {
    const shareString = createThemeShareString(
      "dark",
      resolveThemePack(DEFAULT_THEME_STATE, "dark"),
    );

    expect(parseThemeShareString(shareString)).toEqual({
      codeThemeId: "codex",
      theme: resolveThemePack(DEFAULT_THEME_STATE, "dark").theme,
      variant: "dark",
    });
  });

  it("parses the provided dark Linear theme and preserves its normalized values", () => {
    expect(parseThemeShareString(PROVIDED_THEME_STRING)).toEqual({
      codeThemeId: "linear",
      theme: {
        accent: "#606acc",
        contrast: 30,
        fonts: {
          code: '"Jetbrains Mono"',
          ui: "Inter",
        },
        ink: "#e3e4e6",
        opaqueWindows: true,
        semanticColors: {
          diffAdded: "#69c967",
          diffRemoved: "#ff7e78",
          skill: "#c2a1ff",
        },
        surface: "#0f0f11",
      },
      variant: "dark",
    });
  });

  it("rejects a share string whose variant does not match the target editor variant", () => {
    expect(() => parseThemeShareStringForVariant(PROVIDED_THEME_STRING, "light")).toThrow(
      /variant mismatch/i,
    );
  });

  it("rejects malformed percent-encoding with the designed parse error", () => {
    expect(() => parseThemeShareString("codex-theme-v1:%zz")).toThrow(
      /does not contain valid JSON/i,
    );
    expect(canParseThemeShareString("codex-theme-v1:%zz")).toBe(false);
  });

  it("parses a percent-encoded payload", () => {
    const encoded = `codex-theme-v1:${encodeURIComponent(
      PROVIDED_THEME_STRING.slice("codex-theme-v1:".length),
    )}`;
    expect(parseThemeShareString(encoded)).toEqual(parseThemeShareString(PROVIDED_THEME_STRING));
  });

  it("rejects non-JSON and schema-invalid payloads with designed errors", () => {
    expect(() => parseThemeShareString("codex-theme-v1:notjson")).toThrow(
      /does not contain valid JSON/i,
    );
    expect(() => parseThemeShareString("codex-theme-v1:{}")).toThrow(/codeThemeId/i);
  });

  it("updates only the matching variant pack when importing", () => {
    const nextState = updateThemePackFromShareString(
      DEFAULT_THEME_STATE,
      PROVIDED_THEME_STRING,
      "dark",
    );

    expect(nextState.codeThemeIds.dark).toBe("linear");
    expect(nextState.chromeThemes.light).toEqual(DEFAULT_THEME_STATE.chromeThemes.light);
  });
});

describe("code theme seeds", () => {
  it("starts every bundled theme variant at zero contrast", () => {
    for (const option of CODE_THEME_OPTIONS) {
      for (const variant of option.variants) {
        expect(getCodeThemeSeed(option.id, variant).contrast).toBe(0);
      }
    }
  });

  it("loads the exact normalized seed for a bundled code theme", () => {
    expect(getCodeThemeSeed("linear", "dark")).toEqual({
      accent: "#606acc",
      contrast: 0,
      fonts: {
        code: null,
        ui: "Inter",
      },
      ink: "#e3e4e6",
      opaqueWindows: true,
      semanticColors: {
        diffAdded: "#69c967",
        diffRemoved: "#ff7e78",
        skill: "#c2a1ff",
      },
      surface: "#0f0f11",
    });
  });

  it("exposes only the raw seed fields that Codex merges on theme switching", () => {
    expect(getCodeThemeSeedPatch("linear", "dark")).toEqual({
      accent: "#606acc",
      fonts: {
        ui: "Inter",
      },
      ink: "#e3e4e6",
      opaqueWindows: true,
      semanticColors: {
        diffAdded: "#69c967",
        diffRemoved: "#ff7e78",
        skill: "#c2a1ff",
      },
      surface: "#0f0f11",
    });
  });

  it("merges the selected theme seed into the current pack instead of hard-resetting", () => {
    const nextState = setThemeCodeThemeId(
      {
        ...DEFAULT_THEME_STATE,
        chromeThemes: {
          ...DEFAULT_THEME_STATE.chromeThemes,
          dark: {
            ...DEFAULT_THEME_STATE.chromeThemes.dark,
            fonts: {
              code: '"JetBrains Mono"',
              ui: "Old UI",
            },
            accent: "#ff00aa",
            contrast: 12,
            opaqueWindows: false,
          },
        },
      },
      "dark",
      "linear",
    );

    expect(resolveThemePack(nextState, "dark")).toEqual({
      codeThemeId: "linear",
      theme: {
        accent: "#606acc",
        contrast: 12,
        fonts: {
          code: '"JetBrains Mono"',
          ui: "Inter",
        },
        ink: "#e3e4e6",
        opaqueWindows: true,
        semanticColors: {
          diffAdded: "#69c967",
          diffRemoved: "#ff7e78",
          skill: "#c2a1ff",
        },
        surface: "#0f0f11",
      },
    });
  });

  it("preserves current optional values when the new seed does not define them", () => {
    const nextState = setThemeCodeThemeId(
      {
        ...DEFAULT_THEME_STATE,
        chromeThemes: {
          ...DEFAULT_THEME_STATE.chromeThemes,
          dark: {
            ...DEFAULT_THEME_STATE.chromeThemes.dark,
            fonts: {
              code: '"JetBrains Mono"',
              ui: "Current UI",
            },
            contrast: 22,
            opaqueWindows: true,
          },
        },
      },
      "dark",
      "lobster",
    );

    expect(resolveThemePack(nextState, "dark")).toEqual({
      codeThemeId: "lobster",
      theme: {
        ...DEFAULT_THEME_STATE.chromeThemes.dark,
        accent: getCodeThemeSeed("lobster", "dark").accent,
        contrast: 22,
        fonts: {
          code: '"JetBrains Mono"',
          ui: "Satoshi",
        },
        ink: getCodeThemeSeed("lobster", "dark").ink,
        opaqueWindows: true,
        semanticColors: getCodeThemeSeed("lobster", "dark").semanticColors,
        surface: getCodeThemeSeed("lobster", "dark").surface,
      },
    });
  });

  it("applies explicit contrast overrides when a seed defines them", () => {
    const nextState = setThemeCodeThemeId(
      {
        ...DEFAULT_THEME_STATE,
        chromeThemes: {
          ...DEFAULT_THEME_STATE.chromeThemes,
          dark: {
            ...DEFAULT_THEME_STATE.chromeThemes.dark,
            contrast: 12,
          },
        },
      },
      "dark",
      "vercel",
    );

    expect(resolveThemePack(nextState, "dark")).toEqual({
      codeThemeId: "vercel",
      theme: getCodeThemeSeed("vercel", "dark"),
    });
  });
});

describe("buildThemeCssVariables", () => {
  it.each([
    { electron: true, isMac: false },
    { electron: true, isMac: true },
    { electron: false, isMac: false },
  ])("projects distinct Vercel and Codex light colors on %j", (platform) => {
    const state = setThemeCodeThemeId(DEFAULT_THEME_STATE, "light", "vercel");
    const vercel = buildThemeCssVariables(resolveThemePack(state, "light"), "light", platform);
    const codex = buildThemeCssVariables(
      resolveThemePack(DEFAULT_THEME_STATE, "light"),
      "light",
      platform,
    );
    expect(vercel.variables["--codex-base-accent"]).toBe("#006aff");
    expect(codex.variables["--codex-base-accent"]).toBe("#0169cc");
    expect(vercel.variables["--color-text-foreground"]).toBe("#171717");
    expect(codex.variables["--color-text-foreground"]).toBe("#0d0d0d");
    // These two presets intentionally share a white surface in light mode.
    expect(vercel.variables["--codex-base-surface"]).toBe(codex.variables["--codex-base-surface"]);
    // Editing a slot must not change the user's system-mode or other-slot choices.
    expect(state.mode).toBe("system");
    expect(state.chromeThemes.dark).toEqual(DEFAULT_THEME_STATE.chromeThemes.dark);
  });

  it("derives the renderer token map from the imported theme pack", () => {
    const importedTheme = parseThemeShareString(PROVIDED_THEME_STRING);
    const cssVariables = buildThemeCssVariables(
      {
        codeThemeId: importedTheme.codeThemeId,
        theme: importedTheme.theme,
      },
      importedTheme.variant,
      { electron: true },
    );

    expect(cssVariables.material).toBe("opaque");
    expect(cssVariables.variables["--codex-base-accent"]).toBe("#606acc");
    expect(cssVariables.variables["--background"]).toBe("#0d0d0f");
    expect(cssVariables.variables["--card"]).toBe("#151517");
    expect(cssVariables.variables["--composer-surface"]).toBe("rgb(27, 27, 29)");
    expect(cssVariables.variables["--composer-surface"]).not.toBe(cssVariables.variables["--card"]);
    expect(cssVariables.variables["--sidebar-accent"]).toBe("rgba(227, 228, 230, 0.058)");
    expect(cssVariables.variables["--sidebar-accent-active"]).toBe("rgba(227, 228, 230, 0.058)");
    expect(cssVariables.variables["--sidebar-selected"]).toBe(
      cssVariables.variables["--app-user-message-background"],
    );
    expect(cssVariables.variables["--theme-font-ui-family"]).toBe("Inter");
    expect(cssVariables.variables["--theme-font-code-family"]).toBe(
      `"Jetbrains Mono", ${DEFAULT_MONOSPACE_FONT_FAMILY_STACK}`,
    );
    expect(cssVariables.variables["--vscode-terminal-ansiBlue"]).toBe("#606acc");
    expect(cssVariables.variables["--vscode-terminal-ansiGreen"]).toBe("#56a554");
    expect(cssVariables.variables["--vscode-terminal-ansiMagenta"]).toBe("#c2a1ff");
    expect(cssVariables.variables["--vscode-terminal-ansiRed"]).toBe("#ff7e78");
    expect(cssVariables.variables["--vscode-terminal-foreground"]).toBe("#e3e4e6");
    expect(cssVariables.variables["--color-token-terminal-ansi-blue"]).toBe("#606acc");
    expect(cssVariables.variables["--color-token-terminal-ansi-green"]).toBe("#56a554");
    expect(cssVariables.variables["--color-token-terminal-ansi-magenta"]).toBe("#c2a1ff");
    expect(cssVariables.variables["--color-token-terminal-ansi-red"]).toBe("#ff7e78");
  });

  it("exposes a structured derived-token surface for retrieving non-stored colors", () => {
    const importedTheme = parseThemeShareString(PROVIDED_THEME_STRING);
    const tokens = buildResolvedThemeTokens(
      {
        codeThemeId: importedTheme.codeThemeId,
        theme: importedTheme.theme,
      },
      importedTheme.variant,
    );

    expect(tokens.computed.surfaceUnder).toBe("#0d0d0f");
    expect(tokens.computed.panel).toBe("#151517");
    expect(tokens.derived.textForegroundSecondary).toBe("rgba(227, 228, 230, 0.645)");
    expect(tokens.derived.buttonSecondaryBackground).toBe("rgba(227, 228, 230, 0.039)");
    expect(tokens.derived.iconAccent).toBe("rgb(143, 150, 219)");
    // Dark primary button label is the surface color (dark) on the white (ink) button.
    expect(tokens.derived.textButtonPrimary).toBe("#0f0f11");
    expect(tokens.derived.buttonPrimaryBackground).toBe("#e3e4e6");
    // Codex maps the sidebar token to the PRIMARY surface (same as main-surface-primary),
    // not the darker under-surface; mirror that so the sidebar color matches Codex.
    expect(tokens.aliases["--color-token-side-bar-background"]).toBe("#0f0f11");
    expect(tokens.aliases["--color-token-list-hover-background"]).toBe(
      tokens.derived.buttonSecondaryBackgroundHover,
    );
    expect(tokens.aliases["--color-token-dropdown-background"]).toBe(
      tokens.derived.controlBackgroundOpaque,
    );
    expect(tokens.aliases["--color-token-main-surface-primary"]).toBe("#0f0f11");
    expect(tokens.aliases["--color-token-input-background"]).toBe("rgba(27, 27, 29, 0.96)");
    expect(tokens.aliases["--color-token-terminal-background"]).toBe("#0f0f11");
    expect(tokens.aliases["--color-token-terminal-foreground"]).toBe("#e3e4e6");
    expect(tokens.aliases["--color-token-terminal-ansi-black"]).toBe(
      tokens.derived.textForegroundTertiary,
    );
    expect(tokens.aliases["--color-token-terminal-ansi-bright-black"]).toBe(
      tokens.derived.textForegroundSecondary,
    );
    expect(tokens.aliases["--color-token-terminal-ansi-yellow"]).toBe("#f5b44a");
  });

  it("uses the zero-contrast dark composer and dropdown control color", () => {
    const tokens = buildResolvedThemeTokens(
      {
        codeThemeId: "codex",
        theme: DEFAULT_CHROME_THEME_BY_VARIANT.dark,
      },
      "dark",
    );

    expect(tokens.derived.controlBackgroundOpaque).toBe("rgb(30, 30, 30)");
    expect(tokens.aliases["--color-token-dropdown-background"]).toBe("rgb(30, 30, 30)");
  });

  it("matches Codex's light composer surface token path", () => {
    const cssVariables = buildThemeCssVariables(
      {
        codeThemeId: "absolutely",
        theme: getCodeThemeSeed("absolutely", "light"),
      },
      "light",
      { electron: true },
    );

    expect(cssVariables.variables["--composer-surface"]).toBe(
      "color-mix(in oklab, var(--color-background-control) 90%, transparent)",
    );
    expect(cssVariables.variables["--color-background-control"]).toBe("rgba(249, 249, 248, 0.96)");
  });

  it("uses the light-theme foreground color for the primary button background", () => {
    const tokens = buildResolvedThemeTokens(
      {
        codeThemeId: "codex",
        theme: DEFAULT_THEME_STATE.chromeThemes.light,
      },
      "light",
    );

    expect(tokens.derived.buttonPrimaryBackground).toBe(DEFAULT_THEME_STATE.chromeThemes.light.ink);
    expect(tokens.derived.textButtonPrimary).toBe(DEFAULT_THEME_STATE.chromeThemes.light.surface);
    expect(tokens.derived.textButtonPrimary).not.toBe(tokens.derived.buttonPrimaryBackground);
  });

  it("uses the dark-theme foreground color for the primary button background", () => {
    const tokens = buildResolvedThemeTokens(
      {
        codeThemeId: "codex",
        theme: DEFAULT_THEME_STATE.chromeThemes.dark,
      },
      "dark",
    );

    // Dark mode mirrors light mode's high-contrast primary: bg = ink (white),
    // label = surface (dark), so the primary action reads as a filled button.
    expect(tokens.derived.buttonPrimaryBackground).toBe(DEFAULT_THEME_STATE.chromeThemes.dark.ink);
    expect(tokens.derived.textButtonPrimary).toBe(DEFAULT_THEME_STATE.chromeThemes.dark.surface);
    expect(tokens.derived.textButtonPrimary).not.toBe(tokens.derived.buttonPrimaryBackground);
  });

  it("shares the user message bubble background with the chat code-block surface", () => {
    const pack = {
      codeThemeId: "custom-light",
      theme: {
        ...DEFAULT_THEME_STATE.chromeThemes.light,
        ink: "#2d2d2b",
        surface: "#f8f8f6",
      },
    };
    const tokens = buildResolvedThemeTokens(pack, "light");
    const cssVariables = buildThemeCssVariables(pack, "light");

    expect(cssVariables.variables["--app-user-message-background"]).toBe(
      tokens.derived.buttonSecondaryBackground,
    );
    expect(cssVariables.variables["--app-chat-code-surface"]).toBe(
      cssVariables.variables["--app-user-message-background"],
    );
  });
});

describe("chat text colors", () => {
  it("leaves every built-in theme unchanged until a color is customized", () => {
    for (const option of CODE_THEME_OPTIONS) {
      for (const variant of option.variants) {
        const theme = getCodeThemeSeed(option.id, variant);
        const variables = buildThemeCssVariables(
          { codeThemeId: option.id, theme },
          variant,
        ).variables;
        expect(variables["--chat-heading-color"]).toBe("");
        expect(variables["--chat-bold-color"]).toBe("");
      }
    }
  });

  it("persists and shares independent variant colors, then resets to theme colors", () => {
    const state = updateChromeTheme(DEFAULT_THEME_STATE, "light", {
      chatHeadingColor: "#3366CC",
      chatBoldColor: "#aa3377",
    });
    const restored = parseStoredThemeState(serializeThemeState(state));
    const light = resolveThemePack(restored, "light");
    expect(light.theme.chatHeadingColor).toBe("#3366cc");
    expect(light.theme.chatBoldColor).toBe("#aa3377");
    expect(restored.chromeThemes.dark).toEqual(DEFAULT_THEME_STATE.chromeThemes.dark);
    expect(parseThemeShareString(createThemeShareString("light", light)).theme).toEqual(
      light.theme,
    );
    expect(areThemePacksEqual(light, resolveThemePack(DEFAULT_THEME_STATE, "light"))).toBe(false);
    expect(buildThemeCssVariables(light, "light").variables).toMatchObject({
      "--chat-heading-color": "#3366cc",
      "--chat-bold-color": "#aa3377",
    });
    const headingReset = updateChromeTheme(restored, "light", { chatHeadingColor: null });
    expect(
      buildThemeCssVariables(resolveThemePack(headingReset, "light"), "light").variables,
    ).toMatchObject({
      "--chat-heading-color": "",
      "--chat-bold-color": "#aa3377",
    });
    expect(resetThemeVariant(restored, "light")).toEqual(DEFAULT_THEME_STATE);
    expect(
      setThemeCodeThemeId(restored, "light", "github").chromeThemes.light.chatHeadingColor,
    ).toBe("#3366cc");
  });

  it("keeps old themes compatible and rejects invalid colors from imported themes", () => {
    const old = parseThemeShareString(PROVIDED_THEME_STRING);
    expect(old.theme.chatHeadingColor).toBeUndefined();
    const bad = PROVIDED_THEME_STRING.replace(
      '"accent":"#606acc"',
      '"chatHeadingColor":"url(https://example.com)","accent":"#606acc"',
    );
    expect(() => parseThemeShareString(bad)).toThrow("Chat heading color");
    const state = normalizeThemeState({ chromeThemes: { light: { chatBoldColor: "invalid" } } });
    expect(state.chromeThemes.light.chatBoldColor).toBeUndefined();
  });
});
