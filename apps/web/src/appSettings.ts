import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Option, Schema, SchemaTransformation } from "effect";
import {
  type AssistantDeliveryMode,
  DesktopAppIcon,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SERVER_SETTINGS_VIEW,
  GIT_TEXT_GENERATION_PROVIDERS,
  TrimmedNonEmptyString,
  ProviderKind,
  type GitTextGenerationProvider,
  type ProviderStartOptions,
  type ServerSettingsView,
  type ServerSettingsPatch,
} from "@synara/contracts";
import {
  getDefaultModel,
  getModelOptions,
  normalizeModelSlug,
  resolveSelectableModel,
} from "@synara/shared/model";
import {
  APP_SNAP_SHORTCUT_KEYS,
  APP_SNAP_SHORTCUT_MODIFIERS,
  DEFAULT_APP_SNAP_SHORTCUT,
} from "@synara/shared/appSnapShortcut";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { EnvMode } from "./components/BranchToolbar.logic";
import { normalizeCursorModelVariantBaseId } from "./cursorModelVariants";
import { formatProviderModelOptionName, type ProviderModelOption } from "./providerModelOptions";
import {
  DEFAULT_PROVIDER_ORDER,
  normalizeHiddenProviders,
  normalizeProviderOrder,
} from "./providerOrdering";
import {
  DEFAULT_SIDEBAR_NAV_ORDER,
  normalizeHiddenSidebarNavItems,
  normalizeSidebarNavOrder,
  SIDEBAR_NAV_ITEM_IDS,
} from "./sidebarNavOrdering";
import { ensureNativeApi } from "./nativeApi";
import { providerDiscoveryQueryKeys } from "./lib/providerDiscoveryReactQuery";
import {
  invalidateProviderUsageQueries,
  reconcileServerProviderStatuses,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "./lib/serverReactQuery";
import {
  DEFAULT_UI_DENSITY,
  UI_DENSITY_MODES,
  normalizeUiDensity as normalizeUiDensityValue,
} from "./lib/appDensity";
import {
  DEFAULT_CHAT_WIDTH,
  CHAT_WIDTH_MODES,
  normalizeChatWidthMode as normalizeChatWidthModeValue,
} from "./lib/chatWidth";

const APP_SETTINGS_STORAGE_KEY = "synara:app-settings:v1";
const SERVER_SETTINGS_MIGRATION_STORAGE_KEY = "synara:server-settings-migrated:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const MIN_CHAT_FONT_SIZE_PX = 11;
export const MAX_CHAT_FONT_SIZE_PX = 18;
export const DEFAULT_CHAT_FONT_SIZE_PX = 13;
export const MIN_TERMINAL_FONT_SIZE_PX = 10;
export const MAX_TERMINAL_FONT_SIZE_PX = 22;
export const DEFAULT_TERMINAL_FONT_SIZE_PX = 12;

// free-form font-family — the list below is autocomplete inspiration only, not a restriction
export const DEFAULT_TERMINAL_FONT_FAMILY = "";

export const TERMINAL_FONT_FAMILY_SUGGESTIONS: ReadonlyArray<string> = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "SF Mono",
  "Menlo",
  "Source Code Pro",
  "IBM Plex Mono",
  "Hack",
  "Roboto Mono",
  "Ubuntu Mono",
  "Consolas",
];

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";
export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "manual";
export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);

const SidebarNavItemId = Schema.Literals([...SIDEBAR_NAV_ITEM_IDS]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";
export const FollowUpBehavior = Schema.Literals(["queue", "steer"]);
export type FollowUpBehavior = typeof FollowUpBehavior.Type;
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "queue";
export const UiDensity = Schema.Literals(UI_DENSITY_MODES);
export type UiDensity = typeof UiDensity.Type;
export { DEFAULT_UI_DENSITY };
export const ChatWidthMode = Schema.Literals(CHAT_WIDTH_MODES);
export type ChatWidthMode = typeof ChatWidthMode.Type;
export { DEFAULT_CHAT_WIDTH };

const AppSnapShortcut = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("both-option-keys") }),
  Schema.Struct({
    kind: Schema.Literal("key-chord"),
    modifier: Schema.Literals(APP_SNAP_SHORTCUT_MODIFIERS),
    key: Schema.Literals(APP_SNAP_SHORTCUT_KEYS),
  }),
]);

export function getDefaultNativeFontSmoothing(platform = globalThis.navigator?.platform ?? "") {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

type CustomModelSettingsKey =
  | "customCodexModels"
  | "customClaudeModels"
  | "customCursorModels"
  | "customAntigravityModels"
  | "customGrokModels"
  | "customDroidModels"
  | "customDevinModels"
  | "customOpenCodeModels"
  | "customPiModels";
export type ProviderCustomModelConfig = {
  provider: ProviderKind;
  settingsKey: CustomModelSettingsKey;
  defaultSettingsKey: CustomModelSettingsKey;
  title: string;
  description: string;
  placeholder: string;
  example: string;
};

const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  claudeAgent: new Set(getModelOptions("claudeAgent").map((option) => option.slug)),
  cursor: new Set(getModelOptions("cursor").map((option) => option.slug)),
  devin: new Set(getModelOptions("devin").map((option) => option.slug)),
  antigravity: new Set(getModelOptions("antigravity").map((option) => option.slug)),
  grok: new Set(getModelOptions("grok").map((option) => option.slug)),
  droid: new Set(getModelOptions("droid").map((option) => option.slug)),
  opencode: new Set(getModelOptions("opencode").map((option) => option.slug)),
  pi: new Set(getModelOptions("pi").map((option) => option.slug)),
};

const withDefaults =
  <
    S extends Schema.Top & Schema.WithoutConstructorDefault,
    D extends S["~type.make.in"] & S["Encoded"],
  >(
    fallback: () => D,
  ) =>
  (schema: S) =>
    schema.pipe(
      Schema.withConstructorDefault(() => Option.some(fallback())),
      Schema.withDecodingDefault(() => fallback()),
    );

const PersistedProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "devin",
  "antigravity",
  "gemini",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
]).pipe(
  Schema.decodeTo(
    ProviderKind,
    SchemaTransformation.transform({
      decode: (provider) => {
        if (provider === "gemini") return "antigravity";
        if (provider === "kilo") return "opencode";
        return provider;
      },
      encode: (provider) => provider,
    }),
  ),
);

// gemini→antigravity carries list entries over; removed providers with no successor (kilo) must not transfer prefs, and unknown values drop instead of failing the decode
const RENAMED_PROVIDERS: Readonly<Record<string, ProviderKind>> = {
  gemini: "antigravity",
};

function resolvePersistedProviderListEntry(provider: string): ProviderKind | undefined {
  const renamed = RENAMED_PROVIDERS[provider] ?? provider;
  return Schema.is(ProviderKind)(renamed) ? renamed : undefined;
}

const PersistedProviderKindList = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderKind),
    SchemaTransformation.transform({
      decode: (providers): ReadonlyArray<ProviderKind> =>
        providers.flatMap((provider) => {
          const resolved = resolvePersistedProviderListEntry(provider);
          return resolved === undefined ? [] : [resolved];
        }),
      encode: (providers) => providers as ReadonlyArray<string>,
    }),
  ),
);

const PersistedHiddenModels = Schema.Array(
  Schema.Struct({
    provider: Schema.String,
    slug: Schema.String,
  }),
).pipe(
  Schema.decodeTo(
    Schema.Array(
      Schema.Struct({
        provider: ProviderKind,
        slug: Schema.String,
      }),
    ),
    SchemaTransformation.transform({
      decode: (entries): ReadonlyArray<{ provider: ProviderKind; slug: string }> =>
        entries.flatMap((entry) => {
          const resolved = resolvePersistedProviderListEntry(entry.provider);
          return resolved === undefined ? [] : [{ provider: resolved, slug: entry.slug }];
        }),
      encode: (entries) => entries,
    }),
  ),
);

export const AppSettingsSchema = Schema.Struct({
  claudeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  claudeEnableArtifacts: Schema.Boolean.pipe(withDefaults(() => false)),
  onboardingCompletedAt: Schema.NullOr(Schema.String).pipe(withDefaults((): string | null => null)),
  uiDensity: UiDensity.pipe(withDefaults(() => DEFAULT_UI_DENSITY)),
  chatWidth: ChatWidthMode.pipe(withDefaults(() => DEFAULT_CHAT_WIDTH)),
  chatFontSizePx: Schema.Number.pipe(withDefaults(() => DEFAULT_CHAT_FONT_SIZE_PX)),
  chatCodeFontFamily: Schema.String.check(Schema.isMaxLength(256)).pipe(withDefaults(() => "")),
  terminalFontSizePx: Schema.Number.pipe(withDefaults(() => DEFAULT_TERMINAL_FONT_SIZE_PX)),
  terminalFontFamily: Schema.String.check(Schema.isMaxLength(256)).pipe(
    withDefaults(() => DEFAULT_TERMINAL_FONT_FAMILY),
  ),
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  cursorBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  cursorApiEndpoint: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  devinBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  antigravityBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  // Deprecated Gemini keys remain decodable until normalization rewrites local storage.
  geminiBinaryPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  grokBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  droidBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  openCodeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  piBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  piAgentDir: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  openCodeServerUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  openCodeServerPassword: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    withDefaults(() => ""),
  ),
  openCodeServerPasswordConfigured: Schema.Boolean.pipe(withDefaults(() => false)),
  openCodeExperimentalWebSockets: Schema.Boolean.pipe(withDefaults(() => false)),
  defaultThreadEnvMode: EnvMode.pipe(withDefaults(() => "local" as const satisfies EnvMode)),
  confirmThreadDelete: Schema.Boolean.pipe(withDefaults(() => true)),
  resumeChatsAfterQuit: Schema.Boolean.pipe(withDefaults(() => true)),
  confirmThreadArchive: Schema.Boolean.pipe(withDefaults(() => false)),
  confirmTerminalTabClose: Schema.Boolean.pipe(withDefaults(() => true)),
  diffWordWrap: Schema.Boolean.pipe(withDefaults(() => false)),
  showPullRequestDiffColors: Schema.Boolean.pipe(withDefaults(() => true)),
  showChatsSection: Schema.Boolean.pipe(withDefaults(() => true)),
  showStudioSection: Schema.Boolean.pipe(withDefaults(() => true)),
  // an item whose route is active stays visible regardless — hiding a surface never strands the user mid-route
  sidebarNavOrder: Schema.Array(SidebarNavItemId).pipe(
    withDefaults(() => [...DEFAULT_SIDEBAR_NAV_ORDER]),
  ),
  hiddenSidebarNavItems: Schema.Array(SidebarNavItemId).pipe(withDefaults(() => [])),
  showAutomationRunThreads: Schema.Boolean.pipe(withDefaults(() => true)),
  environmentPanelDefaultOpen: Schema.Boolean.pipe(withDefaults(() => false)),
  showEnvironmentUsage: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentRepository: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentPullRequest: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentEditor: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentRecap: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentPinned: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentInstructions: Schema.Boolean.pipe(withDefaults(() => false)),
  showEnvironmentNotepad: Schema.Boolean.pipe(withDefaults(() => false)),
  followUpBehavior: FollowUpBehavior.pipe(withDefaults(() => DEFAULT_FOLLOW_UP_BEHAVIOR)),
  enableAssistantStreaming: Schema.Boolean.pipe(withDefaults(() => true)),
  composerEffortSlider: Schema.Boolean.pipe(withDefaults(() => true)),
  autoOpenDevicePane: Schema.Boolean.pipe(withDefaults(() => true)),
  enableProviderUpdateChecks: Schema.Boolean.pipe(withDefaults(() => true)),
  enableNativeFontSmoothing: Schema.Boolean.pipe(withDefaults(getDefaultNativeFontSmoothing)),
  desktopAppIcon: DesktopAppIcon.pipe(withDefaults(() => "default" as const)),
  // Electron `frame` is fixed at window creation — the main process persists this too and a relaunch is required to apply it
  useCustomTitleBar: Schema.Boolean.pipe(withDefaults(() => true)),
  enableTaskCompletionToasts: Schema.Boolean.pipe(withDefaults(() => true)),
  enableSystemTaskCompletionNotifications: Schema.Boolean.pipe(withDefaults(() => true)),
  // AppSnap is opt-in: enabling it requests macOS Input Monitoring and Screen Recording permissions
  enableAppSnap: Schema.Boolean.pipe(withDefaults(() => false)),
  appSnapShortcut: AppSnapShortcut.pipe(withDefaults(() => DEFAULT_APP_SNAP_SHORTCUT)),
  appSnapPlaySound: Schema.Boolean.pipe(withDefaults(() => true)),
  // rename bridge — normalization migrates this value then omits the key
  enableAppshots: Schema.optionalKey(Schema.Boolean),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    withDefaults(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    withDefaults(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  timestampFormat: TimestampFormat.pipe(withDefaults(() => DEFAULT_TIMESTAMP_FORMAT)),
  customCodexModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customClaudeModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customCursorModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customDevinModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customAntigravityModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customGeminiModels: Schema.optionalKey(Schema.Array(Schema.String)),
  customGrokModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customDroidModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customOpenCodeModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customPiModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  textGenerationProvider: PersistedProviderKind.pipe(withDefaults(() => "codex" as const)),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
  uiFontFamily: Schema.String.check(Schema.isMaxLength(256)).pipe(withDefaults(() => "")),
  defaultProvider: PersistedProviderKind.pipe(withDefaults(() => "codex" as const)),
  // the active/locked provider for a thread is always shown — hiding never strands a thread on a hidden provider
  hiddenProviders: PersistedProviderKindList.pipe(withDefaults(() => [])),
  // server-backed shutdown policy: unlike hiddenProviders, entries here can't run discovery, health checks, updates, or new turns until re-enabled
  disabledProviders: PersistedProviderKindList.pipe(withDefaults(() => [])),
  providerOrder: PersistedProviderKindList.pipe(withDefaults(() => [...DEFAULT_PROVIDER_ORDER])),
  // model-level hiding caused too many edge cases — normalized away now
  hiddenModels: PersistedHiddenModels.pipe(withDefaults(() => [])),
});
export type AppSettings = typeof AppSettingsSchema.Type;

/** The settings values and mutation used by a mounted settings panel.
 * The route owns the subscription so extracted workflow panels do not create
 * duplicate local-storage/server-settings subscriptions. */
export type AppSettingsBinding = {
  readonly settings: AppSettings;
  readonly defaults: AppSettings;
  readonly updateSettings: (patch: Partial<AppSettings>) => void;
};

export function isGitTextGenerationSettingsDirty(
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return (
    (settings.textGenerationProvider ?? "codex") !== (defaults.textGenerationProvider ?? "codex") ||
    (settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL) !==
      (defaults.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL)
  );
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type MutableServerSettingsPatch = Mutable<ServerSettingsPatch>;
type MutableServerSettingsProvidersPatch = Mutable<NonNullable<ServerSettingsPatch["providers"]>>;

export interface AppModelOption extends ProviderModelOption {
  provider: ProviderKind;
  isCustom: boolean;
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});
let serverSettingsMigrationInFlight = false;

const PROVIDER_CUSTOM_MODEL_CONFIG: Record<ProviderKind, ProviderCustomModelConfig> = {
  codex: {
    provider: "codex",
    settingsKey: "customCodexModels",
    defaultSettingsKey: "customCodexModels",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  claudeAgent: {
    provider: "claudeAgent",
    settingsKey: "customClaudeModels",
    defaultSettingsKey: "customClaudeModels",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-custom-model",
  },
  cursor: {
    provider: "cursor",
    settingsKey: "customCursorModels",
    defaultSettingsKey: "customCursorModels",
    title: "Cursor",
    description: "Save additional Cursor model slugs for the picker and provider runtime.",
    placeholder: "cursor-model-slug",
    example: "composer-2",
  },
  devin: {
    provider: "devin",
    settingsKey: "customDevinModels",
    defaultSettingsKey: "customDevinModels",
    title: "Devin",
    description: "Save additional Devin model slugs for the picker and provider runtime.",
    placeholder: "devin-model-slug",
    example: "adaptive",
  },
  antigravity: {
    provider: "antigravity",
    settingsKey: "customAntigravityModels",
    defaultSettingsKey: "customAntigravityModels",
    title: "Antigravity",
    description: "Save additional Antigravity CLI base model names for the picker.",
    placeholder: "Model Name",
    example: "Gemini 4 Pro",
  },
  grok: {
    provider: "grok",
    settingsKey: "customGrokModels",
    defaultSettingsKey: "customGrokModels",
    title: "Grok",
    description: "Save additional Grok model slugs for the picker and `/model` command.",
    placeholder: "your-grok-model-slug",
    example: "grok-4.6",
  },
  droid: {
    provider: "droid",
    settingsKey: "customDroidModels",
    defaultSettingsKey: "customDroidModels",
    title: "Droid",
    description: "Save additional Droid model slugs for the picker and `/model` command.",
    placeholder: "your-droid-model-slug",
    example: "claude-opus-4-8",
  },
  opencode: {
    provider: "opencode",
    settingsKey: "customOpenCodeModels",
    defaultSettingsKey: "customOpenCodeModels",
    title: "OpenCode",
    description: "Save additional OpenCode model slugs for the picker and provider runtime.",
    placeholder: "provider/model",
    example: "openai/gpt-5",
  },
  pi: {
    provider: "pi",
    settingsKey: "customPiModels",
    defaultSettingsKey: "customPiModels",
    title: "Pi",
    description: "Save additional Pi model slugs for the picker and provider runtime.",
    placeholder: "provider/model",
    example: "anthropic/claude-sonnet-4-5",
  },
};

export const MODEL_PROVIDER_SETTINGS = Object.values(PROVIDER_CUSTOM_MODEL_CONFIG);

// Droid's ACP catalog rejects unknown slugs — preserve its config but don't offer an editor it can't honor
export const CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS = MODEL_PROVIDER_SETTINGS.filter(
  (config) => config.provider !== "droid",
);

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function normalizeChatFontSizePx(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CHAT_FONT_SIZE_PX;
  }

  return Math.min(MAX_CHAT_FONT_SIZE_PX, Math.max(MIN_CHAT_FONT_SIZE_PX, Math.round(value)));
}

export function normalizeTerminalFontSizePx(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE_PX;
  }

  return Math.min(
    MAX_TERMINAL_FONT_SIZE_PX,
    Math.max(MIN_TERMINAL_FONT_SIZE_PX, Math.round(value)),
  );
}

export function normalizeTerminalFontFamily(value: string | null | undefined): string {
  // strip only chars that can't appear in a CSS font-family (`;`, `{}`, angle brackets, newlines) so the value can't break out of the custom property; whitespace stays so multi-word names remain typable — the CSS resolver trims
  return (value ?? "").replace(/[;{}<>\n\r]/g, "").slice(0, 256);
}

export function resolveTerminalFontFamilyStack(value: string | null | undefined): string | null {
  const normalized = normalizeTerminalFontFamily(value).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  const hasGenericFallback = /\b(?:monospace|serif|sans-serif|system-ui|ui-monospace)\b/.test(
    normalized,
  );

  if (normalized.includes(",")) {
    return hasGenericFallback ? normalized : `${normalized}, monospace`;
  }

  const isQuoted = /^(["']).*\1$/.test(normalized);
  const family = !isQuoted && /\s/.test(normalized) ? `"${normalized}"` : normalized;
  return hasGenericFallback ? family : `${family}, monospace`;
}

function normalizeProviderBinaryPathOverride(
  provider: ProviderKind,
  value: string | null | undefined,
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === DEFAULT_SERVER_SETTINGS.providers[provider].binaryPath) {
    return "";
  }
  return trimmed;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const {
    enableAppshots: legacyEnableAppshots,
    geminiBinaryPath: legacyGeminiBinaryPath,
    customGeminiModels: legacyCustomGeminiModels,
    ...currentSettings
  } = settings;
  return {
    ...currentSettings,
    enableAppSnap: settings.enableAppSnap || legacyEnableAppshots === true,
    // password fields are write-only patches — never retain reusable provider credentials in browser state or localStorage
    openCodeServerPassword: "",
    claudeBinaryPath: normalizeProviderBinaryPathOverride("claudeAgent", settings.claudeBinaryPath),
    codexBinaryPath: normalizeProviderBinaryPathOverride("codex", settings.codexBinaryPath),
    cursorBinaryPath: normalizeProviderBinaryPathOverride("cursor", settings.cursorBinaryPath),
    devinBinaryPath: normalizeProviderBinaryPathOverride("devin", settings.devinBinaryPath),
    antigravityBinaryPath: normalizeProviderBinaryPathOverride(
      "antigravity",
      settings.antigravityBinaryPath || legacyGeminiBinaryPath,
    ),
    grokBinaryPath: normalizeProviderBinaryPathOverride("grok", settings.grokBinaryPath),
    droidBinaryPath: normalizeProviderBinaryPathOverride("droid", settings.droidBinaryPath),
    openCodeBinaryPath: normalizeProviderBinaryPathOverride(
      "opencode",
      settings.openCodeBinaryPath,
    ),
    piBinaryPath: normalizeProviderBinaryPathOverride("pi", settings.piBinaryPath),
    uiDensity: normalizeUiDensityValue(settings.uiDensity),
    chatWidth: normalizeChatWidthModeValue(settings.chatWidth),
    chatFontSizePx: normalizeChatFontSizePx(settings.chatFontSizePx),
    terminalFontSizePx: normalizeTerminalFontSizePx(settings.terminalFontSizePx),
    terminalFontFamily: normalizeTerminalFontFamily(settings.terminalFontFamily),
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customClaudeModels: normalizeCustomModelSlugs(settings.customClaudeModels, "claudeAgent"),
    customCursorModels: normalizeCustomModelSlugs(settings.customCursorModels, "cursor"),
    customDevinModels: normalizeCustomModelSlugs(settings.customDevinModels, "devin"),
    customAntigravityModels: normalizeCustomModelSlugs(
      [...settings.customAntigravityModels, ...(legacyCustomGeminiModels ?? [])],
      "antigravity",
    ),
    customGrokModels: normalizeCustomModelSlugs(settings.customGrokModels, "grok"),
    customDroidModels: normalizeCustomModelSlugs(settings.customDroidModels, "droid"),
    customOpenCodeModels: normalizeCustomModelSlugs(settings.customOpenCodeModels, "opencode"),
    customPiModels: normalizeCustomModelSlugs(settings.customPiModels, "pi"),
    hiddenProviders: normalizeHiddenProviders(settings.hiddenProviders),
    disabledProviders: normalizeHiddenProviders(settings.disabledProviders),
    providerOrder: normalizeProviderOrder(settings.providerOrder),
    sidebarNavOrder: normalizeSidebarNavOrder(settings.sidebarNavOrder),
    hiddenSidebarNavItems: normalizeHiddenSidebarNavItems(settings.hiddenSidebarNavItems),
    hiddenModels: [],
  };
}

export function getServerDisabledProviders(
  settings: Pick<ServerSettingsView, "providers">,
): ProviderKind[] {
  return DEFAULT_PROVIDER_ORDER.filter((provider) => !settings.providers[provider].enabled);
}

export function didProviderEnablementChange(
  previous: Pick<ServerSettingsView, "providers"> | undefined,
  next: Pick<ServerSettingsView, "providers">,
): boolean {
  return (
    previous === undefined ||
    DEFAULT_PROVIDER_ORDER.some(
      (provider) => previous.providers[provider].enabled !== next.providers[provider].enabled,
    )
  );
}

export function didProviderCommandDiscoverySettingsChange(
  previous: Pick<ServerSettingsView, "providers"> | undefined,
  next: Pick<ServerSettingsView, "providers">,
): boolean {
  return (
    previous !== undefined &&
    previous.providers.claudeAgent.enableArtifacts !== next.providers.claudeAgent.enableArtifacts
  );
}

function serverSettingsToAppSettings(settings: ServerSettingsView): Partial<AppSettings> {
  return {
    claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
    claudeEnableArtifacts: settings.providers.claudeAgent.enableArtifacts,
    codexBinaryPath: settings.providers.codex.binaryPath,
    codexHomePath: settings.providers.codex.homePath,
    cursorApiEndpoint: settings.providers.cursor.apiEndpoint,
    cursorBinaryPath: settings.providers.cursor.binaryPath,
    devinBinaryPath: settings.providers.devin.binaryPath,
    defaultThreadEnvMode: settings.defaultThreadEnvMode,
    enableAssistantStreaming: settings.enableAssistantStreaming,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
    antigravityBinaryPath: settings.providers.antigravity.binaryPath,
    grokBinaryPath: settings.providers.grok.binaryPath,
    droidBinaryPath: settings.providers.droid.binaryPath,
    openCodeBinaryPath: settings.providers.opencode.binaryPath,
    openCodeExperimentalWebSockets: settings.providers.opencode.experimentalWebSockets,
    openCodeServerPasswordConfigured: settings.providers.opencode.serverPasswordConfigured,
    openCodeServerUrl: settings.providers.opencode.serverUrl,
    piAgentDir: settings.providers.pi.agentDir,
    piBinaryPath: settings.providers.pi.binaryPath,
    customCodexModels: settings.providers.codex.customModels,
    customClaudeModels: settings.providers.claudeAgent.customModels,
    customCursorModels: settings.providers.cursor.customModels,
    customDevinModels: settings.providers.devin.customModels,
    customAntigravityModels: settings.providers.antigravity.customModels,
    customGrokModels: settings.providers.grok.customModels,
    customDroidModels: settings.providers.droid.customModels,
    customOpenCodeModels: settings.providers.opencode.customModels,
    customPiModels: settings.providers.pi.customModels,
    disabledProviders: getServerDisabledProviders(settings),
    textGenerationProvider: settings.textGenerationModelSelection.provider,
    textGenerationModel: settings.textGenerationModelSelection.model,
    onboardingCompletedAt: settings.onboardingCompletedAt ?? null,
  };
}

function resolveTextGenerationProvider(input: {
  readonly provider?: ProviderKind | null;
  readonly model?: string | null;
}): ProviderKind {
  if (input.provider) {
    return input.provider;
  }
  const model = input.model;
  return model?.includes("/") ? "opencode" : "codex";
}

function hasOwn<Key extends keyof AppSettings>(patch: Partial<AppSettings>, key: Key): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

function touchesProviderDiscoverySettings(patch: Partial<AppSettings>): boolean {
  return (
    hasOwn(patch, "claudeEnableArtifacts") ||
    hasOwn(patch, "devinBinaryPath") ||
    hasOwn(patch, "openCodeBinaryPath") ||
    hasOwn(patch, "openCodeExperimentalWebSockets") ||
    hasOwn(patch, "openCodeServerPassword") ||
    hasOwn(patch, "openCodeServerUrl") ||
    hasOwn(patch, "piAgentDir") ||
    hasOwn(patch, "disabledProviders")
  );
}

function serverSettingValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function pruneProviderPatchAgainstCurrentSettings(
  providers: MutableServerSettingsProvidersPatch,
  currentSettings: Pick<ServerSettingsView, "providers">,
): void {
  for (const provider of DEFAULT_PROVIDER_ORDER) {
    const providerPatch = providers[provider];
    if (!providerPatch) continue;

    const patchRecord = providerPatch as Record<string, unknown>;
    const currentRecord = currentSettings.providers[provider] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patchRecord)) {
      const matchesCurrent =
        key === "serverPassword"
          ? value === "" && currentRecord.serverPasswordConfigured === false
          : serverSettingValuesEqual(value, currentRecord[key]);
      if (matchesCurrent) {
        delete patchRecord[key];
      }
    }
    if (Object.keys(patchRecord).length === 0) {
      delete providers[provider];
    }
  }
}

export function appSettingsPatchToServerSettingsPatch(
  patch: Partial<AppSettings>,
  currentSettings?: Pick<ServerSettingsView, "providers">,
): ServerSettingsPatch {
  const providers: MutableServerSettingsProvidersPatch = {};
  const serverPatch: MutableServerSettingsPatch = {};

  if (hasOwn(patch, "enableAssistantStreaming")) {
    serverPatch.enableAssistantStreaming = Boolean(patch.enableAssistantStreaming);
  }
  if (hasOwn(patch, "enableProviderUpdateChecks")) {
    serverPatch.enableProviderUpdateChecks = Boolean(patch.enableProviderUpdateChecks);
  }
  if (patch.defaultThreadEnvMode === "local" || patch.defaultThreadEnvMode === "worktree") {
    serverPatch.defaultThreadEnvMode = patch.defaultThreadEnvMode;
  }
  if (hasOwn(patch, "onboardingCompletedAt")) {
    serverPatch.onboardingCompletedAt = patch.onboardingCompletedAt ?? null;
  }
  if (hasOwn(patch, "textGenerationModel") || hasOwn(patch, "textGenerationProvider")) {
    const model = patch.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
    serverPatch.textGenerationModelSelection = {
      provider: resolveTextGenerationProvider({
        ...(patch.textGenerationProvider !== undefined
          ? { provider: patch.textGenerationProvider }
          : {}),
        model,
      }),
      model,
    };
  }
  if (
    hasOwn(patch, "codexBinaryPath") ||
    hasOwn(patch, "codexHomePath") ||
    hasOwn(patch, "customCodexModels")
  ) {
    providers.codex = {
      ...(hasOwn(patch, "codexBinaryPath") ? { binaryPath: patch.codexBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "codexHomePath") ? { homePath: patch.codexHomePath ?? "" } : {}),
      ...(hasOwn(patch, "customCodexModels")
        ? { customModels: patch.customCodexModels ?? [] }
        : {}),
    };
  }
  if (
    hasOwn(patch, "claudeBinaryPath") ||
    hasOwn(patch, "claudeEnableArtifacts") ||
    hasOwn(patch, "customClaudeModels")
  ) {
    providers.claudeAgent = {
      ...(hasOwn(patch, "claudeBinaryPath") ? { binaryPath: patch.claudeBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "claudeEnableArtifacts")
        ? { enableArtifacts: Boolean(patch.claudeEnableArtifacts) }
        : {}),
      ...(hasOwn(patch, "customClaudeModels")
        ? { customModels: patch.customClaudeModels ?? [] }
        : {}),
    };
  }
  if (
    hasOwn(patch, "cursorApiEndpoint") ||
    hasOwn(patch, "cursorBinaryPath") ||
    hasOwn(patch, "customCursorModels")
  ) {
    providers.cursor = {
      ...(hasOwn(patch, "cursorApiEndpoint") ? { apiEndpoint: patch.cursorApiEndpoint ?? "" } : {}),
      ...(hasOwn(patch, "cursorBinaryPath") ? { binaryPath: patch.cursorBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "customCursorModels")
        ? { customModels: patch.customCursorModels ?? [] }
        : {}),
    };
  }
  if (hasOwn(patch, "devinBinaryPath") || hasOwn(patch, "customDevinModels")) {
    providers.devin = {
      ...(hasOwn(patch, "devinBinaryPath") ? { binaryPath: patch.devinBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "customDevinModels")
        ? { customModels: patch.customDevinModels ?? [] }
        : {}),
    };
  }
  if (hasOwn(patch, "antigravityBinaryPath") || hasOwn(patch, "customAntigravityModels")) {
    providers.antigravity = {
      ...(hasOwn(patch, "antigravityBinaryPath")
        ? { binaryPath: patch.antigravityBinaryPath ?? "" }
        : {}),
      ...(hasOwn(patch, "customAntigravityModels")
        ? { customModels: patch.customAntigravityModels ?? [] }
        : {}),
    };
  }
  if (hasOwn(patch, "grokBinaryPath") || hasOwn(patch, "customGrokModels")) {
    providers.grok = {
      ...(hasOwn(patch, "grokBinaryPath") ? { binaryPath: patch.grokBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "customGrokModels") ? { customModels: patch.customGrokModels ?? [] } : {}),
    };
  }
  if (hasOwn(patch, "droidBinaryPath") || hasOwn(patch, "customDroidModels")) {
    providers.droid = {
      ...(hasOwn(patch, "droidBinaryPath") ? { binaryPath: patch.droidBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "customDroidModels")
        ? { customModels: patch.customDroidModels ?? [] }
        : {}),
    };
  }
  if (
    hasOwn(patch, "openCodeBinaryPath") ||
    hasOwn(patch, "openCodeExperimentalWebSockets") ||
    hasOwn(patch, "openCodeServerUrl") ||
    hasOwn(patch, "openCodeServerPassword") ||
    hasOwn(patch, "customOpenCodeModels")
  ) {
    providers.opencode = {
      ...(hasOwn(patch, "openCodeBinaryPath")
        ? { binaryPath: patch.openCodeBinaryPath ?? "" }
        : {}),
      ...(hasOwn(patch, "openCodeExperimentalWebSockets")
        ? { experimentalWebSockets: Boolean(patch.openCodeExperimentalWebSockets) }
        : {}),
      ...(hasOwn(patch, "openCodeServerUrl") ? { serverUrl: patch.openCodeServerUrl ?? "" } : {}),
      ...(hasOwn(patch, "openCodeServerPassword")
        ? { serverPassword: patch.openCodeServerPassword ?? "" }
        : {}),
      ...(hasOwn(patch, "customOpenCodeModels")
        ? { customModels: patch.customOpenCodeModels ?? [] }
        : {}),
    };
  }
  if (
    hasOwn(patch, "piAgentDir") ||
    hasOwn(patch, "piBinaryPath") ||
    hasOwn(patch, "customPiModels")
  ) {
    providers.pi = {
      ...(hasOwn(patch, "piAgentDir") ? { agentDir: patch.piAgentDir ?? "" } : {}),
      ...(hasOwn(patch, "piBinaryPath") ? { binaryPath: patch.piBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "customPiModels") ? { customModels: patch.customPiModels ?? [] } : {}),
    };
  }
  if (hasOwn(patch, "disabledProviders")) {
    const disabledProviders = new Set(normalizeHiddenProviders(patch.disabledProviders ?? []));
    for (const provider of DEFAULT_PROVIDER_ORDER) {
      const enabled = !disabledProviders.has(provider);
      if (currentSettings?.providers[provider].enabled === enabled) {
        continue;
      }
      providers[provider] = {
        ...providers[provider],
        enabled,
      };
    }
  }

  if (currentSettings) {
    pruneProviderPatchAgainstCurrentSettings(providers, currentSettings);
  }

  if (Object.keys(providers).length > 0) {
    serverPatch.providers = providers;
  }
  return serverPatch;
}

function isServerSettingsPatchEmpty(patch: ServerSettingsPatch): boolean {
  return Object.keys(patch).length === 0;
}

function buildInitialServerSettingsMigrationPatch(settings: AppSettings): ServerSettingsPatch {
  const patch: Partial<Mutable<AppSettings>> = {};
  const normalizedSettings = normalizeAppSettings(settings);
  const defaults = DEFAULT_APP_SETTINGS;

  for (const key of [
    "claudeBinaryPath",
    "claudeEnableArtifacts",
    "codexBinaryPath",
    "codexHomePath",
    "cursorApiEndpoint",
    "cursorBinaryPath",
    "defaultThreadEnvMode",
    "enableAssistantStreaming",
    "enableProviderUpdateChecks",
    "devinBinaryPath",
    "antigravityBinaryPath",
    "grokBinaryPath",
    "droidBinaryPath",
    "openCodeBinaryPath",
    "openCodeExperimentalWebSockets",
    "openCodeServerPassword",
    "openCodeServerUrl",
    "piAgentDir",
    "piBinaryPath",
    "textGenerationModel",
    "textGenerationProvider",
  ] as const) {
    if (normalizedSettings[key] !== defaults[key]) {
      patch[key] = normalizedSettings[key] as never;
    }
  }

  // migrate legacy browser-stored passwords once, before normalize scrubs them — subsequent reads use redacted server views
  if (settings.openCodeServerPassword.trim()) {
    patch.openCodeServerPassword = settings.openCodeServerPassword;
  }

  for (const key of [
    "customCodexModels",
    "customClaudeModels",
    "customCursorModels",
    "customDevinModels",
    "customAntigravityModels",
    "customGrokModels",
    "customDroidModels",
    "customOpenCodeModels",
    "customPiModels",
  ] as const) {
    if (normalizedSettings[key].length > 0) {
      patch[key] = normalizedSettings[key] as never;
    }
  }

  return appSettingsPatchToServerSettingsPatch(patch);
}

export function normalizeStoredAppSettings(settings: AppSettings): AppSettings {
  return {
    ...normalizeAppSettings(settings),
    // provider enablement belongs to the connected server — scrub legacy values so a browser profile can't project one server's shutdown onto another
    disabledProviders: [],
  };
}

export function applyLocalAppSettingsPatch(
  settings: AppSettings,
  patch: Partial<AppSettings>,
): AppSettings {
  const { disabledProviders: _disabledProviders, ...localPatch } = patch;
  return normalizeStoredAppSettings({
    ...settings,
    ...localPatch,
    ...(hasOwn(patch, "openCodeServerPassword")
      ? { openCodeServerPasswordConfigured: Boolean(patch.openCodeServerPassword?.trim()) }
      : {}),
  });
}

export function getCustomModelsForProvider(
  settings: Pick<AppSettings, CustomModelSettingsKey>,
  provider: ProviderKind,
): readonly string[] {
  return settings[PROVIDER_CUSTOM_MODEL_CONFIG[provider].settingsKey] ?? [];
}

export function getDefaultCustomModelsForProvider(
  defaults: Pick<AppSettings, CustomModelSettingsKey>,
  provider: ProviderKind,
): readonly string[] {
  return defaults[PROVIDER_CUSTOM_MODEL_CONFIG[provider].defaultSettingsKey] ?? [];
}

export function patchCustomModels(
  provider: ProviderKind,
  models: string[],
): Partial<Pick<AppSettings, CustomModelSettingsKey>> {
  return {
    [PROVIDER_CUSTOM_MODEL_CONFIG[provider].settingsKey]: models,
  };
}

export function getCustomModelsByProvider(
  settings: Pick<AppSettings, CustomModelSettingsKey>,
): Record<ProviderKind, readonly string[]> {
  return {
    codex: getCustomModelsForProvider(settings, "codex"),
    claudeAgent: getCustomModelsForProvider(settings, "claudeAgent"),
    cursor: getCustomModelsForProvider(settings, "cursor"),
    devin: getCustomModelsForProvider(settings, "devin"),
    antigravity: getCustomModelsForProvider(settings, "antigravity"),
    grok: getCustomModelsForProvider(settings, "grok"),
    droid: getCustomModelsForProvider(settings, "droid"),
    opencode: getCustomModelsForProvider(settings, "opencode"),
    pi: getCustomModelsForProvider(settings, "pi"),
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    provider,
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));
  const trimmedSelectedModel = selectedModel?.trim().toLowerCase();

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      provider,
      slug,
      name: formatProviderModelOptionName({ provider, slug }),
      isCustom: true,
    });
  }

  const normalizedSelectedModel =
    provider === "cursor"
      ? normalizeCursorModelVariantBaseId(selectedModel)
      : normalizeModelSlug(selectedModel, provider);
  const selectedModelMatchesExistingName =
    typeof trimmedSelectedModel === "string" &&
    options.some((option) => option.name.toLowerCase() === trimmedSelectedModel);
  if (
    normalizedSelectedModel &&
    !seen.has(normalizedSelectedModel) &&
    !selectedModelMatchesExistingName
  ) {
    options.push({
      provider,
      slug: normalizedSelectedModel,
      name: formatProviderModelOptionName({ provider, slug: normalizedSelectedModel }),
      isCustom: true,
    });
  }

  return options;
}

export function mapCatalogModelOptionsToAppModelOptions(
  provider: GitTextGenerationProvider,
  options: ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>,
): AppModelOption[] {
  return options.map((option) => ({
    ...option,
    provider,
    isCustom: option.isCustom ?? false,
  }));
}

export function getGitTextGenerationModelOptions(
  settings: Pick<AppSettings, "textGenerationModel" | "textGenerationProvider"> &
    Partial<Pick<AppSettings, CustomModelSettingsKey>>,
  discoveredOptionsByProvider?: Partial<
    Record<GitTextGenerationProvider, ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>>
  >,
): AppModelOption[] {
  const options = GIT_TEXT_GENERATION_PROVIDERS.flatMap((provider) => {
    const discovered = discoveredOptionsByProvider?.[provider];
    if (discovered !== undefined) {
      return mapCatalogModelOptionsToAppModelOptions(provider, discovered);
    }
    const customModels = settings[PROVIDER_CUSTOM_MODEL_CONFIG[provider].settingsKey] ?? [];
    return getAppModelOptions(provider, customModels);
  });
  const deduped: AppModelOption[] = [];
  const seen = new Set<string>();

  for (const option of options) {
    const key = `${option.provider}:${option.slug}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(option);
  }

  const selectedModel = settings.textGenerationModel?.trim();
  const selectedProvider =
    settings.textGenerationProvider ??
    resolveTextGenerationProvider(selectedModel !== undefined ? { model: selectedModel } : {});
  if (selectedModel && !seen.has(`${selectedProvider}:${selectedModel}`)) {
    deduped.push({
      provider: selectedProvider,
      slug: selectedModel,
      name: formatProviderModelOptionName({ provider: selectedProvider, slug: selectedModel }),
      isCustom: true,
    });
  }

  return deduped;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: Record<ProviderKind, readonly string[]>,
  selectedModel: string | null | undefined,
): string {
  const customModelsForProvider = customModels[provider];
  const options = getAppModelOptions(provider, customModelsForProvider, selectedModel);
  return (
    resolveSelectableModel(provider, selectedModel, options) ?? getDefaultModel(provider) ?? ""
  );
}

export function getCustomModelOptionsByProvider(
  settings: Pick<AppSettings, CustomModelSettingsKey>,
): Record<ProviderKind, ReadonlyArray<ProviderModelOption>> {
  const customModelsByProvider = getCustomModelsByProvider(settings);
  return {
    codex: getAppModelOptions("codex", customModelsByProvider.codex),
    claudeAgent: getAppModelOptions("claudeAgent", customModelsByProvider.claudeAgent),
    cursor: getAppModelOptions("cursor", customModelsByProvider.cursor),
    devin: getAppModelOptions("devin", customModelsByProvider.devin),
    antigravity: getAppModelOptions("antigravity", customModelsByProvider.antigravity),
    grok: getAppModelOptions("grok", customModelsByProvider.grok),
    droid: getAppModelOptions("droid", customModelsByProvider.droid),
    opencode: getAppModelOptions("opencode", customModelsByProvider.opencode),
    pi: getAppModelOptions("pi", customModelsByProvider.pi),
  };
}

export function getProviderStartOptions(
  settings: Pick<
    AppSettings,
    | "claudeBinaryPath"
    | "codexBinaryPath"
    | "codexHomePath"
    | "cursorApiEndpoint"
    | "cursorBinaryPath"
    | "devinBinaryPath"
    | "antigravityBinaryPath"
    | "grokBinaryPath"
    | "droidBinaryPath"
    | "openCodeBinaryPath"
    | "openCodeExperimentalWebSockets"
    | "openCodeServerUrl"
    | "piAgentDir"
    | "piBinaryPath"
  >,
): ProviderStartOptions | undefined {
  const claudeBinaryPath = normalizeProviderBinaryPathOverride(
    "claudeAgent",
    settings.claudeBinaryPath,
  );
  const codexBinaryPath = normalizeProviderBinaryPathOverride("codex", settings.codexBinaryPath);
  const cursorBinaryPath = normalizeProviderBinaryPathOverride("cursor", settings.cursorBinaryPath);
  const devinBinaryPath = normalizeProviderBinaryPathOverride("devin", settings.devinBinaryPath);
  const antigravityBinaryPath = normalizeProviderBinaryPathOverride(
    "antigravity",
    settings.antigravityBinaryPath,
  );
  const grokBinaryPath = normalizeProviderBinaryPathOverride("grok", settings.grokBinaryPath);
  const droidBinaryPath = normalizeProviderBinaryPathOverride("droid", settings.droidBinaryPath);
  const openCodeBinaryPath = normalizeProviderBinaryPathOverride(
    "opencode",
    settings.openCodeBinaryPath,
  );
  const piBinaryPath = normalizeProviderBinaryPathOverride("pi", settings.piBinaryPath);
  const hasOpenCodeStartOptions = Boolean(
    openCodeBinaryPath || settings.openCodeExperimentalWebSockets || settings.openCodeServerUrl,
  );
  const providerOptions: ProviderStartOptions = {
    ...(codexBinaryPath || settings.codexHomePath
      ? {
          codex: {
            ...(codexBinaryPath ? { binaryPath: codexBinaryPath } : {}),
            ...(settings.codexHomePath ? { homePath: settings.codexHomePath } : {}),
          },
        }
      : {}),
    ...(claudeBinaryPath
      ? {
          claudeAgent: {
            binaryPath: claudeBinaryPath,
          },
        }
      : {}),
    ...(cursorBinaryPath || settings.cursorApiEndpoint
      ? {
          cursor: {
            ...(cursorBinaryPath ? { binaryPath: cursorBinaryPath } : {}),
            ...(settings.cursorApiEndpoint ? { apiEndpoint: settings.cursorApiEndpoint } : {}),
          },
        }
      : {}),
    ...(devinBinaryPath
      ? {
          devin: {
            binaryPath: devinBinaryPath,
          },
        }
      : {}),
    ...(antigravityBinaryPath
      ? {
          antigravity: {
            binaryPath: antigravityBinaryPath,
          },
        }
      : {}),
    ...(grokBinaryPath
      ? {
          grok: {
            binaryPath: grokBinaryPath,
          },
        }
      : {}),
    ...(droidBinaryPath
      ? {
          droid: {
            binaryPath: droidBinaryPath,
          },
        }
      : {}),
    ...(hasOpenCodeStartOptions
      ? {
          opencode: {
            ...(openCodeBinaryPath ? { binaryPath: openCodeBinaryPath } : {}),
            ...(settings.openCodeExperimentalWebSockets ? { experimentalWebSockets: true } : {}),
            ...(settings.openCodeServerUrl ? { serverUrl: settings.openCodeServerUrl } : {}),
          },
        }
      : {}),
    ...(piBinaryPath || settings.piAgentDir
      ? {
          pi: {
            ...(piBinaryPath ? { binaryPath: piBinaryPath } : {}),
            ...(settings.piAgentDir ? { agentDir: settings.piAgentDir } : {}),
          },
        }
      : {}),
  };

  return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
}

export function resolveAssistantDeliveryMode(
  settings: Pick<AppSettings, "enableAssistantStreaming">,
): AssistantDeliveryMode {
  return settings.enableAssistantStreaming ? "streaming" : "buffered";
}

// the preference applies only while a turn is live; Ctrl/Cmd+Enter temporarily selects the opposite mode
export function resolveFollowUpDispatchMode(input: {
  behavior: FollowUpBehavior;
  hasLiveTurn: boolean;
  useOppositeBehavior?: boolean;
}): FollowUpBehavior {
  if (!input.hasLiveTurn) {
    return "queue";
  }
  if (!input.useOppositeBehavior) {
    return input.behavior;
  }
  return input.behavior === "queue" ? "steer" : "queue";
}

export function getCustomBinaryPathForProvider(
  settings: Pick<
    AppSettings,
    | "claudeBinaryPath"
    | "codexBinaryPath"
    | "cursorBinaryPath"
    | "devinBinaryPath"
    | "antigravityBinaryPath"
    | "grokBinaryPath"
    | "droidBinaryPath"
    | "openCodeBinaryPath"
    | "piBinaryPath"
  >,
  provider: ProviderKind,
): string {
  switch (provider) {
    case "codex":
      return normalizeProviderBinaryPathOverride(provider, settings.codexBinaryPath);
    case "claudeAgent":
      return normalizeProviderBinaryPathOverride(provider, settings.claudeBinaryPath);
    case "cursor":
      return normalizeProviderBinaryPathOverride(provider, settings.cursorBinaryPath);
    case "devin":
      return normalizeProviderBinaryPathOverride(provider, settings.devinBinaryPath);
    case "antigravity":
      return normalizeProviderBinaryPathOverride(provider, settings.antigravityBinaryPath);
    case "grok":
      return normalizeProviderBinaryPathOverride(provider, settings.grokBinaryPath);
    case "droid":
      return normalizeProviderBinaryPathOverride(provider, settings.droidBinaryPath);
    case "opencode":
      return normalizeProviderBinaryPathOverride(provider, settings.openCodeBinaryPath);
    case "pi":
      return normalizeProviderBinaryPathOverride(provider, settings.piBinaryPath);
  }
}

export function useAppSettings() {
  const queryClient = useQueryClient();
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const [localSettings, setSettings] = useLocalStorage(
    APP_SETTINGS_STORAGE_KEY,
    DEFAULT_APP_SETTINGS,
    AppSettingsSchema,
  );
  const normalizedStoredSettingsRef = useRef(false);
  const serverSettingsMutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const defaults = normalizeAppSettings({
    ...DEFAULT_APP_SETTINGS,
    ...serverSettingsToAppSettings(DEFAULT_SERVER_SETTINGS_VIEW),
  });

  const normalizedLocalSettings = normalizeStoredAppSettings(localSettings);
  const settings = normalizeAppSettings({
    ...normalizedLocalSettings,
    ...(serverSettingsQuery.data ? serverSettingsToAppSettings(serverSettingsQuery.data) : {}),
  });

  useEffect(() => {
    if (normalizedStoredSettingsRef.current) {
      return;
    }
    normalizedStoredSettingsRef.current = true;

    setSettings((previous) => normalizeStoredAppSettings(previous));
  }, [setSettings]);

  useEffect(() => {
    if (!serverSettingsQuery.data || serverSettingsMigrationInFlight) {
      return;
    }
    if (globalThis.localStorage?.getItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY) === "1") {
      return;
    }

    const migrationPatch = buildInitialServerSettingsMigrationPatch(localSettings);
    if (isServerSettingsPatchEmpty(migrationPatch)) {
      globalThis.localStorage?.setItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY, "1");
      return;
    }

    serverSettingsMigrationInFlight = true;
    void ensureNativeApi()
      .server.updateSettings(migrationPatch)
      .then((nextSettings) => {
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        globalThis.localStorage?.setItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY, "1");
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      })
      .finally(() => {
        serverSettingsMigrationInFlight = false;
      });
  }, [localSettings, queryClient, serverSettingsQuery.data]);

  const refreshProvidersAfterEnablementChange = async () => {
    const api = ensureNativeApi();
    await api.server
      .refreshProviders()
      .then((result) => reconcileServerProviderStatuses(queryClient, result.providers))
      .catch(() => queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() }));
    await queryClient
      .invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all })
      .catch(() => undefined);
    await invalidateProviderUsageQueries(queryClient).catch(() => undefined);
  };

  const enqueueServerSettingsMutation = <Result>(
    mutation: () => Promise<Result>,
  ): Promise<Result> => {
    const queued = serverSettingsMutationQueueRef.current.then(
      () => mutation(),
      () => mutation(),
    );
    serverSettingsMutationQueueRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  const updateSettingsAndWait = async (patch: Partial<AppSettings>): Promise<void> => {
    setSettings((prev) => applyLocalAppSettingsPatch(prev, patch));
    await enqueueServerSettingsMutation(async () => {
      const currentServerSettings =
        queryClient.getQueryData<ServerSettingsView>(serverQueryKeys.settings()) ??
        serverSettingsQuery.data;
      const serverPatch = appSettingsPatchToServerSettingsPatch(patch, currentServerSettings);
      if (isServerSettingsPatchEmpty(serverPatch)) {
        return;
      }

      const api = ensureNativeApi();
      try {
        const nextSettings = await api.server.updateSettings(serverPatch);
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        if (hasOwn(patch, "disabledProviders")) {
          await refreshProvidersAfterEnablementChange();
        } else if (touchesProviderDiscoverySettings(patch)) {
          await queryClient
            .invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all })
            .catch(() => undefined);
        }
      } catch {
        await queryClient
          .invalidateQueries({ queryKey: serverQueryKeys.settings() })
          .catch(() => undefined);
        if (touchesProviderDiscoverySettings(patch)) {
          await queryClient
            .invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all })
            .catch(() => undefined);
        }
      }
    });
  };

  const updateSettings = (patch: Partial<AppSettings>): void => {
    void updateSettingsAndWait(patch);
  };

  const resetSettings = async (): Promise<void> => {
    // restore defaults resets preferences, not lifecycle markers — clearing onboarding completion would replay the first-run tour
    const { onboardingCompletedAt: _keepOnboardingCompletedAt, ...resettableDefaults } = defaults;
    setSettings((prev) => ({
      ...DEFAULT_APP_SETTINGS,
      onboardingCompletedAt: prev.onboardingCompletedAt,
    }));
    await enqueueServerSettingsMutation(async () => {
      const currentServerSettings =
        queryClient.getQueryData<ServerSettingsView>(serverQueryKeys.settings()) ??
        serverSettingsQuery.data;
      const serverPatch = appSettingsPatchToServerSettingsPatch(
        resettableDefaults,
        currentServerSettings,
      );
      const providerSettingsChanged = Boolean(
        serverPatch.providers && Object.keys(serverPatch.providers).length > 0,
      );
      if (isServerSettingsPatchEmpty(serverPatch)) {
        return;
      }
      try {
        const nextSettings = await ensureNativeApi().server.updateSettings(serverPatch);
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        if (providerSettingsChanged) {
          await refreshProvidersAfterEnablementChange();
        }
      } catch {
        await queryClient
          .invalidateQueries({ queryKey: serverQueryKeys.settings() })
          .catch(() => undefined);
        if (providerSettingsChanged) {
          await queryClient
            .invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all })
            .catch(() => undefined);
        }
      }
    });
  };

  return {
    settings,
    serverSettings: serverSettingsQuery.data,
    updateSettings,
    updateSettingsAndWait,
    resetSettings,
    defaults,
  } as const;
}
