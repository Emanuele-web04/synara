// FILE: appSettings.ts
// Purpose: Normalizes persisted UI settings and maps them to server/provider options.
// Layer: Web settings state
// Exports: app setting schema, normalization helpers, provider option builders

import { useCallback, useEffect, useRef } from "react";
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
  type ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ProviderInstanceEnvironment,
  ProviderInstanceId,
  GitHubInboxSort,
  KeepAwakeMode,
  TrimmedNonEmptyString,
  ProviderKind,
  SidechatExpiry,
  SourceControlWritingStyle,
  SourceControlCustomInstructions,
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
import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";
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
  DEFAULT_HIDDEN_RAIL_ITEMS,
  normalizeHiddenRailItems,
  normalizeRailItemOrder,
  RAIL_ORDERABLE_ITEM_IDS,
} from "./appRail.logic";
import { ensureNativeApi } from "./nativeApi";
import { githubInboxQueryKeys } from "./lib/githubInboxQueryOptions";
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
export const ComputerPreviewSize = Schema.Literals(["compact", "large"]);
export type ComputerPreviewSize = typeof ComputerPreviewSize.Type;
export const DEFAULT_COMPUTER_PREVIEW_SIZE: ComputerPreviewSize = "compact";
export const AgentCursorColorMode = Schema.Literals(["stock", "custom"]);
export type AgentCursorColorMode = typeof AgentCursorColorMode.Type;
export const DEFAULT_AGENT_CURSOR_COLOR_MODE: AgentCursorColorMode = "stock";

/**
 * A persisted id list that keeps the entries this build can resolve (known ids, or a
 * renamed id's new name) and drops the rest, so an id written by a newer or older build
 * never fails the whole settings decode and resets every setting.
 */
function persistedIdList<Id extends string>(
  IdSchema: Schema.Codec<Id>,
  resolve: (value: string) => Id | undefined,
) {
  return Schema.Array(Schema.String).pipe(
    Schema.decodeTo(
      Schema.Array(IdSchema),
      SchemaTransformation.transform<ReadonlyArray<Id>, ReadonlyArray<string>>({
        decode: (values) =>
          values.flatMap((value) => {
            const id = resolve(value);
            return id === undefined ? [] : [id];
          }),
        encode: (values) => values,
      }),
    ),
  );
}

function persistedKnownIdList<const Ids extends ReadonlyArray<string>>(ids: Ids) {
  const Id = Schema.Literals([...ids]);
  const isKnownId = Schema.is(Id);
  return persistedIdList(Id, (value) => (isKnownId(value) ? value : undefined));
}

const RailOrderableItemIdList = persistedKnownIdList(RAIL_ORDERABLE_ITEM_IDS);
/** Where the Tasks entry opens: the to-do list or the Kanban board of chats. */
export const TasksViewMode = Schema.Literals(["list", "kanban"]);
export type TasksViewMode = typeof TasksViewMode.Type;
export const DEFAULT_TASKS_VIEW_MODE: TasksViewMode = "list";

export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";
export const FollowUpBehavior = Schema.Literals(["queue", "steer"]);
/** The inbox status filter. Merged is the closed list narrowed to merged pull requests. */
export const GitHubInboxStateFilter = Schema.Literals(["open", "closed", "merged"]);
export type GitHubInboxStateFilter = typeof GitHubInboxStateFilter.Type;

/** GitHub inbox kind filter: both kinds, or only pull requests or only issues. */
export const GitHubInboxKindFilter = Schema.Literals(["all", "pullRequest", "issue"]);
export type GitHubInboxKindFilter = typeof GitHubInboxKindFilter.Type;
/** GitHub inbox involvement filter, applied on the client over the loaded superset. */
export const GitHubInboxInvolvementFilter = Schema.Literals([
  "everything",
  "involved",
  "reviewRequested",
  "authored",
  "assigned",
]);
export type GitHubInboxInvolvementFilter = typeof GitHubInboxInvolvementFilter.Type;
/** Where a plain click on a GitHub pull request or issue link opens: the built-in review view,
 *  the in-app browser, or the system browser. */
export const GitHubLinkOpenTarget = Schema.Literals(["app", "browser", "external"]);
export type GitHubLinkOpenTarget = typeof GitHubLinkOpenTarget.Type;
export const DEFAULT_GITHUB_LINK_OPEN_TARGET: GitHubLinkOpenTarget = "app";
export type FollowUpBehavior = typeof FollowUpBehavior.Type;
// Sound the chat message trail moves with (desktop on macOS).
export const MessageTrailAudioSource = Schema.Literals(["off", "system", "microphone", "both"]);
export type MessageTrailAudioSource = typeof MessageTrailAudioSource.Type;
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "queue";
/** Which account windows each app-rail usage ring draws: both, or only one of them. */
export const RailUsageWindow = Schema.Literals(["both", "fiveHour", "weekly"]);
export type RailUsageWindow = typeof RailUsageWindow.Type;
export const DEFAULT_RAIL_USAGE_WINDOW: RailUsageWindow = "both";
// What plain Enter does while a composer voice note is recording: "stop" only
// transcribes into the draft, "send" also sends the draft once transcribed.
export const VoiceEnterBehavior = Schema.Literals(["stop", "send"]);
export type VoiceEnterBehavior = typeof VoiceEnterBehavior.Type;
export const DEFAULT_VOICE_ENTER_BEHAVIOR: VoiceEnterBehavior = "stop";
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
  | "customPiModels"
  | "customOmpModels";
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
  omp: new Set(getModelOptions("omp").map((option) => option.slug)),
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
  "omp",
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

const PersistedProviderKindList = persistedIdList(ProviderKind, resolvePersistedProviderListEntry);
const isProviderInstanceId = Schema.is(ProviderInstanceId);
const PersistedProviderInstanceIdList = persistedIdList(ProviderInstanceId, (value) =>
  isProviderInstanceId(value) ? value : undefined,
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
  ompBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  ompAgentDir: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  openCodeServerUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(withDefaults(() => "")),
  openCodeServerPassword: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    withDefaults(() => ""),
  ),
  openCodeServerPasswordConfigured: Schema.Boolean.pipe(withDefaults(() => false)),
  openCodeExperimentalWebSockets: Schema.Boolean.pipe(withDefaults(() => false)),
  defaultThreadEnvMode: EnvMode.pipe(withDefaults(() => "local" as const satisfies EnvMode)),
  anchorSentMessagesToTop: Schema.Boolean.pipe(withDefaults(() => true)),
  confirmThreadDelete: Schema.Boolean.pipe(withDefaults(() => true)),
  // Opt-in: archiving a task also releases its worktree when nothing else uses it.
  archiveDeletesOrphanedWorktree: Schema.Boolean.pipe(withDefaults(() => false)),
  // Desktop quit dialog: remember interrupted chats and continue them on the next launch.
  resumeChatsAfterQuit: Schema.Boolean.pipe(withDefaults(() => true)),
  confirmThreadArchive: Schema.Boolean.pipe(withDefaults(() => false)),
  confirmTerminalTabClose: Schema.Boolean.pipe(withDefaults(() => true)),
  diffWordWrap: Schema.Boolean.pipe(withDefaults(() => false)),
  showPullRequestDiffColors: Schema.Boolean.pipe(withDefaults(() => true)),
  githubLinkOpenTarget: GitHubLinkOpenTarget.pipe(
    withDefaults(() => DEFAULT_GITHUB_LINK_OPEN_TARGET),
  ),
  // Local-only GitHub inbox view state: the filters the page reopens with (URL parameters
  // override them for one visit; search text lives only in the URL). The column widths are not
  // stored: the page always opens at even fractions.
  githubInboxKind: GitHubInboxKindFilter.pipe(withDefaults(() => "all" as const)),
  githubInboxState: GitHubInboxStateFilter.pipe(withDefaults(() => "open" as const)),
  githubInboxSort: GitHubInboxSort.pipe(withDefaults(() => "created" as const)),
  githubInboxInvolvement: GitHubInboxInvolvementFilter.pipe(
    withDefaults(() => "everything" as const),
  ),
  githubInboxProjectIds: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).pipe(
    withDefaults(() => []),
  ),
  githubInboxLabels: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
    withDefaults(() => []),
  ),
  // The list sections the user has expanded; the first two start open, the rest collapsed.
  githubInboxExpandedSections: Schema.Array(
    Schema.Literals(["authored", "reviewRequested", "involved", "others"]),
  ).pipe(withDefaults(() => ["authored", "reviewRequested"] as const)),
  // Server-backed: the inbox also reads each project's other GitHub remotes (fork upstreams).
  githubInboxIncludeUpstreams: Schema.Boolean.pipe(withDefaults(() => false)),
  // Server-backed: how long an idle side chat stays usable before it expires.
  sidechatExpiry: SidechatExpiry.pipe(withDefaults(() => "1h" as const satisfies SidechatExpiry)),
  // Local-only UI preferences for hiding sidebar surfaces a user doesn't want.
  // `showChatsSection` controls the standalone "Chats" list in the sidebar footer
  // (rootless chats not tied to a project). `showGroupsSection` controls the
  // optional Groups tab in the section switcher.
  showChatsSection: Schema.Boolean.pipe(withDefaults(() => true)),
  showGroupsSection: Schema.Boolean.pipe(withDefaults(() => true)),
  // Deprecated rename bridge from the Studio surface. Normalization migrates this
  // value onto `showGroupsSection` once and then omits the key.
  showStudioSection: Schema.optionalKey(Schema.Boolean),
  // The view the Tasks entry opens, last picked in its List/Kanban switch.
  // Stable never reads it (Kanban is its only view).
  tasksViewMode: TasksViewMode.pipe(withDefaults(() => DEFAULT_TASKS_VIEW_MODE)),
  // Rail shortcuts the user added from the rail's "…" menu, in rail order:
  // "space:<id>" (the Void key for unfiled) or "project:<id>" (see appRail.logic).
  railShortcuts: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).pipe(
    withDefaults(() => []),
  ),
  // The rail's Customize state: the order of the rail's top items and the ones the user hid. Home never hides, and an
  // active hidden item stays visible (see appRail.logic).
  railItemOrder: RailOrderableItemIdList.pipe(withDefaults(() => [...RAIL_ORDERABLE_ITEM_IDS])),
  hiddenRailItems: RailOrderableItemIdList.pipe(withDefaults(() => [...DEFAULT_HIDDEN_RAIL_ITEMS])),
  // Whether the per-run threads standalone automations create appear in the sidebar
  // (and the surfaces derived from it: Kanban, Activity, project picker). Runs stay
  // listed on the automation's page and findable via search either way.
  showAutomationRunThreads: Schema.Boolean.pipe(withDefaults(() => true)),
  environmentPanelDefaultOpen: Schema.Boolean.pipe(withDefaults(() => false)),
  showEnvironmentUsage: Schema.Boolean.pipe(withDefaults(() => true)),
  // Legacy provider selection, retained to migrate existing sidebar preferences.
  railUsageProviders: PersistedProviderKindList.pipe(
    withDefaults((): ReadonlyArray<ProviderKind> => ["codex", "claudeAgent"]),
  ),
  // Accounts whose usage rings sit at the bottom of the app rail. Null migrates the
  // legacy provider ids to their default accounts; an empty list explicitly hides all rings.
  railUsageInstanceIds: Schema.NullOr(PersistedProviderInstanceIdList).pipe(
    withDefaults(() => null),
  ),
  railUsageWindow: RailUsageWindow.pipe(withDefaults(() => DEFAULT_RAIL_USAGE_WINDOW)),
  // Usage popovers (rail rings, chat header, branch toolbar) open on the limit rows only;
  // reset credits, credits, and token totals sit behind a "Details" toggle. The toggle
  // writes back here, so the last choice sticks; Settings → Usage exposes it too.
  usageDetailsDefaultOpen: Schema.Boolean.pipe(withDefaults(() => false)),
  // Which detail sections usage popovers offer at all. Ignored when a provider reports no
  // limit rows, since the details are then the only usage there is to show.
  usagePopoverShowResetCredits: Schema.Boolean.pipe(withDefaults(() => true)),
  usagePopoverShowUsageLines: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentRepository: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentPullRequest: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentEditor: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentRecap: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentPinned: Schema.Boolean.pipe(withDefaults(() => true)),
  showEnvironmentInstructions: Schema.Boolean.pipe(withDefaults(() => false)),
  showEnvironmentNotepad: Schema.Boolean.pipe(withDefaults(() => false)),
  followUpBehavior: FollowUpBehavior.pipe(withDefaults(() => DEFAULT_FOLLOW_UP_BEHAVIOR)),
  voiceEnterBehavior: VoiceEnterBehavior.pipe(withDefaults(() => DEFAULT_VOICE_ENTER_BEHAVIOR)),
  enableAssistantStreaming: Schema.Boolean.pipe(withDefaults(() => true)),
  // Fold each finished turn's tool calls and intermediate messages behind one
  // "Worked for…" line. Off keeps every step of finished turns visible.
  collapseFinishedTurns: Schema.Boolean.pipe(withDefaults(() => true)),
  // Started threads: show reasoning effort as a stepped slider card in the composer's
  // model menu instead of radio rows. New chats keep the split model/effort pickers.
  composerEffortSlider: Schema.Boolean.pipe(withDefaults(() => true)),
  // Desktop on macOS: the message trail moves with the Mac's audio output,
  // the microphone, or both. Opt-in because the first use asks macOS for access.
  messageTrailAudioSource: MessageTrailAudioSource.pipe(withDefaults(() => "off" as const)),
  // Core Audio UID of the microphone the trail listens to; "" follows the Mac's
  // default input (which may be a Bluetooth headset).
  messageTrailMicrophoneId: Schema.String.check(Schema.isMaxLength(512)).pipe(
    withDefaults(() => ""),
  ),
  autoOpenDevicePane: Schema.Boolean.pipe(withDefaults(() => true)),
  enableProviderUpdateChecks: Schema.Boolean.pipe(withDefaults(() => true)),
  keepAwakeMode: KeepAwakeMode.pipe(withDefaults(() => "off" as const satisfies KeepAwakeMode)),
  lowerProviderProcessPriority: Schema.Boolean.pipe(withDefaults(() => true)),
  enableNativeFontSmoothing: Schema.Boolean.pipe(withDefaults(getDefaultNativeFontSmoothing)),
  desktopAppIcon: DesktopAppIcon.pipe(withDefaults(() => "default" as const)),
  // Electron `frame` is fixed at window creation — the main process persists this too and a relaunch is required to apply it
  useCustomTitleBar: Schema.Boolean.pipe(withDefaults(() => true)),
  enableTaskCompletionToasts: Schema.Boolean.pipe(withDefaults(() => true)),
  enableSystemTaskCompletionNotifications: Schema.Boolean.pipe(withDefaults(() => true)),
  // Finished-work alerts wait for the agent's background subagents too, and a
  // subagent's own thread never alerts. Off alerts every time any of them stops.
  notifyAfterSubagentsFinish: Schema.Boolean.pipe(withDefaults(() => true)),
  // Local desktop preference. Native capability/permission state remains owned by Electron.
  // AppSnap is opt-in because enabling its Settings toggle requests macOS
  // Input Monitoring and Screen Recording permissions.
  enableAppSnap: Schema.Boolean.pipe(withDefaults(() => false)),
  appSnapShortcut: AppSnapShortcut.pipe(withDefaults(() => DEFAULT_APP_SNAP_SHORTCUT)),
  appSnapPlaySound: Schema.Boolean.pipe(withDefaults(() => true)),
  // rename bridge — normalization migrates this value then omits the key
  enableAppshots: Schema.optionalKey(Schema.Boolean),
  // Show the in-chat Computer preview when an agent starts driving the desktop.
  autoOpenComputerPane: Schema.Boolean.pipe(withDefaults(() => true)),
  // In-chat computer preview footprint. Compact is the default: a small
  // glanceable card that reserves a narrow gutter. Large restores the
  // previous wide card for users who want the detail inline.
  computerPreviewSize: ComputerPreviewSize.pipe(withDefaults(() => DEFAULT_COMPUTER_PREVIEW_SIZE)),
  // Computer control is off by default. When on, the agent may use the desktop
  // in any chat. Approval gates and Stop still apply.
  computerControlEnabled: Schema.Boolean.pipe(withDefaults(() => false)),
  // The agent cursor's colors. Stock is the default monochrome treatment and
  // stores no overrides; "custom" opts into a fill and rim, persisted as
  // lowercase `#rrggbb` strings and pushed to the desktop cursor host.
  agentCursorColorMode: AgentCursorColorMode.pipe(
    withDefaults(() => DEFAULT_AGENT_CURSOR_COLOR_MODE),
  ),
  agentCursorFillColor: Schema.String.check(Schema.isMaxLength(7)).pipe(withDefaults(() => "")),
  agentCursorRimColor: Schema.String.check(Schema.isMaxLength(7)).pipe(withDefaults(() => "")),
  // Deprecated rename bridge. Normalization migrates this value and then omits the key.
  allowComputerControlInNewChats: Schema.optionalKey(Schema.Boolean),
  // One-shot composer hint that suggests Medium effort for faster desktop actions.
  // Set when the user applies or dismisses it, so the hint never asks twice.
  dismissedComputerControlEffortHint: Schema.Boolean.pipe(withDefaults(() => false)),
  // One-shot composer hint offering Auto-fix CI on a chat's open PR. Set when the
  // user dismisses it or turns Auto-fix CI on anywhere, so it never asks twice.
  dismissedPullRequestAutoFixHint: Schema.Boolean.pipe(withDefaults(() => false)),
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
  customOmpModels: Schema.Array(Schema.String).pipe(withDefaults(() => [])),
  textGenerationProvider: PersistedProviderKind.pipe(withDefaults(() => "codex" as const)),
  textGenerationProviderInstanceId: Schema.optional(ProviderInstanceId),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
  sourceControlWritingStyle: SourceControlWritingStyle.pipe(
    withDefaults(() => "repository" as const),
  ),
  sourceControlCustomInstructions: SourceControlCustomInstructions.pipe(withDefaults(() => "")),
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

/**
 * First-launch icon default per desktop flavor. The schema keeps "default" so
 * persisted renderer state stays stable; the native side owns first-launch
 * defaulting via getAppIcon, and the Appearance reset uses this for its target.
 */
export function defaultDesktopAppIconForFlavor(
  flavor: SynaraDesktopFlavor | "unknown",
): DesktopAppIcon {
  return flavor === "beta" ? "beta" : "default";
}

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
  omp: {
    provider: "omp",
    settingsKey: "customOmpModels",
    defaultSettingsKey: "customOmpModels",
    title: "Oh My Pi",
    description: "Save additional Oh My Pi model slugs for the picker and provider runtime.",
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

/** Normalize a cursor color to lowercase `#rrggbb`, or "" for anything else. */
export function normalizeCursorHexColor(value: string | null | undefined): string {
  const candidate = (value ?? "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(candidate) ? candidate : "";
}

/**
 * The custom agent-cursor colors to push to the desktop cursor host, or null
 * for the stock monochrome cursor. Stock mode resolves to null no matter what
 * colors are stored, so switching back to stock never leaves a stale override
 * in the pushed payload. A channel with no valid color is omitted, not sent
 * empty, because the driver treats an omitted channel as stock.
 */
export function resolveAgentCursorColors(
  settings: Pick<
    AppSettings,
    "agentCursorColorMode" | "agentCursorFillColor" | "agentCursorRimColor"
  >,
): { fill?: string; rim?: string } | null {
  if ((settings.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE) !== "custom") return null;
  const fill = normalizeCursorHexColor(settings.agentCursorFillColor);
  const rim = normalizeCursorHexColor(settings.agentCursorRimColor);
  if (!fill && !rim) return null;
  return { ...(fill ? { fill } : {}), ...(rim ? { rim } : {}) };
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
  /** User-picked `#rrggbb` marker shown on the account's initials badge. */
  readonly accentColor?: string;
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
  "omp",
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
  > &
    Partial<Pick<AppSettings, "disabledProviders">>,
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
      // Like every provider's default account, and like the server names it.
      label: account.isDefault ? defaultProviderInstanceLabel("codex") : account.label,
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
    const isDefault = instanceId === raw.driver;
    // An explicit entry for a derived account (a default, a migrated Codex account) may
    // only carry overrides such as an accent or a switch; it keeps the derived name.
    const derived = optionsById.get(instanceId);
    const label =
      raw.displayName?.trim() ||
      (derived?.driver === raw.driver ? derived.label : undefined) ||
      (isDefault
        ? defaultProviderInstanceLabel(raw.driver)
        : fallbackProviderInstanceLabel(instanceId));
    const accentColor = raw.accentColor?.trim();
    optionsById.set(instanceId, {
      instanceId,
      provider: raw.driver,
      driver: raw.driver,
      label,
      ...(accentColor ? { accentColor } : {}),
      enabled: raw.enabled !== false && config.enabled !== false,
      isDefault,
      supported: true,
    });
  }

  return Array.from(optionsById.values())
    .map((option) => ({
      ...option,
      enabled: option.enabled && !settings.disabledProviders?.includes(option.provider),
    }))
    .toSorted((left, right) => {
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

export interface ManageableProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly legacyCodexAccountId: string | null;
}

// Legacy Codex accounts are derived into provider instances by the server. Surface
// those derived rows alongside explicit instances so settings can edit or remove
// them without first requiring a destructive identity migration.
export function getManageableProviderInstances(
  settings: Pick<
    AppSettings,
    | "codexAccounts"
    | "codexBinaryPath"
    | "codexHomePath"
    | "providerInstances"
    | "selectedCodexAccountId"
  >,
  provider: ProviderKind,
): ManageableProviderInstance[] {
  const legacyCodexAccountByInstanceId = new Map(
    normalizeCodexAccounts(settings.codexAccounts).map((account) => [
      providerInstanceIdForCodexAccount(account.id),
      account,
    ]),
  );
  const result: ManageableProviderInstance[] = [];

  for (const option of getProviderInstanceOptions(settings)) {
    if (option.provider !== provider || option.isDefault) {
      continue;
    }

    const explicit = settings.providerInstances[option.instanceId];
    const legacyCodexAccount =
      provider === "codex" ? legacyCodexAccountByInstanceId.get(option.instanceId) : undefined;
    if (!legacyCodexAccount) {
      if (explicit) {
        result.push({
          instanceId: option.instanceId,
          instance: explicit,
          legacyCodexAccountId: null,
        });
      }
      continue;
    }

    const legacyConfig = {
      binaryPath: settings.codexBinaryPath.trim(),
      homePath: legacyCodexAccount.homePath.trim(),
      shadowHomePath: legacyCodexAccount.shadowHomePath.trim(),
      accountId: legacyCodexAccount.id,
    };
    const explicitConfig = isRecord(explicit?.config) ? explicit.config : {};
    result.push({
      instanceId: option.instanceId,
      instance: {
        driver: "codex",
        displayName: legacyCodexAccount.label.trim() || legacyCodexAccount.id,
        enabled: true,
        ...explicit,
        config: {
          ...legacyConfig,
          ...explicitConfig,
        },
      },
      legacyCodexAccountId: legacyCodexAccount.id,
    });
  }

  return result;
}

export interface ProviderInstancePatch {
  readonly displayName?: string | undefined;
  /** `null` clears the accent. */
  readonly accentColor?: string | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly environment?: ProviderInstanceEnvironment | undefined;
  readonly config?: Record<string, unknown> | undefined;
}

// Settings change for an edit to one account, or null when the account is unknown.
// `legacyCodexAccountId` marks a Codex account that still lives in codexAccounts.
export function buildProviderInstanceSettingsPatch(
  settings: Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "providerInstances" | "selectedCodexAccountId"
  >,
  instanceId: string,
  patch: ProviderInstancePatch,
  legacyCodexAccountId: string | null = null,
): Pick<AppSettings, "providerInstances"> | Pick<AppSettings, "codexAccounts"> | null {
  const explicit = settings.providerInstances[instanceId];
  const legacyAccountPatch = legacyCodexAccountId
    ? {
        ...(patch.displayName !== undefined ? { label: patch.displayName } : {}),
        ...(typeof patch.config?.homePath === "string" ? { homePath: patch.config.homePath } : {}),
        ...(typeof patch.config?.shadowHomePath === "string"
          ? { shadowHomePath: patch.config.shadowHomePath }
          : {}),
      }
    : {};
  if (Object.keys(legacyAccountPatch).length > 0) {
    // A migrated account keeps its name and homes in codexAccounts. An explicit copy
    // that drifts from that entry makes the server drop the account's route, so the
    // edit goes to the entry and any stale explicit copy is cleared.
    const { displayName: _displayName, ...explicitRest } = explicit ?? { driver: "codex" };
    const {
      homePath: _homePath,
      shadowHomePath: _shadowHomePath,
      ...explicitConfig
    } = isRecord(explicit?.config) ? explicit.config : {};
    return {
      codexAccounts: normalizeCodexAccounts(
        settings.codexAccounts.map((account) =>
          account.id === legacyCodexAccountId ? { ...account, ...legacyAccountPatch } : account,
        ),
      ),
      ...(explicit
        ? {
            providerInstances: {
              ...settings.providerInstances,
              [instanceId]: { ...explicitRest, config: explicitConfig },
            } as ProviderInstanceConfigMap,
          }
        : {}),
    };
  }
  // A derived account (a default, a migrated Codex account) gets its first explicit
  // entry here; the server merges it over the derived one key by key.
  const derived = explicit
    ? undefined
    : getProviderInstanceOptions(settings).find((instance) => instance.instanceId === instanceId);
  const existing: ProviderInstanceConfig | null =
    explicit ?? (derived ? ({ driver: derived.driver } as ProviderInstanceConfig) : null);
  if (!existing) return null;
  const {
    displayName: existingDisplayName,
    accentColor: existingAccentColor,
    environment: existingEnvironment,
    ...existingRest
  } = existing;
  const displayName =
    patch.displayName !== undefined ? patch.displayName.trim() : existingDisplayName;
  const accentColor =
    patch.accentColor !== undefined ? (patch.accentColor ?? undefined) : existingAccentColor;
  const environment = patch.environment !== undefined ? patch.environment : existingEnvironment;
  return {
    providerInstances: {
      ...settings.providerInstances,
      [instanceId]: {
        ...existingRest,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        ...(environment && environment.length > 0 ? { environment } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.config
          ? { config: mergeProviderInstanceConfigPatch(existing.config, patch.config) }
          : {}),
      },
    } as ProviderInstanceConfigMap,
  };
}

// Removes every app setting keyed by an explicit instance id so a later
// instance that reuses the id cannot inherit the deleted account's preferences.
export function removeProviderInstancePreferences(
  settings: Pick<AppSettings, "providerInstances">,
  instanceId: string,
): Pick<AppSettings, "providerInstances"> {
  const providerInstances: Record<string, ProviderInstanceConfig> = {
    ...settings.providerInstances,
  };
  delete providerInstances[instanceId];
  return {
    providerInstances: providerInstances as ProviderInstanceConfigMap,
  };
}

export function removeManageableProviderInstance(
  settings: Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "providerInstances" | "selectedCodexAccountId"
  >,
  instanceId: string,
): Pick<AppSettings, "codexAccounts" | "providerInstances" | "selectedCodexAccountId"> {
  const preferences = removeProviderInstancePreferences(settings, instanceId);
  const legacyAccount = normalizeCodexAccounts(settings.codexAccounts).find(
    (account) => providerInstanceIdForCodexAccount(account.id) === instanceId,
  );
  if (!legacyAccount) {
    return {
      ...preferences,
      codexAccounts: settings.codexAccounts,
      selectedCodexAccountId: settings.selectedCodexAccountId,
    };
  }

  return {
    ...preferences,
    codexAccounts: settings.codexAccounts.filter((account) => account.id !== legacyAccount.id),
    selectedCodexAccountId:
      settings.selectedCodexAccountId === legacyAccount.id
        ? DEFAULT_CODEX_ACCOUNT_ID
        : settings.selectedCodexAccountId,
  };
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
    allowComputerControlInNewChats: legacyAllowComputerControlInNewChats,
    geminiBinaryPath: legacyGeminiBinaryPath,
    customGeminiModels: legacyCustomGeminiModels,
    showStudioSection: legacyShowStudioSection,
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
    railUsageInstanceIds: settings.railUsageInstanceIds ?? settings.railUsageProviders,
    enableAppSnap: settings.enableAppSnap || legacyEnableAppshots === true,
    // Read the legacy Studio key once: it defaults to true, so only an explicit
    // `false` carries over onto the renamed Groups section.
    showGroupsSection: settings.showGroupsSection && legacyShowStudioSection !== false,
    computerControlEnabled:
      settings.computerControlEnabled || legacyAllowComputerControlInNewChats === true,
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
    ompBinaryPath: normalizeProviderBinaryPathOverride("omp", settings.ompBinaryPath),
    uiDensity: normalizeUiDensityValue(settings.uiDensity),
    chatWidth: normalizeChatWidthModeValue(settings.chatWidth),
    agentCursorFillColor: normalizeCursorHexColor(settings.agentCursorFillColor),
    agentCursorRimColor: normalizeCursorHexColor(settings.agentCursorRimColor),
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
    customOmpModels: normalizeCustomModelSlugs(settings.customOmpModels, "omp"),
    hiddenProviders: normalizeHiddenProviders(settings.hiddenProviders),
    disabledProviders: normalizeHiddenProviders(settings.disabledProviders),
    providerOrder: normalizeProviderOrder(settings.providerOrder),
    railItemOrder: normalizeRailItemOrder(settings.railItemOrder),
    hiddenRailItems: normalizeHiddenRailItems(settings.hiddenRailItems),
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

export function serverSettingsToAppSettings(settings: ServerSettingsView): Partial<AppSettings> {
  return {
    claudeBinaryPath: settings.providers.claudeAgent.binaryPath,
    claudeEnableArtifacts: settings.providers.claudeAgent.enableArtifacts,
    claudeHomePath: settings.providers.claudeAgent.homePath,
    codexBinaryPath: settings.providers.codex.binaryPath,
    codexHomePath: settings.providers.codex.homePath,
    codexAccounts: settings.providers.codex.accounts,
    selectedCodexAccountId: settings.providers.codex.selectedAccountId,
    cursorApiEndpoint: settings.providers.cursor.apiEndpoint,
    cursorBinaryPath: settings.providers.cursor.binaryPath,
    devinBinaryPath: settings.providers.devin.binaryPath,
    defaultThreadEnvMode: settings.defaultThreadEnvMode,
    githubInboxIncludeUpstreams: settings.githubInboxIncludeUpstreams,
    sidechatExpiry: settings.sidechatExpiry,
    enableAssistantStreaming: settings.enableAssistantStreaming,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
    keepAwakeMode: settings.keepAwakeMode,
    lowerProviderProcessPriority: settings.lowerProviderProcessPriority,
    antigravityBinaryPath: settings.providers.antigravity.binaryPath,
    grokBinaryPath: settings.providers.grok.binaryPath,
    droidBinaryPath: settings.providers.droid.binaryPath,
    openCodeBinaryPath: settings.providers.opencode.binaryPath,
    openCodeExperimentalWebSockets: settings.providers.opencode.experimentalWebSockets,
    openCodeServerPasswordConfigured: settings.providers.opencode.serverPasswordConfigured,
    openCodeServerUrl: settings.providers.opencode.serverUrl,
    piAgentDir: settings.providers.pi.agentDir,
    piBinaryPath: settings.providers.pi.binaryPath,
    ompAgentDir: settings.providers.omp.agentDir,
    ompBinaryPath: settings.providers.omp.binaryPath,
    customCodexModels: settings.providers.codex.customModels,
    customClaudeModels: settings.providers.claudeAgent.customModels,
    customCursorModels: settings.providers.cursor.customModels,
    customDevinModels: settings.providers.devin.customModels,
    customAntigravityModels: settings.providers.antigravity.customModels,
    customGrokModels: settings.providers.grok.customModels,
    customDroidModels: settings.providers.droid.customModels,
    customOpenCodeModels: settings.providers.opencode.customModels,
    customPiModels: settings.providers.pi.customModels,
    customOmpModels: settings.providers.omp.customModels,
    disabledProviders: getServerDisabledProviders(settings),
    providerInstances: settings.providerInstances,
    textGenerationProvider: settings.textGenerationModelSelection.provider,
    textGenerationProviderInstanceId: settings.textGenerationModelSelection.instanceId,
    textGenerationModel: settings.textGenerationModelSelection.model,
    sourceControlWritingStyle: settings.sourceControlWritingStyle,
    sourceControlCustomInstructions: settings.sourceControlCustomInstructions,
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
    hasOwn(patch, "ompBinaryPath") ||
    hasOwn(patch, "ompAgentDir") ||
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
  if (
    patch.keepAwakeMode === "always" ||
    patch.keepAwakeMode === "agent" ||
    patch.keepAwakeMode === "off"
  ) {
    serverPatch.keepAwakeMode = patch.keepAwakeMode;
  }
  if (hasOwn(patch, "lowerProviderProcessPriority")) {
    serverPatch.lowerProviderProcessPriority = Boolean(patch.lowerProviderProcessPriority);
  }
  if (patch.defaultThreadEnvMode === "local" || patch.defaultThreadEnvMode === "worktree") {
    serverPatch.defaultThreadEnvMode = patch.defaultThreadEnvMode;
  }
  if (hasOwn(patch, "githubInboxIncludeUpstreams")) {
    serverPatch.githubInboxIncludeUpstreams = Boolean(patch.githubInboxIncludeUpstreams);
  }
  if (
    patch.sidechatExpiry === "1h" ||
    patch.sidechatExpiry === "24h" ||
    patch.sidechatExpiry === "never"
  ) {
    serverPatch.sidechatExpiry = patch.sidechatExpiry;
  }
  if (hasOwn(patch, "onboardingCompletedAt")) {
    serverPatch.onboardingCompletedAt = patch.onboardingCompletedAt ?? null;
  }
  if (patch.sourceControlWritingStyle !== undefined) {
    serverPatch.sourceControlWritingStyle = patch.sourceControlWritingStyle;
  }
  if (patch.sourceControlCustomInstructions !== undefined) {
    serverPatch.sourceControlCustomInstructions = patch.sourceControlCustomInstructions;
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
    hasOwn(patch, "claudeEnableArtifacts") ||
    hasOwn(patch, "claudeHomePath") ||
    hasOwn(patch, "customClaudeModels")
  ) {
    providers.claudeAgent = {
      ...(hasOwn(patch, "claudeBinaryPath") ? { binaryPath: patch.claudeBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "claudeEnableArtifacts")
        ? { enableArtifacts: Boolean(patch.claudeEnableArtifacts) }
        : {}),
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
        ? {
            experimentalWebSockets: Boolean(patch.openCodeExperimentalWebSockets),
          }
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
  if (
    hasOwn(patch, "ompAgentDir") ||
    hasOwn(patch, "ompBinaryPath") ||
    hasOwn(patch, "customOmpModels")
  ) {
    providers.omp = {
      ...(hasOwn(patch, "ompAgentDir") ? { agentDir: patch.ompAgentDir ?? "" } : {}),
      ...(hasOwn(patch, "ompBinaryPath") ? { binaryPath: patch.ompBinaryPath ?? "" } : {}),
      ...(hasOwn(patch, "customOmpModels") ? { customModels: patch.customOmpModels ?? [] } : {}),
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

export function buildInitialServerSettingsMigrationPatch(
  settings: AppSettings,
): ServerSettingsPatch {
  const patch: Partial<Mutable<AppSettings>> = {};
  const normalizedSettings = normalizeAppSettings(settings);
  const defaults = DEFAULT_APP_SETTINGS;

  for (const key of [
    "claudeBinaryPath",
    "claudeEnableArtifacts",
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
    "keepAwakeMode",
    "antigravityBinaryPath",
    "grokBinaryPath",
    "droidBinaryPath",
    "openCodeBinaryPath",
    "openCodeExperimentalWebSockets",
    "openCodeServerPassword",
    "openCodeServerUrl",
    "piAgentDir",
    "piBinaryPath",
    "ompAgentDir",
    "ompBinaryPath",
    "textGenerationModel",
    "textGenerationProvider",
    "textGenerationProviderInstanceId",
    "sourceControlWritingStyle",
    "sourceControlCustomInstructions",
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
    "customOmpModels",
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
    // provider enablement belongs to the connected server — scrub legacy values so a browser profile can't project one server's shutdown onto another
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
      ? {
          openCodeServerPasswordConfigured: Boolean(patch.openCodeServerPassword?.trim()),
        }
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
    Partial<Pick<AppSettings, "codexAccounts" | "codexHomePath" | "selectedCodexAccountId">>,
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
          driver: instance.provider,
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
    omp: getCustomModelsForProvider(settings, "omp"),
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
      name: formatProviderModelOptionName({
        provider,
        slug: normalizedSelectedModel,
      }),
      isCustom: true,
    });
  }

  return options;
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
    case "omp": {
      const agentDir = readProviderInstanceConfigValue(config, "agentDir");
      return binaryPath || agentDir
        ? {
            omp: {
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
    ...(base.omp || overlay.omp ? { omp: { ...base.omp, ...overlay.omp } } : {}),
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
    | "ompAgentDir"
    | "ompBinaryPath"
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
  const ompBinaryPath = normalizeProviderBinaryPathOverride("omp", settings.ompBinaryPath);
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
    ...(ompBinaryPath || settings.ompAgentDir
      ? {
          omp: {
            ...(ompBinaryPath ? { binaryPath: ompBinaryPath } : {}),
            ...(settings.ompAgentDir ? { agentDir: settings.ompAgentDir } : {}),
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
 * Layers `overlay` over `base` per provider and per option key: the overlay
 * wins only for the provider options it names, so a seeded routing overlay
 * (e.g. a group's worker routing) never wipes the user's own start options
 * for other providers — or the untouched keys of a provider it does name.
 */
export function mergeProviderStartOptions(
  base: ProviderStartOptions | undefined,
  overlay: ProviderStartOptions | undefined,
): ProviderStartOptions | undefined {
  if (overlay === undefined) {
    return base;
  }
  if (base === undefined) {
    return overlay;
  }
  return {
    ...(base.codex !== undefined || overlay.codex !== undefined
      ? { codex: { ...base.codex, ...overlay.codex } }
      : {}),
    ...(base.claudeAgent !== undefined || overlay.claudeAgent !== undefined
      ? { claudeAgent: { ...base.claudeAgent, ...overlay.claudeAgent } }
      : {}),
    ...(base.cursor !== undefined || overlay.cursor !== undefined
      ? { cursor: { ...base.cursor, ...overlay.cursor } }
      : {}),
    ...(base.devin !== undefined || overlay.devin !== undefined
      ? { devin: { ...base.devin, ...overlay.devin } }
      : {}),
    ...(base.antigravity !== undefined || overlay.antigravity !== undefined
      ? { antigravity: { ...base.antigravity, ...overlay.antigravity } }
      : {}),
    ...(base.grok !== undefined || overlay.grok !== undefined
      ? { grok: { ...base.grok, ...overlay.grok } }
      : {}),
    ...(base.droid !== undefined || overlay.droid !== undefined
      ? { droid: { ...base.droid, ...overlay.droid } }
      : {}),
    ...(base.opencode !== undefined || overlay.opencode !== undefined
      ? { opencode: { ...base.opencode, ...overlay.opencode } }
      : {}),
    ...(base.pi !== undefined || overlay.pi !== undefined
      ? { pi: { ...base.pi, ...overlay.pi } }
      : {}),
  };
}

/**
 * Single source of truth for mapping the streaming preference onto the orchestration
 * delivery mode used when dispatching turns (composer, chat, Kanban, and Tasks share this).
 */
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
    | "ompBinaryPath"
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
    case "omp":
      return normalizeProviderBinaryPathOverride(provider, settings.ompBinaryPath);
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

let resolvedDefaultAppSettings: AppSettings | undefined;

function getResolvedDefaultAppSettings(): AppSettings {
  resolvedDefaultAppSettings ??= normalizeAppSettings({
    ...DEFAULT_APP_SETTINGS,
    ...serverSettingsToAppSettings(DEFAULT_SERVER_SETTINGS_VIEW),
  });
  return resolvedDefaultAppSettings;
}

// Every `useAppSettings` caller resolves the same two inputs (the stored settings and the
// server's), and there are dozens of callers mounted at once, several inside the chat
// alone. Resolving once per input pair saves those passes and hands every caller the same
// `settings` object, so memos keyed on it agree across components.
let resolvedAppSettings:
  | { local: AppSettings; server: ServerSettingsView | undefined; settings: AppSettings }
  | undefined;

function resolveAppSettings(
  local: AppSettings,
  server: ServerSettingsView | undefined,
): AppSettings {
  if (resolvedAppSettings?.local === local && resolvedAppSettings.server === server) {
    return resolvedAppSettings.settings;
  }
  const settings = normalizeAppSettings({
    ...normalizeStoredAppSettings(local),
    ...(server ? serverSettingsToAppSettings(server) : {}),
  });
  resolvedAppSettings = { local, server, settings };
  return settings;
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
  const enqueueServerSettingsMutation = useCallback(
    <Result>(mutation: () => Promise<Result>): Promise<Result> => {
      const queued = serverSettingsMutationQueueRef.current.then(
        () => mutation(),
        () => mutation(),
      );
      serverSettingsMutationQueueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [],
  );

  const defaults = getResolvedDefaultAppSettings();
  const settings = resolveAppSettings(localSettings, serverSettingsQuery.data);

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
    void enqueueServerSettingsMutation(() =>
      ensureNativeApi().server.updateSettings(migrationPatch),
    )
      .then((nextSettings) => {
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        globalThis.localStorage?.setItem(SERVER_SETTINGS_MIGRATION_STORAGE_KEY, "1");
        pendingServerSettingsMigrationPatchRef.current = null;
        // The server now owns the migrated secrets; drop the local plaintext.
        setSettings((previous) => normalizeStoredAppSettings(previous));
      })
      .catch(() => {
        void queryClient.invalidateQueries({
          queryKey: serverQueryKeys.settings(),
        });
      })
      .finally(() => {
        serverSettingsMigrationInFlight = false;
      });
  }, [
    enqueueServerSettingsMutation,
    localSettings,
    queryClient,
    serverSettingsQuery.data,
    setSettings,
  ]);

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
        if (hasOwn(patch, "githubInboxIncludeUpstreams")) {
          // The repository set changed, so the inbox lists (and the review badge) are stale.
          await queryClient
            .invalidateQueries({ queryKey: githubInboxQueryKeys.all })
            .catch(() => undefined);
        }
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
