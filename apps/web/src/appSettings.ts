// FILE: appSettings.ts
// Purpose: Normalizes persisted UI settings and maps them to server/provider options.
// Layer: Web settings state
// Exports: app setting schema, normalization helpers, provider option builders

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Option, Schema, SchemaTransformation } from "effect";
import {
  type AssistantDeliveryMode,
  CodexAccountConfig,
  DesktopAppIcon,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_CODEX_ACCOUNT_ID,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SERVER_SETTINGS_VIEW,
  GIT_TEXT_GENERATION_PROVIDERS,
  type ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  type ProviderDriverKind,
  ProviderInstanceId,
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
import { codexAccountInstanceId } from "@synara/shared/providerInstances";
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

function hasCompletedServerSettingsMigration(): boolean {
  return globalThis.localStorage?.getItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY) === "1";
}

const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const MIN_CHAT_FONT_SIZE_PX = 11;
export const MAX_CHAT_FONT_SIZE_PX = 18;
export const DEFAULT_CHAT_FONT_SIZE_PX = 12;
export const MIN_TERMINAL_FONT_SIZE_PX = 10;
export const MAX_TERMINAL_FONT_SIZE_PX = 22;
export const DEFAULT_TERMINAL_FONT_SIZE_PX = 12;

// Terminal font is a free-form font-family value: the user can type any font
// installed on their machine. An empty value keeps the bundled default stack
// (defined in index.css). The list below is only autocomplete inspiration shown
// in the settings input — it does NOT restrict what can be entered.
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

// gemini was renamed to antigravity, so its list entries carry over. Removed
// providers with no successor subscription (kilo) must not transfer prefs like
// "hidden" onto another provider, so their list entries are dropped. Unknown
// values are dropped too instead of failing the whole settings decode.
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
  // Server-backed first-run marker; see ServerSettings.onboardingCompletedAt.
  onboardingCompletedAt: Schema.NullOr(Schema.String).pipe(withDefaults((): string | null => null)),
  claudeHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
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
  codexAccounts: Schema.Array(CodexAccountConfig).pipe(withDefaults(() => [])),
  selectedCodexAccountId: Schema.String.check(Schema.isMaxLength(64)).pipe(
    withDefaults(() => DEFAULT_CODEX_ACCOUNT_ID),
  ),
  providerInstances: ProviderInstanceConfigMap.pipe(withDefaults(() => ({}))),
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
  // Desktop quit dialog: remember interrupted chats and continue them on the next launch.
  resumeChatsAfterQuit: Schema.Boolean.pipe(withDefaults(() => true)),
  confirmThreadArchive: Schema.Boolean.pipe(withDefaults(() => false)),
  confirmTerminalTabClose: Schema.Boolean.pipe(withDefaults(() => true)),
  diffWordWrap: Schema.Boolean.pipe(withDefaults(() => false)),
  showPullRequestDiffColors: Schema.Boolean.pipe(withDefaults(() => true)),
  // Local-only UI preferences for hiding sidebar surfaces a user doesn't want.
  // `showChatsSection` controls the standalone "Chats" list in the sidebar footer
  // (rootless chats not tied to a project). `showStudioSection` controls the
  // optional Studio tab in the section switcher.
  showChatsSection: Schema.Boolean.pipe(withDefaults(() => true)),
  showStudioSection: Schema.Boolean.pipe(withDefaults(() => true)),
  // Local-only UI preferences for the primary sidebar nav block (New thread, Kanban,
  // Pull requests, Automations): drag-to-reorder order plus explicitly hidden items.
  // An item whose route is currently active stays visible regardless (mirrors
  // `hiddenProviders`), so hiding a surface never strands the user mid-route.
  sidebarNavOrder: Schema.Array(SidebarNavItemId).pipe(
    withDefaults(() => [...DEFAULT_SIDEBAR_NAV_ORDER]),
  ),
  hiddenSidebarNavItems: Schema.Array(SidebarNavItemId).pipe(withDefaults(() => [])),
  // Whether the per-run threads standalone automations create appear in the sidebar
  // (and the surfaces derived from it: Kanban, Activity, project picker). Runs stay
  // listed on the automation's page and findable via search either way.
  showAutomationRunThreads: Schema.Boolean.pipe(withDefaults(() => true)),
  // Local-only UI preferences: which optional sections of the chat Environment panel are
  // shown. The git block (Changes/Worktree/branch/Commit and Push) is always visible; these
  // toggle the sections beneath it via the panel header's gear menu.
  // When false (default), normal chats start with the Environment panel closed. User toggles
  // also write back here so the last explicit open/close survives reloads.
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
  // Started threads: show reasoning effort as a stepped slider card in the composer's
  // model menu instead of radio rows. New chats keep the split model/effort pickers.
  composerEffortSlider: Schema.Boolean.pipe(withDefaults(() => true)),
  autoOpenDevicePane: Schema.Boolean.pipe(withDefaults(() => true)),
  enableProviderUpdateChecks: Schema.Boolean.pipe(withDefaults(() => true)),
  enableNativeFontSmoothing: Schema.Boolean.pipe(withDefaults(getDefaultNativeFontSmoothing)),
  desktopAppIcon: DesktopAppIcon.pipe(withDefaults(() => "default" as const)),
  // Local desktop preference: frameless custom title bar on Windows/Linux.
  // Electron `frame` is fixed at window creation, so the desktop main process also
  // persists this value and a relaunch is required for the live window to match.
  useCustomTitleBar: Schema.Boolean.pipe(withDefaults(() => true)),
  enableTaskCompletionToasts: Schema.Boolean.pipe(withDefaults(() => true)),
  enableSystemTaskCompletionNotifications: Schema.Boolean.pipe(withDefaults(() => true)),
  // Local desktop preference. Native capability/permission state remains owned by Electron.
  // AppSnap is opt-in because enabling its Settings toggle requests macOS
  // Input Monitoring and Screen Recording permissions.
  enableAppSnap: Schema.Boolean.pipe(withDefaults(() => false)),
  appSnapShortcut: AppSnapShortcut.pipe(withDefaults(() => DEFAULT_APP_SNAP_SHORTCUT)),
  // Local desktop preference: play the shutter cue when an AppSnap lands in a composer.
  appSnapPlaySound: Schema.Boolean.pipe(withDefaults(() => true)),
  // Deprecated rename bridge. Normalization migrates this value and then omits the key.
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
  textGenerationProviderInstanceId: Schema.optional(ProviderInstanceId),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
  uiFontFamily: Schema.String.check(Schema.isMaxLength(256)).pipe(withDefaults(() => "")),
  defaultProvider: PersistedProviderKind.pipe(withDefaults(() => "codex" as const)),
  // Local-only UI preference: providers explicitly hidden from the composer picker.
  // The active/locked provider for a thread is always shown regardless, so users
  // never get stuck on a thread whose provider they later chose to hide.
  hiddenProviders: PersistedProviderKindList.pipe(withDefaults(() => [])),
  // Server-backed provider shutdown policy. Unlike `hiddenProviders`, entries here
  // cannot run discovery, health checks, updates, or new turns until re-enabled.
  disabledProviders: PersistedProviderKindList.pipe(withDefaults(() => [])),
  // Local-only UI preference: top-level provider order in Settings and the composer picker.
  providerOrder: PersistedProviderKindList.pipe(withDefaults(() => [...DEFAULT_PROVIDER_ORDER])),
  // Deprecated local-only preference kept for backward-compatible decoding.
  // Model-level hiding caused too many edge cases, so the app now normalizes it away.
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
    (settings.textGenerationProviderInstanceId ?? settings.textGenerationProvider ?? "codex") !==
      (defaults.textGenerationProviderInstanceId ?? defaults.textGenerationProvider ?? "codex") ||
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

export interface GitTextGenerationModelPickerOption {
  readonly key: string;
  readonly value: string;
  readonly instance: ProviderInstanceOption;
  readonly option: AppModelOption;
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

// Droid's ACP catalog is authoritative and rejects unknown slugs. Preserve its
// persisted config for compatibility, but do not offer an editor it cannot honor.
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
  // Free-form font-family text. Only strip characters that can't legitimately
  // appear in a CSS font-family value so the typed name can't break out of the
  // custom property (`;`, `{}`, angle brackets, newlines) or smuggle in other
  // declarations. Whitespace is intentionally preserved here so multi-word names
  // ("Fira Code") remain typable in a controlled input; the CSS resolver trims.
  return (value ?? "").replace(/[;{}<>\n\r]/g, "").slice(0, 256);
}

// Build the CSS font-family stack written to `--terminal-font-family`, or null
// when the bundled default (defined in index.css) should stay in effect.
//
// Accepts either a single family name (`Fira Code`) or a full comma-separated
// stack (`"Fira Code", Menlo, monospace`). Single names are quoted when needed,
// and a `monospace` fallback is appended so an uninstalled font degrades.
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

export type CodexAccountSettings = CodexAccountConfig;

export interface ResolvedCodexAccount {
  readonly id: string;
  readonly label: string;
  readonly homePath: string;
  readonly shadowHomePath: string;
  readonly isDefault: boolean;
}

function isValidCodexAccountId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64;
}

export function normalizeCodexAccounts(
  accounts: ReadonlyArray<CodexAccountSettings>,
): CodexAccountSettings[] {
  const seen = new Set<string>([DEFAULT_CODEX_ACCOUNT_ID]);
  const normalized: CodexAccountSettings[] = [];

  for (const account of accounts) {
    const id = account.id.trim();
    if (!isValidCodexAccountId(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({
      id,
      label: account.label.trim(),
      homePath: account.homePath.trim(),
      shadowHomePath: account.shadowHomePath.trim(),
    });
  }

  return normalized;
}

export function getCodexAccountOptions(
  settings: Pick<AppSettings, "codexHomePath" | "codexAccounts">,
): ResolvedCodexAccount[] {
  return [
    {
      id: DEFAULT_CODEX_ACCOUNT_ID,
      label: "Default",
      homePath: settings.codexHomePath.trim(),
      shadowHomePath: "",
      isDefault: true,
    },
    ...normalizeCodexAccounts(settings.codexAccounts).map((account) => ({
      id: account.id,
      label: account.label || account.id,
      homePath: account.homePath.trim(),
      shadowHomePath: account.shadowHomePath.trim(),
      isDefault: false,
    })),
  ];
}

export function resolveSelectedCodexAccount(
  settings: Pick<AppSettings, "codexHomePath" | "codexAccounts" | "selectedCodexAccountId">,
): ResolvedCodexAccount {
  const accounts = getCodexAccountOptions(settings);
  return (
    accounts.find((account) => account.id === settings.selectedCodexAccountId.trim()) ??
    accounts[0]!
  );
}

export interface ProviderInstanceOption {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
  readonly driver: ProviderKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly supported: true;
}

export interface UnsupportedProviderInstanceOption {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly isDefault: false;
  readonly supported: false;
}

const PROVIDER_INSTANCE_PROVIDER_ORDER = [
  "codex",
  "claudeAgent",
  "cursor",
  "devin",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "pi",
] as const satisfies ReadonlyArray<ProviderKind>;

function providerInstanceIdForCodexAccount(accountId: string): ProviderInstanceId {
  return accountId === DEFAULT_CODEX_ACCOUNT_ID ? "codex" : codexAccountInstanceId(accountId);
}

function defaultProviderInstanceLabel(provider: ProviderKind): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "opencode":
      return "OpenCode";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function fallbackProviderInstanceLabel(instanceId: ProviderInstanceId): string {
  return instanceId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeProviderInstanceConfigPatch(
  existingConfig: unknown,
  patchConfig: Record<string, unknown>,
): Record<string, unknown> {
  const merged = {
    ...(isRecord(existingConfig) ? existingConfig : {}),
    ...patchConfig,
  };
  for (const key of Object.keys(patchConfig)) {
    delete merged[`${key}Redacted`];
  }
  return merged;
}

export function getProviderInstanceOptions(
  settings: Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "providerInstances" | "selectedCodexAccountId"
  >,
): ProviderInstanceOption[] {
  const optionsById = new Map<ProviderInstanceId, ProviderInstanceOption>();

  for (const provider of PROVIDER_INSTANCE_PROVIDER_ORDER) {
    optionsById.set(provider, {
      instanceId: provider,
      provider,
      driver: provider,
      label: defaultProviderInstanceLabel(provider),
      enabled: true,
      isDefault: true,
      supported: true,
    });
  }

  for (const account of getCodexAccountOptions(settings)) {
    const instanceId = providerInstanceIdForCodexAccount(account.id);
    optionsById.set(instanceId, {
      instanceId,
      provider: "codex",
      driver: "codex",
      label: account.label,
      enabled: true,
      isDefault: account.isDefault,
      supported: true,
    });
  }

  for (const [instanceId, raw] of Object.entries(settings.providerInstances)) {
    if (!Schema.is(ProviderKind)(raw.driver)) {
      continue;
    }
    const config = isRecord(raw.config) ? raw.config : {};
    const label = raw.displayName?.trim() || fallbackProviderInstanceLabel(instanceId);
    optionsById.set(instanceId, {
      instanceId,
      provider: raw.driver,
      driver: raw.driver,
      label,
      enabled: raw.enabled !== false && config.enabled !== false,
      isDefault: instanceId === raw.driver,
      supported: true,
    });
  }

  return Array.from(optionsById.values()).toSorted((left, right) => {
    const providerDelta =
      PROVIDER_INSTANCE_PROVIDER_ORDER.indexOf(left.provider) -
      PROVIDER_INSTANCE_PROVIDER_ORDER.indexOf(right.provider);
    if (providerDelta !== 0) {
      return providerDelta;
    }
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });
}

export function getUnsupportedProviderInstanceOptions(
  settings: Pick<AppSettings, "providerInstances">,
): UnsupportedProviderInstanceOption[] {
  return Object.entries(settings.providerInstances)
    .filter(([, raw]) => !Schema.is(ProviderKind)(raw.driver))
    .map(([instanceId, raw]) => {
      const config = isRecord(raw.config) ? raw.config : {};
      return {
        instanceId,
        driver: raw.driver,
        label: raw.displayName?.trim() || fallbackProviderInstanceLabel(instanceId),
        enabled: raw.enabled !== false && config.enabled !== false,
        isDefault: false,
        supported: false,
      } satisfies UnsupportedProviderInstanceOption;
    })
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

export function resolveDefaultProviderInstanceId(
  settings: Pick<AppSettings, "codexAccounts" | "codexHomePath" | "selectedCodexAccountId">,
  provider: ProviderKind,
): ProviderInstanceId {
  if (provider !== "codex") {
    return provider;
  }
  return providerInstanceIdForCodexAccount(resolveSelectedCodexAccount(settings).id);
}

export function resolveSelectableProviderInstanceId(
  settings: Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "providerInstances" | "selectedCodexAccountId"
  >,
  provider: ProviderKind,
  requestedInstanceId?: ProviderInstanceId | null,
): ProviderInstanceId {
  const instances = getProviderInstanceOptions(settings).filter(
    (instance) => instance.provider === provider,
  );
  const requested = requestedInstanceId
    ? instances.find((instance) => instance.instanceId === requestedInstanceId)
    : undefined;
  if (requested?.enabled) {
    return requested.instanceId;
  }

  const defaultInstanceId = resolveDefaultProviderInstanceId(settings, provider);
  const defaultInstance = instances.find((instance) => instance.instanceId === defaultInstanceId);
  if (defaultInstance?.enabled) {
    return defaultInstance.instanceId;
  }

  const enabledInstance = instances.find((instance) => instance.enabled);
  if (enabledInstance) {
    return enabledInstance.instanceId;
  }

  return defaultInstance?.instanceId ?? provider;
}

type CodexAccountLaunchSettingsInput = Pick<
  AppSettings,
  "codexAccounts" | "codexBinaryPath" | "codexHomePath" | "selectedCodexAccountId"
>;

function resolveCodexAccountLaunchSettings(settings: CodexAccountLaunchSettingsInput): {
  readonly binaryPath: string;
  readonly homePath: string;
  readonly shadowHomePath: string;
  readonly accountId: string;
  readonly hasAdditionalAccounts: boolean;
} {
  const selectedAccount = resolveSelectedCodexAccount(settings);
  return {
    binaryPath: normalizeProviderBinaryPathOverride("codex", settings.codexBinaryPath),
    homePath: selectedAccount.homePath || settings.codexHomePath,
    shadowHomePath: selectedAccount.shadowHomePath,
    accountId: selectedAccount.id !== DEFAULT_CODEX_ACCOUNT_ID ? selectedAccount.id : "",
    hasAdditionalAccounts: normalizeCodexAccounts(settings.codexAccounts).length > 0,
  };
}

function resolveCodexLaunchSettingsForInstance(
  settings: CodexAccountLaunchSettingsInput,
  instanceId: ProviderInstanceId | null | undefined,
): ReturnType<typeof resolveCodexAccountLaunchSettings> {
  if (!instanceId) {
    return resolveCodexAccountLaunchSettings(settings);
  }
  const binaryPath = normalizeProviderBinaryPathOverride("codex", settings.codexBinaryPath);
  if (instanceId === "codex") {
    return {
      binaryPath,
      homePath: settings.codexHomePath,
      shadowHomePath: "",
      accountId: "",
      hasAdditionalAccounts: normalizeCodexAccounts(settings.codexAccounts).length > 0,
    };
  }
  const account = getCodexAccountOptions(settings).find(
    (entry) => providerInstanceIdForCodexAccount(entry.id) === instanceId,
  );
  if (!account) {
    return resolveCodexAccountLaunchSettings(settings);
  }
  return {
    binaryPath,
    // A blank account home must stay blank: falling back to the shared default
    // home would make downstream code treat it as the account's own dedicated
    // home and mirror the default account's credentials into it.
    homePath: account.homePath,
    shadowHomePath: account.shadowHomePath,
    accountId: account.id !== DEFAULT_CODEX_ACCOUNT_ID ? account.id : "",
    hasAdditionalAccounts: normalizeCodexAccounts(settings.codexAccounts).length > 0,
  };
}

export function getCodexProviderDiscoveryOptions(settings: CodexAccountLaunchSettingsInput): {
  readonly binaryPath: string | null;
  readonly homePath: string | null;
  readonly shadowHomePath: string | null;
  readonly accountId: string | null;
} {
  const launch = resolveCodexAccountLaunchSettings(settings);
  return {
    binaryPath: launch.binaryPath || null,
    homePath: launch.homePath || null,
    shadowHomePath: launch.shadowHomePath || null,
    accountId: launch.accountId || (launch.hasAdditionalAccounts ? DEFAULT_CODEX_ACCOUNT_ID : null),
  };
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const {
    enableAppshots: legacyEnableAppshots,
    geminiBinaryPath: legacyGeminiBinaryPath,
    customGeminiModels: legacyCustomGeminiModels,
    ...currentSettings
  } = settings;
  const codexAccounts = normalizeCodexAccounts(settings.codexAccounts);
  const selectedCodexAccountId = new Set([
    DEFAULT_CODEX_ACCOUNT_ID,
    ...codexAccounts.map((account) => account.id),
  ]).has(settings.selectedCodexAccountId.trim())
    ? settings.selectedCodexAccountId.trim()
    : DEFAULT_CODEX_ACCOUNT_ID;
  return {
    ...currentSettings,
    enableAppSnap: settings.enableAppSnap || legacyEnableAppshots === true,
    // Password fields are accepted only as write-only update patches. Never retain
    // reusable provider credentials in browser state or localStorage.
    openCodeServerPassword: "",
    claudeBinaryPath: normalizeProviderBinaryPathOverride("claudeAgent", settings.claudeBinaryPath),
    claudeHomePath: settings.claudeHomePath.trim(),
    codexBinaryPath: normalizeProviderBinaryPathOverride("codex", settings.codexBinaryPath),
    codexAccounts,
    selectedCodexAccountId,
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

function serverSettingsToAppSettings(settings: ServerSettingsView): Partial<AppSettings> {
  return {
    claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
    claudeHomePath: settings.providers.claudeAgent.homePath,
    codexBinaryPath: settings.providers.codex.binaryPath,
    codexHomePath: settings.providers.codex.homePath,
    codexAccounts: settings.providers.codex.accounts,
    selectedCodexAccountId: settings.providers.codex.selectedAccountId,
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
    providerInstances: settings.providerInstances,
    textGenerationProvider: settings.textGenerationModelSelection.provider,
    textGenerationProviderInstanceId: settings.textGenerationModelSelection.instanceId,
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
    hasOwn(patch, "codexBinaryPath") ||
    hasOwn(patch, "codexHomePath") ||
    hasOwn(patch, "codexAccounts") ||
    hasOwn(patch, "selectedCodexAccountId") ||
    hasOwn(patch, "devinBinaryPath") ||
    hasOwn(patch, "providerInstances") ||
    hasOwn(patch, "claudeHomePath") ||
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
    return (
      left.length === right.length &&
      left.every((value, index) => serverSettingValuesEqual(value, right[index]))
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftEntries = Object.entries(left);
    const rightRecord = right as Record<string, unknown>;
    return (
      leftEntries.length === Object.keys(rightRecord).length &&
      leftEntries.every(
        ([key, value]) =>
          Object.prototype.hasOwnProperty.call(rightRecord, key) &&
          serverSettingValuesEqual(value, rightRecord[key]),
      )
    );
  }
  return Object.is(left, right);
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
  if (
    hasOwn(patch, "textGenerationModel") ||
    hasOwn(patch, "textGenerationProvider") ||
    hasOwn(patch, "textGenerationProviderInstanceId")
  ) {
    const model = patch.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
    const provider = resolveTextGenerationProvider({
      ...(patch.textGenerationProvider !== undefined
        ? { provider: patch.textGenerationProvider }
        : {}),
      model,
    });
    const instanceId = patch.textGenerationProviderInstanceId?.trim() || provider;
    serverPatch.textGenerationModelSelection = {
      provider,
      instanceId,
      model,
    };
  }
  if (
    hasOwn(patch, "codexBinaryPath") ||
    hasOwn(patch, "codexHomePath") ||
    hasOwn(patch, "codexAccounts") ||
    hasOwn(patch, "selectedCodexAccountId") ||
    hasOwn(patch, "customCodexModels")
  ) {
    const codexAccounts = patch.codexAccounts
      ? normalizeCodexAccounts(patch.codexAccounts)
      : undefined;
    const selectedCodexAccountId = patch.selectedCodexAccountId?.trim();
    providers.codex = {
      ...(hasOwn(patch, "codexBinaryPath") ? { binaryPath: patch.codexBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "codexHomePath") ? { homePath: patch.codexHomePath ?? "" } : {}),
      ...(codexAccounts !== undefined ? { accounts: codexAccounts } : {}),
      ...(selectedCodexAccountId && isValidCodexAccountId(selectedCodexAccountId)
        ? { selectedAccountId: selectedCodexAccountId }
        : {}),
      ...(hasOwn(patch, "customCodexModels")
        ? { customModels: patch.customCodexModels ?? [] }
        : {}),
    };
  }
  if (
    hasOwn(patch, "claudeBinaryPath") ||
    hasOwn(patch, "claudeHomePath") ||
    hasOwn(patch, "customClaudeModels")
  ) {
    providers.claudeAgent = {
      ...(hasOwn(patch, "claudeBinaryPath") ? { binaryPath: patch.claudeBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "claudeHomePath") ? { homePath: patch.claudeHomePath ?? "" } : {}),
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
  if (hasOwn(patch, "providerInstances") && patch.providerInstances !== undefined) {
    serverPatch.providerInstances = patch.providerInstances;
  }
  return serverPatch;
}

function isServerSettingsPatchEmpty(patch: ServerSettingsPatch): boolean {
  return Object.keys(patch).length === 0;
}

export function buildInitialServerSettingsMigrationPatch(
  settings: AppSettings,
): ServerSettingsPatch {
  const patch: Partial<Mutable<AppSettings>> = {};
  const normalizedSettings = normalizeAppSettings(settings);
  const defaults = DEFAULT_APP_SETTINGS;

  for (const key of [
    "claudeBinaryPath",
    "claudeHomePath",
    "codexBinaryPath",
    "codexHomePath",
    "selectedCodexAccountId",
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
    "textGenerationProviderInstanceId",
  ] as const) {
    if (normalizedSettings[key] !== defaults[key]) {
      patch[key] = normalizedSettings[key] as never;
    }
  }

  // Migrate legacy browser-stored passwords once before normalizeAppSettings
  // scrubs them from local state. All subsequent reads use redacted server views.
  if (settings.openCodeServerPassword.trim()) {
    patch.openCodeServerPassword = settings.openCodeServerPassword;
  }

  for (const key of [
    "codexAccounts",
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

  if (Object.keys(normalizedSettings.providerInstances).length > 0) {
    patch.providerInstances = normalizedSettings.providerInstances;
  }

  return appSettingsPatchToServerSettingsPatch(patch);
}

// After the initial server migration, browser storage must never hold plaintext
// secrets: the server materializes sensitive values from the update patch and
// returns them redacted, so the locally persisted copy keeps only the markers.
export function redactProviderInstanceSecretsForClient(
  providerInstances: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  let didChange = false;
  const redacted: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(providerInstances)) {
    let nextInstance = instance;
    if (instance.environment?.some((entry) => entry.sensitive && entry.value)) {
      nextInstance = {
        ...nextInstance,
        environment: instance.environment.map((entry) =>
          entry.sensitive && entry.value
            ? { name: entry.name, value: "", sensitive: true, valueRedacted: true }
            : entry,
        ),
      };
    }
    const config = isRecord(nextInstance.config) ? nextInstance.config : undefined;
    if (config && typeof config.serverPassword === "string" && config.serverPassword) {
      nextInstance = {
        ...nextInstance,
        config: { ...config, serverPassword: "", serverPasswordRedacted: true },
      };
    }
    if (nextInstance !== instance) {
      didChange = true;
    }
    redacted[instanceId] = nextInstance;
  }
  return didChange ? (redacted as ProviderInstanceConfigMap) : providerInstances;
}

function redactAppSettingsSecretsForClient(settings: AppSettings): AppSettings {
  const redactedInstances = redactProviderInstanceSecretsForClient(settings.providerInstances);
  return redactedInstances === settings.providerInstances
    ? settings
    : { ...settings, providerInstances: redactedInstances };
}

export function normalizeStoredAppSettings(settings: AppSettings): AppSettings {
  return redactAppSettingsSecretsForClient({
    ...normalizeAppSettings(settings),
    // Provider enablement belongs to the connected server. Scrub legacy values
    // so a browser profile cannot project one server's shutdown state onto another.
    disabledProviders: [],
  });
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

export function normalizeInitialStoredAppSettingsForServerMigration(
  settings: AppSettings,
  migrationCompleted: boolean,
): AppSettings {
  const normalized = normalizeAppSettings(settings);
  return migrationCompleted ? normalizeStoredAppSettings(normalized) : normalized;
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

export function patchCustomModelsForProviderInstance(
  settings: Pick<AppSettings, "providerInstances"> &
    Partial<
      Pick<AppSettings, "codexAccounts" | "codexHomePath" | "selectedCodexAccountId">
    >,
  instance: Pick<ProviderInstanceOption, "instanceId" | "provider" | "isDefault">,
  models: string[],
): Partial<Pick<AppSettings, CustomModelSettingsKey | "providerInstances">> {
  const existing = settings.providerInstances[instance.instanceId];
  const codexAccount =
    instance.provider === "codex" && !instance.isDefault
      ? (settings.codexAccounts ?? []).find(
          (account) => providerInstanceIdForCodexAccount(account.id) === instance.instanceId,
        )
      : undefined;

  // Store only the custom models here. Launch settings for derived instances
  // (built-in defaults, legacy Codex accounts) are merged in key-by-key at
  // derivation time, so copying them would freeze a snapshot that stops
  // following later edits to the normal provider settings.
  return {
    providerInstances: {
      ...settings.providerInstances,
      [instance.instanceId]: {
        // No enabled flag here: forcing it on would re-enable a disabled
        // derived provider/account through the key-by-key derivation merge.
        ...(existing ?? {
          driver: providerDriverKind(instance.provider),
          ...(codexAccount?.label.trim() ? { displayName: codexAccount.label.trim() } : {}),
        }),
        config: mergeProviderInstanceConfigPatch(existing?.config, { customModels: models }),
      },
    },
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

export function getCustomModelsForProviderInstance(
  settings: Pick<AppSettings, CustomModelSettingsKey | "providerInstances"> &
    Partial<Pick<AppSettings, "codexAccounts" | "codexHomePath">>,
  instance: Pick<ProviderInstanceOption, "instanceId" | "provider" | "isDefault">,
): readonly string[] {
  const raw = settings.providerInstances[instance.instanceId];
  const config = isRecord(raw?.config) ? raw.config : {};
  const instanceCustomModels = config.customModels;
  if (Array.isArray(instanceCustomModels)) {
    return instanceCustomModels.filter((entry): entry is string => typeof entry === "string");
  }
  if (instance.isDefault || instance.instanceId === instance.provider) {
    return getCustomModelsForProvider(settings, instance.provider);
  }
  const isDerivedCodexAccount =
    instance.provider === "codex" &&
    getCodexAccountOptions({
      codexAccounts: settings.codexAccounts ?? [],
      codexHomePath: settings.codexHomePath ?? "",
    }).some(
      (account) =>
        !account.isDefault && providerInstanceIdForCodexAccount(account.id) === instance.instanceId,
    );
  if (isDerivedCodexAccount) {
    return getCustomModelsForProvider(settings, "codex");
  }
  return [];
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

export function getGitTextGenerationPickerOptions(
  settings: Pick<
    AppSettings,
    | CustomModelSettingsKey
    | "codexAccounts"
    | "codexHomePath"
    | "providerInstances"
    | "selectedCodexAccountId"
    | "textGenerationModel"
    | "textGenerationProvider"
    | "textGenerationProviderInstanceId"
  >,
  discoveredOptionsByProviderInstance?: Partial<
    Record<ProviderInstanceId, ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>>
  >,
): GitTextGenerationModelPickerOption[] {
  const selectedModel = settings.textGenerationModel?.trim();
  const selectedProvider =
    settings.textGenerationProvider ??
    resolveTextGenerationProvider(selectedModel !== undefined ? { model: selectedModel } : {});
  const selectedInstanceId = ProviderInstanceId.makeUnsafe(
    settings.textGenerationProviderInstanceId?.trim() || selectedProvider,
  );
  const entries: GitTextGenerationModelPickerOption[] = [];
  const seen = new Set<string>();

  for (const instance of getProviderInstanceOptions(settings)) {
    if (
      !instance.enabled ||
      !GIT_TEXT_GENERATION_PROVIDERS.includes(instance.provider as GitTextGenerationProvider)
    ) {
      continue;
    }
    const selectedModelForInstance =
      selectedModel &&
      instance.provider === selectedProvider &&
      instance.instanceId === selectedInstanceId
        ? selectedModel
        : undefined;
    const selectedModelOption = selectedModelForInstance
      ? getAppModelOptions(instance.provider, [], selectedModelForInstance).find(
          (option) =>
            option.slug === normalizeModelSlug(selectedModelForInstance, instance.provider),
        )
      : undefined;
    const discoveredOptions = discoveredOptionsByProviderInstance?.[instance.instanceId];
    const catalogOptions = discoveredOptions
      ? mapCatalogModelOptionsToAppModelOptions(
          instance.provider as GitTextGenerationProvider,
          discoveredOptions,
        )
      : null;
    const options = catalogOptions
      ? [
          ...catalogOptions,
          ...(selectedModelOption &&
          !catalogOptions.some((option) => option.slug === selectedModelOption.slug)
            ? [selectedModelOption]
            : []),
        ]
      : getAppModelOptions(
          instance.provider,
          getCustomModelsForProviderInstance(settings, instance),
          selectedModelForInstance,
        );
    for (const option of options) {
      const key = `${instance.instanceId}:${option.provider}:${option.slug}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push({ key, value: key, instance, option });
    }
  }

  return entries;
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

function readProviderInstanceConfigValue(
  config: unknown,
  key: string,
): string | boolean | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const value = config[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return typeof value === "boolean" ? value : undefined;
}

function buildProviderStartOptionsFromInstanceConfig(
  provider: ProviderKind,
  config: unknown,
): ProviderStartOptions | undefined {
  const binaryPath = readProviderInstanceConfigValue(config, "binaryPath");
  const homePath = readProviderInstanceConfigValue(config, "homePath");
  switch (provider) {
    case "codex": {
      const shadowHomePath = readProviderInstanceConfigValue(config, "shadowHomePath");
      const accountId = readProviderInstanceConfigValue(config, "accountId");
      return binaryPath || homePath || shadowHomePath || accountId
        ? {
            codex: {
              ...(typeof binaryPath === "string" ? { binaryPath } : {}),
              ...(typeof homePath === "string" ? { homePath } : {}),
              ...(typeof shadowHomePath === "string" ? { shadowHomePath } : {}),
              ...(typeof accountId === "string" ? { accountId } : {}),
            },
          }
        : undefined;
    }
    case "claudeAgent":
      return binaryPath || homePath
        ? {
            claudeAgent: {
              ...(typeof binaryPath === "string" ? { binaryPath } : {}),
              ...(typeof homePath === "string" ? { homePath } : {}),
            },
          }
        : undefined;
    case "cursor": {
      const apiEndpoint = readProviderInstanceConfigValue(config, "apiEndpoint");
      return binaryPath || apiEndpoint
        ? {
            cursor: {
              ...(typeof binaryPath === "string" ? { binaryPath } : {}),
              ...(typeof apiEndpoint === "string" ? { apiEndpoint } : {}),
            },
          }
        : undefined;
    }
    case "devin":
      return typeof binaryPath === "string" ? { devin: { binaryPath } } : undefined;
    case "antigravity":
      return typeof binaryPath === "string" ? { antigravity: { binaryPath } } : undefined;
    case "grok":
      return typeof binaryPath === "string" ? { grok: { binaryPath } } : undefined;
    case "droid":
      return typeof binaryPath === "string" ? { droid: { binaryPath } } : undefined;
    case "opencode": {
      const serverUrl = readProviderInstanceConfigValue(config, "serverUrl");
      const experimentalWebSockets = readProviderInstanceConfigValue(
        config,
        "experimentalWebSockets",
      );
      return binaryPath || serverUrl || experimentalWebSockets === true
        ? {
            opencode: {
              ...(typeof binaryPath === "string" ? { binaryPath } : {}),
              ...(typeof serverUrl === "string" ? { serverUrl } : {}),
              ...(experimentalWebSockets === true ? { experimentalWebSockets: true } : {}),
            },
          }
        : undefined;
    }
    case "pi": {
      const agentDir = readProviderInstanceConfigValue(config, "agentDir");
      return binaryPath || agentDir
        ? {
            pi: {
              ...(typeof binaryPath === "string" ? { binaryPath } : {}),
              ...(typeof agentDir === "string" ? { agentDir } : {}),
            },
          }
        : undefined;
    }
  }
}

function mergeProviderStartOptionsForApp(
  base: ProviderStartOptions | undefined,
  overlay: ProviderStartOptions | undefined,
): ProviderStartOptions | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  return {
    ...base,
    ...overlay,
    ...(base.codex || overlay.codex ? { codex: { ...base.codex, ...overlay.codex } } : {}),
    ...(base.claudeAgent || overlay.claudeAgent
      ? { claudeAgent: { ...base.claudeAgent, ...overlay.claudeAgent } }
      : {}),
    ...(base.cursor || overlay.cursor ? { cursor: { ...base.cursor, ...overlay.cursor } } : {}),
    ...(base.devin || overlay.devin ? { devin: { ...base.devin, ...overlay.devin } } : {}),
    ...(base.antigravity || overlay.antigravity
      ? { antigravity: { ...base.antigravity, ...overlay.antigravity } }
      : {}),
    ...(base.grok || overlay.grok ? { grok: { ...base.grok, ...overlay.grok } } : {}),
    ...(base.droid || overlay.droid ? { droid: { ...base.droid, ...overlay.droid } } : {}),
    ...(base.opencode || overlay.opencode
      ? { opencode: { ...base.opencode, ...overlay.opencode } }
      : {}),
    ...(base.pi || overlay.pi ? { pi: { ...base.pi, ...overlay.pi } } : {}),
  };
}

function omitProviderStartOptions(
  providerOptions: ProviderStartOptions,
  provider: ProviderKind,
): ProviderStartOptions {
  const { [provider]: _omittedProviderOptions, ...remainingProviderOptions } = providerOptions;
  void _omittedProviderOptions;
  return remainingProviderOptions as ProviderStartOptions;
}

export function getProviderStartOptions(
  settings: Pick<
    AppSettings,
    | "claudeBinaryPath"
    | "codexAccounts"
    | "codexBinaryPath"
    | "codexHomePath"
    | "selectedCodexAccountId"
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
  > &
    Partial<Pick<AppSettings, "claudeHomePath" | "providerInstances">>,
  instanceId?: ProviderInstanceId | null | undefined,
): ProviderStartOptions | undefined {
  const claudeBinaryPath = normalizeProviderBinaryPathOverride(
    "claudeAgent",
    settings.claudeBinaryPath,
  );
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
  const codexLaunch = resolveCodexLaunchSettingsForInstance(settings, instanceId);
  const hasOpenCodeStartOptions = Boolean(
    openCodeBinaryPath || settings.openCodeExperimentalWebSockets || settings.openCodeServerUrl,
  );
  const providerOptions: ProviderStartOptions = {
    ...(codexLaunch.binaryPath ||
    codexLaunch.homePath ||
    codexLaunch.shadowHomePath ||
    codexLaunch.accountId ||
    codexLaunch.hasAdditionalAccounts
      ? {
          codex: {
            ...(codexLaunch.binaryPath ? { binaryPath: codexLaunch.binaryPath } : {}),
            ...(codexLaunch.homePath ? { homePath: codexLaunch.homePath } : {}),
            ...(codexLaunch.shadowHomePath ? { shadowHomePath: codexLaunch.shadowHomePath } : {}),
            ...(codexLaunch.accountId ? { accountId: codexLaunch.accountId } : {}),
          },
        }
      : {}),
    ...(claudeBinaryPath || settings.claudeHomePath
      ? {
          claudeAgent: {
            ...(claudeBinaryPath ? { binaryPath: claudeBinaryPath } : {}),
            ...(settings.claudeHomePath ? { homePath: settings.claudeHomePath } : {}),
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

  const providerInstance = instanceId ? settings.providerInstances?.[instanceId] : undefined;
  const instanceOverlay =
    providerInstance && Schema.is(ProviderKind)(providerInstance.driver)
      ? buildProviderStartOptionsFromInstanceConfig(
          providerInstance.driver,
          providerInstance.config,
        )
      : undefined;
  // An explicitly configured instance is a complete launch boundary for its
  // driver. Do not inherit the legacy/default driver's paths, account, or
  // connection settings into another instance that happens to use it.
  const providerOptionsBase =
    providerInstance &&
    Schema.is(ProviderKind)(providerInstance.driver) &&
    instanceId !== providerInstance.driver
      ? omitProviderStartOptions(providerOptions, providerInstance.driver)
      : providerOptions;
  const mergedProviderOptions = mergeProviderStartOptionsForApp(
    providerOptionsBase,
    instanceOverlay,
  );
  return mergedProviderOptions && Object.keys(mergedProviderOptions).length > 0
    ? mergedProviderOptions
    : undefined;
}

/**
 * Single source of truth for mapping the streaming preference onto the orchestration
 * delivery mode used when dispatching turns (composer, chat, and kanban share this).
 */
export function resolveAssistantDeliveryMode(
  settings: Pick<AppSettings, "enableAssistantStreaming">,
): AssistantDeliveryMode {
  return settings.enableAssistantStreaming ? "streaming" : "buffered";
}

/**
 * Resolves the dispatch mode for a composer submit. The preference applies only
 * while a turn is live; Ctrl/Cmd+Enter temporarily selects the opposite mode.
 */
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

export function getCustomBinaryPathForProviderInstance(
  settings: Parameters<typeof getProviderStartOptions>[0],
  provider: ProviderKind,
  instanceId: ProviderInstanceId,
): string {
  const providerOptions = getProviderStartOptions(settings, instanceId)?.[provider];
  const binaryPath = isRecord(providerOptions) ? providerOptions.binaryPath : undefined;
  return typeof binaryPath === "string"
    ? normalizeProviderBinaryPathOverride(provider, binaryPath)
    : "";
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
  const pendingServerSettingsMigrationPatchRef = useRef<ServerSettingsPatch | null>(null);

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

    setSettings((previous) => {
      const normalized = normalizeAppSettings(previous);
      const migrationCompleted = hasCompletedServerSettingsMigration();
      if (!migrationCompleted) {
        pendingServerSettingsMigrationPatchRef.current =
          buildInitialServerSettingsMigrationPatch(normalized);
      }
      // Legacy localStorage may be the only remaining plaintext source until
      // the server confirms migration; redact it immediately after that write.
      return normalizeInitialStoredAppSettingsForServerMigration(normalized, migrationCompleted);
    });
  }, [setSettings]);

  useEffect(() => {
    if (!serverSettingsQuery.data || serverSettingsMigrationInFlight) {
      return;
    }
    if (hasCompletedServerSettingsMigration()) {
      return;
    }

    const migrationPatch =
      pendingServerSettingsMigrationPatchRef.current ??
      buildInitialServerSettingsMigrationPatch(localSettings);
    if (isServerSettingsPatchEmpty(migrationPatch)) {
      globalThis.localStorage?.setItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY, "1");
      pendingServerSettingsMigrationPatchRef.current = null;
      setSettings((previous) => normalizeStoredAppSettings(previous));
      return;
    }

    serverSettingsMigrationInFlight = true;
    void ensureNativeApi()
      .server.updateSettings(migrationPatch)
      .then((nextSettings) => {
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        globalThis.localStorage?.setItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY, "1");
        pendingServerSettingsMigrationPatchRef.current = null;
        // The server now owns the migrated secrets; drop the local plaintext.
        setSettings((previous) => normalizeStoredAppSettings(previous));
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      })
      .finally(() => {
        serverSettingsMigrationInFlight = false;
      });
  }, [localSettings, queryClient, serverSettingsQuery.data, setSettings]);

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
    const providerInstancesBeforePatch =
      patch.providerInstances !== undefined ? localSettings.providerInstances : undefined;
    // The pending migration ref retains the one plaintext snapshot that still
    // needs to reach the server; browser state and storage stay redacted.
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
        if (providerInstancesBeforePatch !== undefined) {
          setSettings((prev) => {
            const restored = normalizeAppSettings({
              ...prev,
              providerInstances: providerInstancesBeforePatch,
            });
            return redactAppSettingsSecretsForClient(restored);
          });
        }
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
    // "Restore defaults" resets preferences, not lifecycle markers: clearing the
    // onboarding completion timestamp would replay the first-run tour on the next launch.
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
