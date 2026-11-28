// FILE: theme.logic.test.ts
// Purpose: Locks down Codex-style theme parsing, normalization, and CSS token derivation.
// Layer: Web appearance domain tests
// Exports: Vitest coverage for theme.logic.

import { describe, expect, it } from "vitest";
import {
  CODE_THEME_OPTIONS,
  DEFAULT_THEME_STATE,
  buildResolvedThemeTokens,
  buildThemeCssVariables,
  canParseThemeShareString,
  createThemeShareString,
  getCodeThemeSeed,
  type ThemeVariant,
  normalizeThemeState,
  parseStoredThemeState,
  parseThemeShareString,
  parseThemeShareStringForVariant,
  resolveThemePack,
  resolveProfileThemeAccent,
  updateChromeTheme,
  resetThemeVariant,
  setThemeCodeThemeId,
  setWindowTranslucency,
  updateThemePackFromShareString,
} from "./theme.logic";

const PROVIDED_THEME_STRING =
  'codex-theme-v1:{"codeThemeId":"linear","theme":{"accent":"#606acc","contrast":30,"fonts":{"code":"\\"Jetbrains Mono\\"","ui":"Inter"},"ink":"#e3e4e6","opaqueWindows":true,"semanticColors":{"diffAdded":"#69c967","diffRemoved":"#ff7e78","skill":"#c2a1ff"},"surface":"#0f0f11"},"variant":"dark"}';

describe("parseStoredThemeState", () => {
  it.each([null, undefined, ""])("uses Synara for an absent stored theme (%j)", (raw) => {
    const state = parseStoredThemeState(raw);
    expect(state.codeThemeIds).toEqual({ dark: "synara", light: "synara" });
    expect(state.chromeThemes.dark.accent).toBe("#f2612d");
    expect(state.chromeThemes.light.accent).toBe("#c74614");
    expect(state.mode).toBe("system");
  });

  it.each(["dark", "light", "system"] as const)(
    "preserves Codex for a legacy mode-only value (%s)",
    (mode) => {
      for (const raw of [mode, JSON.stringify({ mode })]) {
        const state = parseStoredThemeState(raw);
        expect(state.mode).toBe(mode);
        expect(state.codeThemeIds).toEqual({ dark: "codex", light: "codex" });
        expect(state.chromeThemes.dark.accent).toBe("#0169cc");
        expect(state.chromeThemes.light.accent).toBe("#0169cc");
      }
    },
  );

  it.each(["codex", "linear", "synara"])(
    "preserves saved %s colors and preferences without reapplying the preset",
    (codeThemeId) => {
      const saved = {
        ...DEFAULT_THEME_STATE,
        mode: "dark",
        codeThemeIds: { dark: codeThemeId, light: "codex" },
        chromeThemes: {
          dark: {
            ...getCodeThemeSeed(codeThemeId, "dark"),
            accent: "#6073cc",
            contrast: 22,
            fonts: { code: "Menlo", ui: "Inter" },
            opaqueWindows: true,
          },
          light: getCodeThemeSeed("codex", "light"),
        },
        systemUiFont: false,
        translucency: {
          dark: { opacity: 72, blur: null, sidebarOnly: true },
          light: { opacity: 38, blur: 64, sidebarOnly: false },
        },
      };
      expect(parseStoredThemeState(JSON.stringify(saved))).toEqual(saved);
    },
  );

  it("resets only the selected variant to Synara when explicitly requested", () => {
    const saved = parseStoredThemeState("dark");
    const reset = resetThemeVariant(saved, "dark");
    expect(reset.codeThemeIds).toEqual({ dark: "synara", light: "codex" });
    expect(reset.chromeThemes.dark.accent).toBe("#f2612d");
    expect(reset.chromeThemes.light).toEqual(saved.chromeThemes.light);
    expect(reset.mode).toBe("dark");
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
        light: getCodeThemeSeed("codex", "light"),
      },
      codeThemeIds: {
        dark: "linear",
        light: "codex",
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
      codeThemeId: "synara",
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
  it.each([{ windowTranslucency: "native" as const }])(
    "projects distinct Vercel and Codex light colors on %j",
    (platform) => {
      const state = setThemeCodeThemeId(DEFAULT_THEME_STATE, "light", "vercel");
      const vercel = buildThemeCssVariables(resolveThemePack(state, "light"), "light", platform);
      const codex = buildThemeCssVariables(
        { codeThemeId: "codex", theme: getCodeThemeSeed("codex", "light") },
        "light",
        platform,
      );
      expect(vercel.variables["--codex-base-accent"]).toBe("#006aff");
      expect(codex.variables["--codex-base-accent"]).toBe("#0169cc");
      expect(vercel.variables["--color-text-foreground"]).toBe("#171717");
      expect(codex.variables["--color-text-foreground"]).toBe("#0d0d0d");
      // These two presets intentionally share a white surface in light mode.
      expect(vercel.variables["--codex-base-surface"]).toBe(
        codex.variables["--codex-base-surface"],
      );
      // Editing a slot must not change the user's system-mode or other-slot choices.
      expect(state.mode).toBe("system");
      expect(state.chromeThemes.dark).toEqual(DEFAULT_THEME_STATE.chromeThemes.dark);
    },
  );

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

describe("window translucency", () => {
  const macDesktop = { windowTranslucency: "native" as const };

  const sidebarOnly = (opacity: number) => ({
    ...macDesktop,
    translucency: { opacity, blur: 0, sidebarOnly: true },
  });

  it("defaults both themes to full-window glass with 90% opacity and 64 blur", () => {
    const state = normalizeThemeState({});
    expect(state.translucency).toEqual({
      dark: { opacity: 90, blur: 64, sidebarOnly: false },
      light: { opacity: 90, blur: 64, sidebarOnly: false },
    });
  });

  it("makes the whole window one translucent coat when not limited to the sidebar", () => {
    const dark = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, "dark"), "dark", {
      ...macDesktop,
      translucency: { opacity: 72, blur: null, sidebarOnly: false },
    });
    expect(dark.material).toBe("translucent");
    expect(dark.translucencyScope).toBe("window");
    // The body carries the only fill; every surface above it stays clear so nested route
    // surfaces never stack it.
    expect(dark.variables["--app-window-background"]).toMatch(/80%, black\) 72%, transparent\)$/);
    expect(dark.variables["--app-content-surface"]).toBe("transparent");
    expect(dark.variables["--app-settings-surface"]).toBe("transparent");
    expect(dark.variables["--app-sidebar-surface"]).toBe("transparent");
    expect(dark.variables["--app-rail-shell-opacity"]).toBe("0%");
    expect(dark.variables["--app-sidebar-chip-surface"]).toBe(
      dark.variables["--app-window-background"],
    );
    // Raised chrome is a denser pane of the elevated tone, tracking the coat's opacity.
    expect(dark.variables["--app-glass-raised-surface"]).toBe(
      "color-mix(in srgb, var(--popover) 46%, transparent)",
    );
    // Overlays share that tint, and the body already paints the coat behind them.
    expect(dark.variables["--app-overlay-surface"]).toBe(
      dark.variables["--app-glass-raised-surface"],
    );
    expect(dark.variables["--app-overlay-backing"]).toBe("");
    const light = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, "light"), "light", {
      ...macDesktop,
      translucency: { opacity: 38, blur: null, sidebarOnly: false },
    });
    expect(light.variables["--app-glass-raised-surface"]).toBe(
      "color-mix(in srgb, var(--popover) 15%, transparent)",
    );
  });

  it("keeps the content opaque and the shell clear for opaque windows", () => {
    const opaque = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, "dark"), "dark", {
      windowTranslucency: null,
    });
    expect(opaque.material).toBe("opaque");
    expect(opaque.translucencyScope).toBe("none");
    expect(opaque.variables["--app-content-surface"]).toBe(
      opaque.variables["--color-background-surface"],
    );
    expect(opaque.variables["--app-window-background"]).toBe(
      opaque.variables["--app-shell-background"],
    );
  });

  it("projects the same glass on a compositor-blurred window as on macOS vibrancy", () => {
    const pack = resolveThemePack(DEFAULT_THEME_STATE, "dark");
    const translucency = { opacity: 72, blur: null, sidebarOnly: false };
    const compositor = buildThemeCssVariables(pack, "dark", {
      windowTranslucency: "compositor",
      translucency,
    });
    expect(compositor).toEqual(
      buildThemeCssVariables(pack, "dark", { windowTranslucency: "native", translucency }),
    );
    expect(compositor.material).toBe("translucent");
    // A theme that asks for solid windows stays opaque on either backing.
    expect(
      buildThemeCssVariables({ ...pack, theme: { ...pack.theme, opaqueWindows: true } }, "dark", {
        windowTranslucency: "compositor",
        translucency,
      }).material,
    ).toBe("opaque");
  });

  it("keeps the long-standing sidebar fills when limited to the sidebar", () => {
    const dark = buildThemeCssVariables(
      resolveThemePack(DEFAULT_THEME_STATE, "dark"),
      "dark",
      sidebarOnly(72),
    );
    const light = buildThemeCssVariables(
      resolveThemePack(DEFAULT_THEME_STATE, "light"),
      "light",
      sidebarOnly(38),
    );
    expect(dark.material).toBe("translucent");
    expect(dark.translucencyScope).toBe("sidebar");
    expect(dark.variables["--app-window-background"]).toBe("transparent");
    expect(dark.variables["--app-glass-raised-surface"]).toBe("");
    // Off whole-window glass, overlays take the composer's fill and carry the coat themselves.
    expect(dark.variables["--app-overlay-surface"]).toBe(
      "color-mix(in srgb, var(--popover) 55%, transparent)",
    );
    expect(dark.variables["--app-overlay-backing"]).toBe(dark.variables["--app-sidebar-surface"]);
    expect(dark.variables["--app-content-surface"]).toBe(
      dark.variables["--color-background-surface"],
    );
    expect(dark.variables["--app-settings-surface"]).toBe(
      dark.variables["--color-background-surface"],
    );
    expect(dark.variables["--app-sidebar-surface"]).toMatch(/80%, black\) 72%, transparent\)$/);
    expect(dark.variables["--app-rail-shell-opacity"]).toBe("64%");
    expect(light.variables["--app-sidebar-surface"]).toMatch(/ 38%, transparent\)$/);
    expect(light.variables["--app-rail-shell-opacity"]).toBe("82%");
  });

  it("scales the sidebar and rail fills with the chosen opacity", () => {
    const pack = resolveThemePack(DEFAULT_THEME_STATE, "light");
    const clear = buildThemeCssVariables(pack, "light", sidebarOnly(0));
    const dense = buildThemeCssVariables(pack, "light", sidebarOnly(90));
    expect(clear.variables["--app-sidebar-surface"]).toMatch(/ 0%, transparent\)$/);
    expect(clear.variables["--app-rail-shell-opacity"]).toBe("0%");
    expect(dense.variables["--app-rail-shell-opacity"]).toBe("100%");
  });

  it("gives stored states without translucency the defaults and clamps edits", () => {
    const legacy = normalizeThemeState({ mode: "dark" });
    expect(legacy.translucency).toEqual(DEFAULT_THEME_STATE.translucency);
    expect(legacy.translucency.dark.blur).toBe(64);

    // Missing scope uses the default while preserving explicit opacity and blur.
    expect(
      normalizeThemeState({ translucency: { dark: { opacity: 50, blur: 10 } } }).translucency.dark,
    ).toEqual({ opacity: 50, blur: 10, sidebarOnly: false });

    const edited = setWindowTranslucency(legacy, "dark", {
      opacity: 140,
      blur: -3,
      sidebarOnly: false,
    });
    expect(edited.translucency.dark).toEqual({ opacity: 100, blur: 1, sidebarOnly: false });
    // A stored see-through window (no fill, no blur) is repaired to the floors on load.
    expect(
      normalizeThemeState({ translucency: { dark: { opacity: 0, blur: 0, sidebarOnly: false } } })
        .translucency.dark,
    ).toEqual({ opacity: 15, blur: 1, sidebarOnly: false });
    // Clearing the blur returns to the vibrancy material.
    expect(setWindowTranslucency(edited, "dark", { blur: null }).translucency.dark.blur).toBeNull();
    expect(edited.translucency.light).toEqual(DEFAULT_THEME_STATE.translucency.light);
    expect(resetThemeVariant(edited, "dark").translucency.dark).toEqual(
      DEFAULT_THEME_STATE.translucency.dark,
    );
  });
});

// Profiles publish both appearances, including custom accents and inactive packs.
describe("resolveProfileThemeAccent", () => {
  it("resolves selected packs and custom hex accents independently of appearance", () => {
    const selected = setThemeCodeThemeId(DEFAULT_THEME_STATE, "dark", "linear");
    const custom = updateChromeTheme(selected, "light", { accent: "#AABBCC" });
    for (const mode of ["light", "dark", "system"] as const) {
      expect(resolveProfileThemeAccent({ ...custom, mode })).toEqual({
        light: "#aabbcc",
        dark: "#606acc",
      });
    }
  });

  it("uses the same default fallback as the app for invalid stored accents", () => {
    expect(
      resolveProfileThemeAccent(
        normalizeThemeState({
          chromeThemes: { light: { accent: "red" }, dark: { accent: "#123" } },
        }),
      ),
    ).toEqual({ light: "#339cff", dark: "#339cff" });
  });
});

// ─── foreground contrast floors ──────────────────────────────────────────

type ColorChannels = { red: number; green: number; blue: number; alpha: number };

const colorChannels = (value: string): ColorChannels => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const int = Number.parseInt(hex[1]!, 16);
    return { alpha: 1, blue: int & 255, green: (int >> 8) & 255, red: (int >> 16) & 255 };
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!rgb) throw new Error(`Unparseable theme color: ${value}`);
  const [red, green, blue, alpha] = rgb[1]!.split(",").map((part) => Number(part));
  return { alpha: alpha ?? 1, blue: blue!, green: green!, red: red! };
};

const linearize = (value: number) => {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = ({ red, green, blue }: Omit<ColorChannels, "alpha">) =>
  0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);

/** WCAG 2.1 contrast of a theme token over the opaque surface it is drawn on. */
const contrastOver = (token: string, surface: string) => {
  const background = colorChannels(surface);
  const ink = colorChannels(token);
  const composited = {
    blue: ink.blue * ink.alpha + background.blue * (1 - ink.alpha),
    green: ink.green * ink.alpha + background.green * (1 - ink.alpha),
    red: ink.red * ink.alpha + background.red * (1 - ink.alpha),
  };
  const [lighter, darker] = [relativeLuminance(composited), relativeLuminance(background)].toSorted(
    (left, right) => right - left,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
};

/** The rgba() the derivation emits for a palette ink at a given alpha. */
const inkAtAlpha = (ink: string, alpha: number) => {
  const { red, green, blue } = colorChannels(ink);
  const formatted = Math.min(1, Math.max(0, alpha))
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `rgba(${red}, ${green}, ${blue}, ${formatted})`;
};

describe("foreground contrast floors", () => {
  const LINK_FLOOR = 4.5;
  const MUTED_FLOOR = 3;
  const SHIPPED = CODE_THEME_OPTIONS.flatMap((option) =>
    option.variants.map((variant) => ({ id: option.id, variant })),
  );

  /** A palette's link, muted and surface values as the derivation produced them, unfloored. */
  const tokensFor = (id: string, variant: ThemeVariant) => {
    const theme = getCodeThemeSeed(id, variant);
    const resolved = buildResolvedThemeTokens({ codeThemeId: id, theme }, variant);
    const { contrast } = resolved.computed;
    const accent = colorChannels(theme.accent);
    const brightened = (channel: number) =>
      Math.round(channel + (255 - channel) * (0.3 + contrast * 0.15));
    const accentRgb = `rgb(${accent.red}, ${accent.green}, ${accent.blue})`;
    const brightenedRgb = `rgb(${brightened(accent.red)}, ${brightened(accent.green)}, ${brightened(accent.blue)})`;
    return {
      derived: resolved.derived,
      // The light step is the palette's own accent, printed as a hex or as an rgb(); either
      // print of the same colour counts as untouched.
      link: variant === "light" ? [theme.accent, accentRgb] : [brightenedRgb],
      muted: inkAtAlpha(theme.ink, 0.65 + contrast * 0.1),
      surface: theme.surface,
    };
  };

  it("floors the link and muted step of every shipped palette", () => {
    const below: string[] = [];
    for (const { id, variant } of SHIPPED) {
      const { derived, surface } = tokensFor(id, variant);
      const link = contrastOver(derived.textAccent, surface);
      const muted = contrastOver(derived.textForegroundSecondary, surface);
      if (link < LINK_FLOOR) below.push(`${id}/${variant} link ${link.toFixed(2)}`);
      if (muted < MUTED_FLOOR) below.push(`${id}/${variant} muted ${muted.toFixed(2)}`);
    }
    expect(below).toEqual([]);
  });

  it("leaves a token that already clears its floor byte-identical", () => {
    const moved: string[] = [];
    for (const { id, variant } of SHIPPED) {
      const { derived, link, muted, surface } = tokensFor(id, variant);
      if (contrastOver(link[0]!, surface) >= LINK_FLOOR && !link.includes(derived.textAccent)) {
        moved.push(`${id}/${variant} link ${link[0]} -> ${derived.textAccent}`);
      }
      if (
        contrastOver(muted, surface) >= MUTED_FLOOR &&
        derived.textForegroundSecondary !== muted
      ) {
        moved.push(`${id}/${variant} muted ${muted} -> ${derived.textForegroundSecondary}`);
      }
    }
    expect(moved).toEqual([]);
  });

  it("takes the smallest step that clears the floor", () => {
    // Rose Pine light's link step is the issue's worst case at 2.6:1; the raised token must
    // land on the floor rather than overshoot it, and keep the palette's colour family.
    const { derived, link, muted, surface } = tokensFor("rose-pine", "light");
    expect(contrastOver(link[0]!, surface)).toBeLessThan(LINK_FLOOR);
    const raised = contrastOver(derived.textAccent, surface);
    expect(raised).toBeGreaterThanOrEqual(LINK_FLOOR);
    expect(raised).toBeLessThan(LINK_FLOOR + 0.05);
    const accent = colorChannels(link[0]!);
    const floored = colorChannels(derived.textAccent);
    expect(floored.red).toBeLessThan(accent.red);
    expect(floored.green).toBeLessThan(accent.green);
    expect(floored.blue).toBeLessThan(accent.blue);

    // The muted step keeps the palette's ink and only stops being so sheer.
    const sheer = colorChannels(muted);
    const flooredMuted = colorChannels(derived.textForegroundSecondary);
    expect([flooredMuted.red, flooredMuted.green, flooredMuted.blue]).toEqual([
      sheer.red,
      sheer.green,
      sheer.blue,
    ]);
    expect(flooredMuted.alpha).toBeGreaterThan(sheer.alpha);
  });
});
