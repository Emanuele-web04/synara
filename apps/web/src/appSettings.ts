// FILE: appSettings.ts
// Purpose: Normalizes persisted UI settings and maps them to server/provider options.
// Layer: Web settings state
// Exports: app setting schema, normalization helpers, provider option builders

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import {
  type AssistantDeliveryMode,
  CodexAccountConfig,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_CODEX_ACCOUNT_ID,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceConfigMap,
  type ProviderDriverKind,
  ProviderInstanceId,
  TrimmedNonEmptyString,
  ProviderKind,
  type ProviderStartOptions,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  getDefaultModel,
  getModelOptions,
  normalizeModelSlug,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import {
  codexAccountInstanceId,
  inferLegacyProviderKindFromModelSelection,
} from "@t3tools/shared/providerInstances";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { EnvMode } from "./components/BranchToolbar.logic";
import { formatProviderModelOptionName, type ProviderModelOption } from "./providerModelOptions";
import {
  DEFAULT_PROVIDER_ORDER,
  normalizeHiddenProviders,
  normalizeProviderOrder,
} from "./providerOrdering";
import { ensureNativeApi } from "./nativeApi";
import { providerDiscoveryQueryKeys } from "./lib/providerDiscoveryReactQuery";
import { serverQueryKeys, serverSettingsQueryOptions } from "./lib/serverReactQuery";
import {
  DEFAULT_UI_DENSITY,
  UI_DENSITY_MODES,
  normalizeUiDensity as normalizeUiDensityValue,
} from "./lib/appDensity";

const APP_SETTINGS_STORAGE_KEY = "synara:app-settings:v1";
const SERVER_SETTINGS_MIGRATION_STORAGE_KEY = "t3code:server-settings-migrated:v1";
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
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const UiDensity = Schema.Literals(UI_DENSITY_MODES);
export type UiDensity = typeof UiDensity.Type;
export { DEFAULT_UI_DENSITY };

export function getDefaultNativeFontSmoothing(platform = globalThis.navigator?.platform ?? "") {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

type CustomModelSettingsKey =
  | "customCodexModels"
  | "customClaudeModels"
  | "customCursorModels"
  | "customGeminiModels"
  | "customGrokModels"
  | "customKiloModels"
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
  gemini: new Set(getModelOptions("gemini").map((option) => option.slug)),
  grok: new Set(getModelOptions("grok").map((option) => option.slug)),
  kilo: new Set(getModelOptions("kilo").map((option) => option.slug)),
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

export const FavoriteModelSetting = Schema.Struct({
  provider: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type FavoriteModelSetting = typeof FavoriteModelSetting.Type;

export const AppSettingsSchema = Schema.Struct({
  claudeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  claudeHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  uiDensity: UiDensity.pipe(withDefaults(() => DEFAULT_UI_DENSITY)),
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
  geminiBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  grokBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  kiloBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  kiloServerUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  kiloServerPassword: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  openCodeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  piBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  piAgentDir: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  openCodeServerUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  openCodeServerPassword: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    withDefaults(() => ""),
  ),
  openCodeExperimentalWebSockets: Schema.Boolean.pipe(withDefaults(() => false)),
  defaultThreadEnvMode: EnvMode.pipe(withDefaults(() => "local" as const satisfies EnvMode)),
  confirmThreadDelete: Schema.Boolean.pipe(withDefaults(() => true)),
  confirmThreadArchive: Schema.Boolean.pipe(withDefaults(() => false)),
  confirmTerminalTabClose: Schema.Boolean.pipe(withDefaults(() => true)),
  diffWordWrap: Schema.Boolean.pipe(withDefaults(() => false)),
  // Local-only UI preferences for hiding sidebar surfaces a user doesn't want.
  // `showChatsSection` controls the standalone "Chats" list in the sidebar footer
  // (rootless chats not tied to a project). `showWorkspaceSection` controls the
  // "Workspace" tab in the section switcher. The "Threads"/Projects tab is always
  // shown, so the switcher is hidden by default and only appears when Workspace is
  // enabled in Settings (see the sidebar segmented picker).
  showChatsSection: Schema.Boolean.pipe(withDefaults(() => true)),
  showWorkspaceSection: Schema.Boolean.pipe(withDefaults(() => false)),
  // Local-only UI preferences: which optional sections of the chat Environment panel are
  // shown. The git block (Changes/Worktree/branch/Commit and Push) is always visible; these
  // toggle the sections beneath it via the panel header's gear menu.
  showEnvironmentUsage: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentRepository: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentEditor: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentRecap: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentPinned: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentMarkers: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentInstructions: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentNotepad: Schema.Boolean.pipe(withDefaults(() => true)),
  enableAssistantStreaming: Schema.Boolean.pipe(withDefaults(() => true)),
  enableProviderUpdateChecks: Schema.Boolean.pipe(withDefaults(() => true)),
  enableNativeFontSmoothing: Schema.Boolean.pipe(withDefaults(getDefaultNativeFontSmoothing)),
  enableTaskCompletionToasts: Schema.Boolean.pipe(withDefaults(() => true)),
  enableSystemTaskCompletionNotifications: Schema.Boolean.pipe(withDefaults(() => true)),
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
  customGeminiModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customGrokModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customKiloModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customOpenCodeModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  customPiModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  favorites: Schema.Array(FavoriteModelSetting).pipe(withDefaults(() => [])),
  textGenerationProvider: ProviderKind.pipe(withDefaults(() => "codex" as const)),
  textGenerationProviderInstanceId: Schema.optional(ProviderInstanceId),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
  uiFontFamily: Schema.String.check(Schema.isMaxLength(256)).pipe(withDefaults(() => "")),
  defaultProvider: ProviderKind.pipe(withDefaults(() => "codex" as const)),
  // Local-only UI preference: providers explicitly hidden from the composer picker.
  // The active/locked provider for a thread is always shown regardless, so users
  // never get stuck on a thread whose provider they later chose to hide.
  hiddenProviders: Schema.Array(ProviderKind).pipe(withDefaults(() => [])),
  // Local-only UI preference: top-level provider order in Settings and the composer picker.
  providerOrder: Schema.Array(ProviderKind).pipe(withDefaults(() => [...DEFAULT_PROVIDER_ORDER])),
  // Deprecated local-only preference kept for backward-compatible decoding.
  // Model-level hiding caused too many edge cases, so the app now normalizes it away.
  hiddenModels: Schema.Array(
    Schema.Struct({
      provider: ProviderKind,
      slug: Schema.String,
    }),
  ).pipe(withDefaults(() => [])),
});
export type AppSettings = typeof AppSettingsSchema.Type;

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
const GIT_TEXT_GENERATION_PROVIDERS = new Set<ProviderKind>([
  "codex",
  "claudeAgent",
  "kilo",
  "opencode",
]);

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
  gemini: {
    provider: "gemini",
    settingsKey: "customGeminiModels",
    defaultSettingsKey: "customGeminiModels",
    title: "Gemini",
    description: "Save additional Gemini model slugs for the picker and `/model` command.",
    placeholder: "your-gemini-model-slug",
    example: "gemini-3.5-pro-preview",
  },
  grok: {
    provider: "grok",
    settingsKey: "customGrokModels",
    defaultSettingsKey: "customGrokModels",
    title: "Grok",
    description: "Save additional Grok model slugs for the picker and `/model` command.",
    placeholder: "your-grok-model-slug",
    example: "grok-build-0.1",
  },
  kilo: {
    provider: "kilo",
    settingsKey: "customKiloModels",
    defaultSettingsKey: "customKiloModels",
    title: "Kilo",
    description: "Save additional Kilo model slugs for the picker and provider runtime.",
    placeholder: "provider/model",
    example: "kilo/kilo-auto/free",
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
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
] as const satisfies ReadonlyArray<ProviderKind>;

function providerInstanceId(value: string): ProviderInstanceId {
  return value as ProviderInstanceId;
}

function providerDriverKind(value: string): ProviderDriverKind {
  return value as ProviderDriverKind;
}

function providerInstanceIdForCodexAccount(accountId: string): ProviderInstanceId {
  return accountId === DEFAULT_CODEX_ACCOUNT_ID
    ? providerInstanceId("codex")
    : codexAccountInstanceId(accountId);
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
    const instanceId = providerInstanceId(provider);
    optionsById.set(instanceId, {
      instanceId,
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
    const typedInstanceId = providerInstanceId(instanceId);
    const config = isRecord(raw.config) ? raw.config : {};
    const label = raw.displayName?.trim() || fallbackProviderInstanceLabel(typedInstanceId);
    optionsById.set(typedInstanceId, {
      instanceId: typedInstanceId,
      provider: raw.driver,
      driver: raw.driver,
      label,
      enabled: raw.enabled !== false && config.enabled !== false,
      isDefault: String(typedInstanceId) === String(raw.driver),
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
      const typedInstanceId = providerInstanceId(instanceId);
      const config = isRecord(raw.config) ? raw.config : {};
      return {
        instanceId: typedInstanceId,
        driver: raw.driver,
        label: raw.displayName?.trim() || fallbackProviderInstanceLabel(typedInstanceId),
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
    return providerInstanceId(provider);
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

  return defaultInstance?.instanceId ?? providerInstanceId(provider);
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

function normalizeFavoriteModels(
  favorites: ReadonlyArray<FavoriteModelSetting>,
): FavoriteModelSetting[] {
  const result: FavoriteModelSetting[] = [];
  const seen = new Set<string>();
  for (const favorite of favorites) {
    const model = favorite.model.trim();
    if (!model) {
      continue;
    }
    const key = `${favorite.provider}\u0000${model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      provider: favorite.provider,
      model,
    });
  }
  return result;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const codexAccounts = normalizeCodexAccounts(settings.codexAccounts);
  const selectedCodexAccountId = new Set([
    DEFAULT_CODEX_ACCOUNT_ID,
    ...codexAccounts.map((account) => account.id),
  ]).has(settings.selectedCodexAccountId.trim())
    ? settings.selectedCodexAccountId.trim()
    : DEFAULT_CODEX_ACCOUNT_ID;

  return {
    ...settings,
    claudeBinaryPath: normalizeProviderBinaryPathOverride("claudeAgent", settings.claudeBinaryPath),
    claudeHomePath: settings.claudeHomePath.trim(),
    codexBinaryPath: normalizeProviderBinaryPathOverride("codex", settings.codexBinaryPath),
    codexAccounts,
    selectedCodexAccountId,
    cursorBinaryPath: normalizeProviderBinaryPathOverride("cursor", settings.cursorBinaryPath),
    geminiBinaryPath: normalizeProviderBinaryPathOverride("gemini", settings.geminiBinaryPath),
    grokBinaryPath: normalizeProviderBinaryPathOverride("grok", settings.grokBinaryPath),
    kiloBinaryPath: normalizeProviderBinaryPathOverride("kilo", settings.kiloBinaryPath),
    openCodeBinaryPath: normalizeProviderBinaryPathOverride(
      "opencode",
      settings.openCodeBinaryPath,
    ),
    piBinaryPath: normalizeProviderBinaryPathOverride("pi", settings.piBinaryPath),
    uiDensity: normalizeUiDensityValue(settings.uiDensity),
    chatFontSizePx: normalizeChatFontSizePx(settings.chatFontSizePx),
    terminalFontSizePx: normalizeTerminalFontSizePx(settings.terminalFontSizePx),
    terminalFontFamily: normalizeTerminalFontFamily(settings.terminalFontFamily),
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customClaudeModels: normalizeCustomModelSlugs(settings.customClaudeModels, "claudeAgent"),
    customCursorModels: normalizeCustomModelSlugs(settings.customCursorModels, "cursor"),
    customGeminiModels: normalizeCustomModelSlugs(settings.customGeminiModels, "gemini"),
    customGrokModels: normalizeCustomModelSlugs(settings.customGrokModels, "grok"),
    customKiloModels: normalizeCustomModelSlugs(settings.customKiloModels, "kilo"),
    customOpenCodeModels: normalizeCustomModelSlugs(settings.customOpenCodeModels, "opencode"),
    customPiModels: normalizeCustomModelSlugs(settings.customPiModels, "pi"),
    favorites: normalizeFavoriteModels(settings.favorites),
    hiddenProviders: normalizeHiddenProviders(settings.hiddenProviders),
    providerOrder: normalizeProviderOrder(settings.providerOrder),
    hiddenModels: [],
  };
}

function serverSettingsToAppSettings(settings: ServerSettings): Partial<AppSettings> {
  const textGenerationInstanceId = settings.textGenerationModelSelection.instanceId;
  const configuredTextGenerationDriver =
    settings.providerInstances[textGenerationInstanceId]?.driver;
  const textGenerationProvider = Schema.is(ProviderKind)(configuredTextGenerationDriver)
    ? configuredTextGenerationDriver
    : inferLegacyProviderKindFromModelSelection(settings.textGenerationModelSelection);
  return {
    claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
    claudeHomePath: settings.providers.claudeAgent.homePath,
    codexBinaryPath: settings.providers.codex.binaryPath,
    codexHomePath: settings.providers.codex.homePath,
    codexAccounts: settings.providers.codex.accounts,
    selectedCodexAccountId: settings.providers.codex.selectedAccountId,
    cursorApiEndpoint: settings.providers.cursor.apiEndpoint,
    cursorBinaryPath: settings.providers.cursor.binaryPath,
    defaultThreadEnvMode: settings.defaultThreadEnvMode,
    enableAssistantStreaming: settings.enableAssistantStreaming,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
    geminiBinaryPath: settings.providers.gemini.binaryPath,
    grokBinaryPath: settings.providers.grok.binaryPath,
    kiloBinaryPath: settings.providers.kilo.binaryPath,
    kiloServerPassword: settings.providers.kilo.serverPassword,
    kiloServerUrl: settings.providers.kilo.serverUrl,
    openCodeBinaryPath: settings.providers.opencode.binaryPath,
    openCodeExperimentalWebSockets: settings.providers.opencode.experimentalWebSockets,
    openCodeServerPassword: settings.providers.opencode.serverPassword,
    openCodeServerUrl: settings.providers.opencode.serverUrl,
    piAgentDir: settings.providers.pi.agentDir,
    piBinaryPath: settings.providers.pi.binaryPath,
    customCodexModels: settings.providers.codex.customModels,
    customClaudeModels: settings.providers.claudeAgent.customModels,
    customCursorModels: settings.providers.cursor.customModels,
    customGeminiModels: settings.providers.gemini.customModels,
    customGrokModels: settings.providers.grok.customModels,
    customKiloModels: settings.providers.kilo.customModels,
    customOpenCodeModels: settings.providers.opencode.customModels,
    customPiModels: settings.providers.pi.customModels,
    providerInstances: settings.providerInstances,
    textGenerationProvider,
    textGenerationProviderInstanceId: textGenerationInstanceId,
    textGenerationModel: settings.textGenerationModelSelection.model,
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
    hasOwn(patch, "providerInstances") ||
    hasOwn(patch, "claudeHomePath") ||
    hasOwn(patch, "kiloBinaryPath") ||
    hasOwn(patch, "kiloServerPassword") ||
    hasOwn(patch, "kiloServerUrl") ||
    hasOwn(patch, "openCodeBinaryPath") ||
    hasOwn(patch, "openCodeExperimentalWebSockets") ||
    hasOwn(patch, "openCodeServerPassword") ||
    hasOwn(patch, "openCodeServerUrl") ||
    hasOwn(patch, "piAgentDir")
  );
}

function appSettingsPatchToServerSettingsPatch(patch: Partial<AppSettings>): ServerSettingsPatch {
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
    const instanceId = providerInstanceId(
      patch.textGenerationProviderInstanceId?.trim() || provider,
    );
    serverPatch.textGenerationModelSelection = {
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
  if (hasOwn(patch, "geminiBinaryPath") || hasOwn(patch, "customGeminiModels")) {
    providers.gemini = {
      ...(hasOwn(patch, "geminiBinaryPath") ? { binaryPath: patch.geminiBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "customGeminiModels")
        ? { customModels: patch.customGeminiModels ?? [] }
        : {}),
    };
  }
  if (hasOwn(patch, "grokBinaryPath") || hasOwn(patch, "customGrokModels")) {
    providers.grok = {
      ...(hasOwn(patch, "grokBinaryPath") ? { binaryPath: patch.grokBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "customGrokModels") ? { customModels: patch.customGrokModels ?? [] } : {}),
    };
  }
  if (
    hasOwn(patch, "kiloBinaryPath") ||
    hasOwn(patch, "kiloServerUrl") ||
    hasOwn(patch, "kiloServerPassword") ||
    hasOwn(patch, "customKiloModels")
  ) {
    providers.kilo = {
      ...(hasOwn(patch, "kiloBinaryPath") ? { binaryPath: patch.kiloBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "kiloServerUrl") ? { serverUrl: patch.kiloServerUrl ?? "" } : {}),
      ...(hasOwn(patch, "kiloServerPassword")
        ? { serverPassword: patch.kiloServerPassword ?? "" }
        : {}),
      ...(hasOwn(patch, "customKiloModels") ? { customModels: patch.customKiloModels ?? [] } : {}),
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

function buildInitialServerSettingsMigrationPatch(settings: AppSettings): ServerSettingsPatch {
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
    "geminiBinaryPath",
    "grokBinaryPath",
    "kiloBinaryPath",
    "kiloServerPassword",
    "kiloServerUrl",
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

  for (const key of [
    "codexAccounts",
    "customCodexModels",
    "customClaudeModels",
    "customCursorModels",
    "customGeminiModels",
    "customGrokModels",
    "customKiloModels",
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

export function normalizeStoredAppSettings(settings: AppSettings): AppSettings {
  return normalizeAppSettings(settings);
}

export function getCustomModelsForProvider(
  settings: Pick<AppSettings, CustomModelSettingsKey>,
  provider: ProviderKind,
): readonly string[] {
  return settings[PROVIDER_CUSTOM_MODEL_CONFIG[provider].settingsKey];
}

export function getDefaultCustomModelsForProvider(
  defaults: Pick<AppSettings, CustomModelSettingsKey>,
  provider: ProviderKind,
): readonly string[] {
  return defaults[PROVIDER_CUSTOM_MODEL_CONFIG[provider].defaultSettingsKey];
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
  settings: Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "providerInstances" | "selectedCodexAccountId"
  >,
  instance: Pick<ProviderInstanceOption, "instanceId" | "provider" | "isDefault">,
  models: string[],
): Partial<Pick<AppSettings, CustomModelSettingsKey | "providerInstances">> {
  const existing = settings.providerInstances[instance.instanceId];
  const codexAccount =
    instance.provider === "codex" && !instance.isDefault
      ? getCodexAccountOptions(settings).find(
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
          ...(codexAccount?.label ? { displayName: codexAccount.label } : {}),
        }),
        config: {
          ...(isRecord(existing?.config) ? existing.config : {}),
          customModels: models,
        },
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
    gemini: getCustomModelsForProvider(settings, "gemini"),
    grok: getCustomModelsForProvider(settings, "grok"),
    kilo: getCustomModelsForProvider(settings, "kilo"),
    opencode: getCustomModelsForProvider(settings, "opencode"),
    pi: getCustomModelsForProvider(settings, "pi"),
  };
}

export function getCustomModelsForProviderInstance(
  settings: Pick<AppSettings, CustomModelSettingsKey | "providerInstances">,
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

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
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

export function getGitTextGenerationModelOptions(
  settings: Pick<
    AppSettings,
    | "customCodexModels"
    | "customClaudeModels"
    | "customKiloModels"
    | "customOpenCodeModels"
    | "textGenerationModel"
    | "textGenerationProvider"
  >,
): AppModelOption[] {
  const options = [
    ...getAppModelOptions("codex", settings.customCodexModels),
    ...getAppModelOptions("claudeAgent", settings.customClaudeModels),
    ...getAppModelOptions("kilo", settings.customKiloModels),
    ...getAppModelOptions("opencode", settings.customOpenCodeModels),
  ];
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
): GitTextGenerationModelPickerOption[] {
  const selectedModel = settings.textGenerationModel?.trim();
  const selectedProvider =
    settings.textGenerationProvider ??
    resolveTextGenerationProvider(selectedModel !== undefined ? { model: selectedModel } : {});
  const selectedInstanceId = providerInstanceId(
    settings.textGenerationProviderInstanceId?.trim() || selectedProvider,
  );
  const entries: GitTextGenerationModelPickerOption[] = [];
  const seen = new Set<string>();

  for (const instance of getProviderInstanceOptions(settings)) {
    if (!instance.enabled || !GIT_TEXT_GENERATION_PROVIDERS.has(instance.provider)) {
      continue;
    }
    const selectedModelForInstance =
      selectedModel &&
      instance.provider === selectedProvider &&
      instance.instanceId === selectedInstanceId
        ? selectedModel
        : undefined;
    const options = getAppModelOptions(
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
      entries.push({
        key,
        value: key,
        instance,
        option,
      });
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
    gemini: getAppModelOptions("gemini", customModelsByProvider.gemini),
    grok: getAppModelOptions("grok", customModelsByProvider.grok),
    kilo: getAppModelOptions("kilo", customModelsByProvider.kilo),
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
    case "gemini":
      return typeof binaryPath === "string" ? { gemini: { binaryPath } } : undefined;
    case "grok":
      return typeof binaryPath === "string" ? { grok: { binaryPath } } : undefined;
    case "kilo": {
      const serverUrl = readProviderInstanceConfigValue(config, "serverUrl");
      const serverPassword = readProviderInstanceConfigValue(config, "serverPassword");
      return binaryPath || serverUrl || serverPassword
        ? {
            kilo: {
              ...(typeof binaryPath === "string" ? { binaryPath } : {}),
              ...(typeof serverUrl === "string" ? { serverUrl } : {}),
              ...(typeof serverPassword === "string" ? { serverPassword } : {}),
            },
          }
        : undefined;
    }
    case "opencode": {
      const serverUrl = readProviderInstanceConfigValue(config, "serverUrl");
      const serverPassword = readProviderInstanceConfigValue(config, "serverPassword");
      const experimentalWebSockets = readProviderInstanceConfigValue(
        config,
        "experimentalWebSockets",
      );
      return binaryPath || serverUrl || serverPassword || experimentalWebSockets === true
        ? {
            opencode: {
              ...(typeof binaryPath === "string" ? { binaryPath } : {}),
              ...(typeof serverUrl === "string" ? { serverUrl } : {}),
              ...(typeof serverPassword === "string" ? { serverPassword } : {}),
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
    ...(base.gemini || overlay.gemini ? { gemini: { ...base.gemini, ...overlay.gemini } } : {}),
    ...(base.grok || overlay.grok ? { grok: { ...base.grok, ...overlay.grok } } : {}),
    ...(base.kilo || overlay.kilo ? { kilo: { ...base.kilo, ...overlay.kilo } } : {}),
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
    | "geminiBinaryPath"
    | "grokBinaryPath"
    | "kiloBinaryPath"
    | "kiloServerPassword"
    | "kiloServerUrl"
    | "openCodeBinaryPath"
    | "openCodeExperimentalWebSockets"
    | "openCodeServerPassword"
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
  const geminiBinaryPath = normalizeProviderBinaryPathOverride("gemini", settings.geminiBinaryPath);
  const grokBinaryPath = normalizeProviderBinaryPathOverride("grok", settings.grokBinaryPath);
  const kiloBinaryPath = normalizeProviderBinaryPathOverride("kilo", settings.kiloBinaryPath);
  const openCodeBinaryPath = normalizeProviderBinaryPathOverride(
    "opencode",
    settings.openCodeBinaryPath,
  );
  const piBinaryPath = normalizeProviderBinaryPathOverride("pi", settings.piBinaryPath);
  const codexLaunch = resolveCodexLaunchSettingsForInstance(settings, instanceId);
  const hasOpenCodeStartOptions = Boolean(
    openCodeBinaryPath ||
    settings.openCodeExperimentalWebSockets ||
    settings.openCodeServerUrl ||
    settings.openCodeServerPassword,
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
    ...(geminiBinaryPath
      ? {
          gemini: {
            binaryPath: geminiBinaryPath,
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
    ...(kiloBinaryPath || settings.kiloServerUrl || settings.kiloServerPassword
      ? {
          kilo: {
            ...(kiloBinaryPath ? { binaryPath: kiloBinaryPath } : {}),
            ...(settings.kiloServerUrl ? { serverUrl: settings.kiloServerUrl } : {}),
            ...(settings.kiloServerPassword ? { serverPassword: settings.kiloServerPassword } : {}),
          },
        }
      : {}),
    ...(hasOpenCodeStartOptions
      ? {
          opencode: {
            ...(openCodeBinaryPath ? { binaryPath: openCodeBinaryPath } : {}),
            ...(settings.openCodeExperimentalWebSockets ? { experimentalWebSockets: true } : {}),
            ...(settings.openCodeServerUrl ? { serverUrl: settings.openCodeServerUrl } : {}),
            ...(settings.openCodeServerPassword
              ? { serverPassword: settings.openCodeServerPassword }
              : {}),
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
  const providerOptionsBase =
    providerInstance && Schema.is(ProviderKind)(providerInstance.driver)
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

export function getCustomBinaryPathForProvider(
  settings: Pick<
    AppSettings,
    | "claudeBinaryPath"
    | "codexBinaryPath"
    | "cursorBinaryPath"
    | "geminiBinaryPath"
    | "grokBinaryPath"
    | "kiloBinaryPath"
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
    case "gemini":
      return normalizeProviderBinaryPathOverride(provider, settings.geminiBinaryPath);
    case "grok":
      return normalizeProviderBinaryPathOverride(provider, settings.grokBinaryPath);
    case "kilo":
      return normalizeProviderBinaryPathOverride(provider, settings.kiloBinaryPath);
    case "opencode":
      return normalizeProviderBinaryPathOverride(provider, settings.openCodeBinaryPath);
    case "pi":
      return normalizeProviderBinaryPathOverride(provider, settings.piBinaryPath);
  }
}

function getProviderOptionsBinaryPath(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): string {
  const options = providerOptions?.[provider];
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return "";
  }
  const binaryPath = (options as Record<string, unknown>).binaryPath;
  return normalizeProviderBinaryPathOverride(
    provider,
    typeof binaryPath === "string" ? binaryPath : undefined,
  );
}

export function getCustomBinaryPathForProviderInstance(
  settings: Parameters<typeof getProviderStartOptions>[0] &
    Parameters<typeof getCustomBinaryPathForProvider>[0],
  provider: ProviderKind,
  instanceId?: ProviderInstanceId | null | undefined,
): string {
  const instanceBinaryPath = getProviderOptionsBinaryPath(
    getProviderStartOptions(settings, instanceId),
    provider,
  );
  if (instanceBinaryPath) {
    return instanceBinaryPath;
  }
  return instanceId && instanceId !== provider
    ? ""
    : getCustomBinaryPathForProvider(settings, provider);
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

  const defaults = useMemo(
    () =>
      normalizeAppSettings({
        ...DEFAULT_APP_SETTINGS,
        ...serverSettingsToAppSettings(DEFAULT_SERVER_SETTINGS),
      }),
    [],
  );

  const settings = useMemo(
    () =>
      normalizeAppSettings({
        ...localSettings,
        ...(serverSettingsQuery.data ? serverSettingsToAppSettings(serverSettingsQuery.data) : {}),
      }),
    [localSettings, serverSettingsQuery.data],
  );

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

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => normalizeAppSettings({ ...prev, ...patch }));
      if (touchesProviderDiscoverySettings(patch)) {
        void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
      }

      const serverPatch = appSettingsPatchToServerSettingsPatch(patch);
      if (isServerSettingsPatchEmpty(serverPatch)) {
        return;
      }

      void ensureNativeApi()
        .server.updateSettings(serverPatch)
        .then((nextSettings) => {
          queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        })
        .catch(() => {
          void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
        });
    },
    [queryClient, setSettings],
  );

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_APP_SETTINGS);
    void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
    const serverPatch = appSettingsPatchToServerSettingsPatch(defaults);
    void ensureNativeApi()
      .server.updateSettings(serverPatch)
      .then((nextSettings) => {
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      });
  }, [defaults, queryClient, setSettings]);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults,
  } as const;
}
