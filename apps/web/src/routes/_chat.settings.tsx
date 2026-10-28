import { EditorLanguageReloadNotice } from "~/components/codeEditor/EditorLanguageReloadNotice";
// FILE: _chat.settings.tsx
// Purpose: Render the dedicated settings experience with its own section sidebar and grouped panels.
// Layer: Route screen
// Exports: Settings route component for `/settings`

import {
  type DesktopAudioInputDevice,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type SidechatExpiry,
} from "@synara/contracts";
import { GROUPS_ON, VISIBLE_PROVIDER_DESCRIPTORS } from "../betaFeatures";
import { sameAppSnapShortcut } from "@synara/shared/appSnapShortcut";
import { desktopFlavorFromProtocol } from "@synara/shared/betaFeatures";
import { SafariAccessSetupButton } from "../components/SafariAccessOnboarding";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "~/i18n";
import {
  AVAILABLE_LANGUAGE_PREFERENCES,
  UI_LOCALES,
  UI_LOCALE_REGISTRY,
  resolveLanguagePreference,
  type LanguagePreference,
} from "~/i18n/locale";
import { useLocalStorage } from "../hooks/useLocalStorage";
import {
  DEFAULT_DIFF_RENDER_MODE,
  DIFF_RENDER_MODE_STORAGE_KEY,
  DiffRenderModeSchema,
  type DiffRenderMode,
} from "../diffRenderMode";

import {
  type AppSettings,
  type FollowUpBehavior,
  type GitHubLinkOpenTarget,
  type MessageTrailAudioSource,
  type VoiceEnterBehavior,
  DEFAULT_UI_DENSITY,
  DEFAULT_CHAT_WIDTH,
  type UiDensity,
  MAX_CHAT_FONT_SIZE_PX,
  MAX_TERMINAL_FONT_SIZE_PX,
  MIN_CHAT_FONT_SIZE_PX,
  MIN_TERMINAL_FONT_SIZE_PX,
  defaultDesktopAppIconForFlavor,
  normalizeChatFontSizePx,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSizePx,
  isGitTextGenerationSettingsDirty,
  TERMINAL_FONT_FAMILY_SUGGESTIONS,
  useAppSettings,
} from "../appSettings";
import { APP_VERSION } from "../branding";
import { AdvancedSettingsPanel } from "~/components/settings/AdvancedSettingsPanel";
import { AppIconPicker } from "~/components/settings/AppIconPicker";
import {
  ArchivedSettingsPanel,
  WorktreesSettingsPanel,
} from "~/components/settings/ConversationStorageSettingsPanels";
import {
  AppSnapSettingsPanel,
  BetaChannelSettingsPanel,
  NotificationsSettingsPanel,
} from "~/components/settings/DesktopSettingsPanels";
import { ComputerSettingsPanel } from "~/components/settings/ComputerSettingsPanel";
import { ModelsSettingsPanel } from "~/components/settings/ModelsSettingsPanel";
import {
  isProviderInstallSettingsDirty,
  ProvidersSettingsPanel,
} from "~/components/settings/ProvidersSettingsPanel";
import { ProviderOptionLabel } from "../components/ProviderIcon";
import ReleaseHistoryDialog from "../components/ReleaseHistoryDialog";
import {
  KeyboardShortcutsResetButton,
  KeyboardShortcutsSettingsPanel,
} from "../components/settings/KeyboardShortcutsSettingsPanel";
import { ProfileSettingsPanel } from "../components/settings/ProfileSettingsPanel";
import { ProviderUsageSettingsPanel } from "../components/settings/ProviderUsageSettingsPanel";
import { ExternalMcpSettingsPanel } from "../components/settings/ExternalMcpSettingsPanel";
import { McpConnectorsSettingsPanel } from "../components/settings/McpConnectorsSettingsPanel";
import {
  SettingResetButton,
  SettingsSegmentedControl,
  SettingsSelectControl,
} from "../components/settings/SettingControls";
import {
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "../components/settings/SettingsPanelPrimitives";
import { SkillsSettingsPanel } from "../components/settings/SkillsSettingsPanel";
import { ThemeModePicker } from "../components/settings/ThemeModePicker";
import { ThemePackEditor } from "../components/ThemePackEditor";
import {
  CHAT_CONTENT_CARD_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "../components/chat/composerPickerStyles";
import {
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "../components/chat/chatHeaderControls";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../components/ui/autocomplete";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { Input } from "../components/ui/input";
import { SelectItem } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { RouteInsetSurface } from "../components/RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "../components/SidebarHeaderNavigationControls";
import { useDesktopCustomTitleBarState } from "../hooks/useDesktopCustomTitleBar";
import { useDesktopTopBarTrafficLightGutterClassName } from "../hooks/useDesktopTopBarGutter";
import { useKeepAwakeState } from "../hooks/useKeepAwakeState";
import { KeepAwakeSettingsSection } from "../components/KeepAwakeControls";
import { useTheme } from "../hooks/useTheme";
import { isUiDensity } from "../lib/appDensity";
import { isChatWidthMode, type ChatWidthMode } from "../lib/chatWidth";
import { isElectron } from "../env";
import { ResetIcon } from "../lib/icons";
import {
  cn,
  getNavigatorPlatform,
  isLinuxPlatform,
  isMacPlatform,
  isWindowsPlatform,
} from "../lib/utils";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import { isProviderKind, sameProviderOrder } from "../providerOrdering";
import {
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  SETTINGS_TARGETS,
  settingRowAnchorId,
} from "../settingsNavigation";
import { SETTINGS_PAGE_BACKGROUND_CLASS_NAME } from "../settingsPanelStyles";
import { isAudioLevelAvailable } from "../lib/audioLevel";

// ── Settings taxonomy ──────────────────────────────────────────────────────

const UI_DENSITY_OPTIONS = [
  {
    value: "compact",
    label: "settings:densityOptions_compact",
    description: "settings:densityOptions_compactDescription",
  },
  {
    value: "comfortable",
    label: "settings:densityOptions_comfortable",
    description: "settings:densityOptions_comfortableDescription",
  },
  {
    value: "spacious",
    label: "settings:densityOptions_spacious",
    description: "settings:densityOptions_spaciousDescription",
  },
] as const satisfies ReadonlyArray<{
  value: UiDensity;
  label: string;
  description: string;
}>;

const CHAT_WIDTH_OPTIONS = [
  {
    value: "standard",
    label: "chat:standard",
    description: "settings:keepsTheChatColumnAtTheDefaultReadingWidth",
  },
  {
    value: "wide",
    label: "settings:wide",
    description: "settings:givesTablesAndWideContentMoreRoom72rem",
  },
  {
    value: "full",
    label: "settings:full",
    description: "settings:letsTheChatColumnUseTheFullWindowWidth",
  },
] as const satisfies ReadonlyArray<{
  value: ChatWidthMode;
  label: string;
  description: string;
}>;

const PROVIDER_SELECT_OPTIONS = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.kind);

const TIMESTAMP_FORMAT_LABELS = {
  locale: "common:theme_systemDefault",
  "12-hour": "settings:12Hour",
  "24-hour": "settings:timestamp_24hour",
} as const;

const SIDEBAR_PROJECT_SORT_ORDER_LABELS = {
  updated_at: "settings:sortLabels_recentlyActive",
  created_at: "settings:sortLabels_recentlyAdded",
  manual: "settings:sortLabels_manualOrder",
} as const;

const SIDEBAR_THREAD_SORT_ORDER_LABELS = {
  updated_at: "settings:sortLabels_recentlyActive",
  created_at: "settings:sortLabels_newestFirst",
} as const;

const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  { value: "queue", label: "settings:queue" },
  { value: "steer", label: "chat:queuedActions_steer" },
] as const satisfies ReadonlyArray<{ value: FollowUpBehavior; label: string }>;

const SIDECHAT_EXPIRY_OPTIONS = [
  { value: "1h", label: "settings:1Hour" },
  { value: "24h", label: "settings:24Hours" },
  { value: "never", label: "settings:detail_never" },
] as const satisfies ReadonlyArray<{ value: SidechatExpiry; label: string }>;

const GITHUB_LINK_OPEN_TARGET_LABELS = {
  app: "settings:inSynara",
  browser: "settings:inAppBrowser",
  external: "settings:externalBrowser",
} as const satisfies Record<GitHubLinkOpenTarget, string>;

const MESSAGE_TRAIL_AUDIO_SOURCE_OPTIONS = [
  { value: "off", label: "automation:traitsPicker_off" },
  { value: "system", label: "settings:macAudio" },
  { value: "microphone", label: "settings:microphone" },
  { value: "both", label: "settings:both" },
] as const satisfies ReadonlyArray<{ value: MessageTrailAudioSource; label: string }>;

// Select items need a non-empty value; "" in settings means the Mac's default input.
const MAC_DEFAULT_MICROPHONE_VALUE = "mac-default";

function microphoneLabel(device: DesktopAudioInputDevice): string {
  return device.bluetooth ? `${device.name} (Bluetooth)` : device.name;
}

function MessageTrailMicrophoneRow({
  value,
  defaultValue,
  onChange,
}: {
  value: string;
  defaultValue: string;
  onChange: (microphoneId: string) => void;
}) {
  const { t } = useTranslation();

  const [devices, setDevices] = useState<readonly DesktopAudioInputDevice[]>([]);

  // Listing only reads device names; plugging a device in or out refreshes it.
  useEffect(() => {
    const audioLevel = window.desktopBridge?.audioLevel;
    if (!audioLevel) return;
    let cancelled = false;
    const refresh = () => {
      void audioLevel
        .listMicrophones()
        .then((next) => {
          if (!cancelled) setDevices(next);
        })
        .catch(() => undefined);
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, []);

  const macDefault = devices.find((device) => device.default);
  const selected = devices.find((device) => device.id === value);
  const macDefaultLabel = macDefault
    ? t("settings:macDefault2", { microphone: microphoneLabel(macDefault) })
    : t("settings:macDefault");
  const valueContent = !value
    ? macDefaultLabel
    : selected
      ? microphoneLabel(selected)
      : t("common:toast_notConnected");

  return (
    <SettingsRow
      id="setting-message-trail-microphone"
      title="settings:messageTrailMicrophone"
      description="settings:microphoneTheMessageTrailListensToPickABuilt"
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton
            label={t("settings:messageTrailMicrophone2")}
            onClick={() => onChange(defaultValue)}
          />
        ) : null
      }
      control={
        <SettingsSelectControl
          value={value || MAC_DEFAULT_MICROPHONE_VALUE}
          onValueChange={(next) => onChange(next === MAC_DEFAULT_MICROPHONE_VALUE ? "" : next)}
          ariaLabel={t("settings:messageTrailMicrophone")}
          triggerClassName="w-full sm:w-64"
          valueContent={valueContent}
        >
          <SelectItem hideIndicator value={MAC_DEFAULT_MICROPHONE_VALUE}>
            {macDefaultLabel}
          </SelectItem>
          {devices.map((device) => (
            <SelectItem hideIndicator key={device.id} value={device.id}>
              {microphoneLabel(device)}
            </SelectItem>
          ))}
          {value && !selected ? (
            <SelectItem hideIndicator value={value}>
              {t("common:toast_notConnected")}
            </SelectItem>
          ) : null}
        </SettingsSelectControl>
      }
    />
  );
}

const VOICE_ENTER_BEHAVIOR_OPTIONS = [
  { value: "stop", label: "chat:stop" },
  { value: "send", label: "settings:stopAndSend" },
] as const satisfies ReadonlyArray<{ value: VoiceEnterBehavior; label: string }>;

// ── Settings UI primitives ────────────────────────────────────────────────

// Shared settings controls live in ~/components/settings/SettingControls.

function isProviderSelectOption(value: string): value is ProviderKind {
  return PROVIDER_SELECT_OPTIONS.includes(value as ProviderKind);
}
// Keys of AppSettings whose value is a plain boolean — the only ones that can be
// driven by the shared on/off toggle row below.
type BooleanSettingKey = {
  [Key in keyof AppSettings]-?: AppSettings[Key] extends boolean ? Key : never;
}[keyof AppSettings];

// ── Route screen ───────────────────────────────────────────────────────────

function SettingsRouteView() {
  const { t, locale } = useTranslation();
  const [defaultDiffRenderMode, setDefaultDiffRenderMode] = useLocalStorage(
    DIFF_RENDER_MODE_STORAGE_KEY,
    DEFAULT_DIFF_RENDER_MODE,
    DiffRenderModeSchema,
  );
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const activeSection = normalizeSettingsSection(routeSearch.section);
  const settingsTarget = typeof routeSearch.target === "string" ? routeSearch.target : null;
  const settingsProviderTarget =
    typeof routeSearch.provider === "string" && isProviderKind(routeSearch.provider)
      ? routeSearch.provider
      : null;
  const activeSectionItem = SETTINGS_NAV_ITEMS.find((item) => item.id === activeSection)!;

  const {
    isDefaultActiveTheme,
    resetAllThemes,
    resolvedTheme,
    theme,
    setTheme,
    systemUiFont,
    setSystemUiFont,
  } = useTheme();
  const { settings, defaults, updateSettings, updateSettingsAndWait, resetSettings } =
    useAppSettings();
  const languagePreference = resolveLanguagePreference(settings.language);
  const keepAwake = useKeepAwakeState();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const [releaseHistoryOpen, setReleaseHistoryOpen] = useState(false);
  const [resetEpoch, setResetEpoch] = useState(0);
  const platform = getNavigatorPlatform();
  const desktopFlavor = useMemo(
    () =>
      desktopFlavorFromProtocol(
        typeof window === "undefined" ? undefined : window.location?.protocol,
        import.meta.env.DEV,
      ),
    [],
  );
  const defaultDesktopAppIcon = defaultDesktopAppIconForFlavor(desktopFlavor);
  const shouldShowFontSmoothing = isMacPlatform(platform);
  const supportsCustomTitleBarSetting =
    isElectron && (isWindowsPlatform(platform) || isLinuxPlatform(platform));
  const customTitleBarState = useDesktopCustomTitleBarState();
  const customTitleBarRestartRequired =
    customTitleBarState.supported && settings.useCustomTitleBar !== customTitleBarState.active;
  const customTitleBarPreferenceDirty =
    supportsCustomTitleBarSetting &&
    (settings.useCustomTitleBar !== defaults.useCustomTitleBar ||
      (customTitleBarState.supported &&
        customTitleBarState.preference !== defaults.useCustomTitleBar));

  function showCustomTitleBarRestartToast(): void {
    toastManager.add({
      type: "warning",
      title: t("settings:restartToApplyTitleBar"),
      description: t("settings:theWindowFrameUpdatesTheNextTimeSynaraLaunches"),
      actionProps: {
        "aria-label": t("settings:restartSynara"),
        children: t("settings:restartAction"),
        onClick: () => {
          void window.desktopBridge?.customTitleBar?.relaunch();
        },
      },
    });
  }

  async function persistCustomTitleBarPreference(
    enabled: boolean,
  ): Promise<{ readonly restartRequired: boolean } | null> {
    try {
      const bridge = window.desktopBridge?.customTitleBar;
      if (!bridge) throw new Error("Desktop title bar bridge is unavailable.");
      const state = await bridge.setPreference(enabled);
      if (!state.supported || state.preference !== enabled) {
        throw new Error("Desktop title bar preference was not persisted.");
      }
      return state;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:couldNotUpdateTitleBar"),
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function applyCustomTitleBarPreference(enabled: boolean): Promise<void> {
    const previous = settings.useCustomTitleBar;
    updateSettings({ useCustomTitleBar: enabled });
    const state = await persistCustomTitleBarPreference(enabled);
    if (state === null) {
      updateSettings({ useCustomTitleBar: previous });
      return;
    }
    if (state.restartRequired) showCustomTitleBarRestartToast();
  }

  const visibleTerminalFontFamilySuggestions = useMemo(() => {
    const query = settings.terminalFontFamily.trim().toLowerCase();
    if (!query) return TERMINAL_FONT_FAMILY_SUGGESTIONS;
    return TERMINAL_FONT_FAMILY_SUGGESTIONS.filter((suggestion) =>
      suggestion.toLowerCase().includes(query),
    );
  }, [settings.terminalFontFamily]);

  const isGitTextGenerationModelDirty = isGitTextGenerationSettingsDirty(settings, defaults);
  const isInstallSettingsDirty = isProviderInstallSettingsDirty(settings, defaults);
  const hiddenProviderCount = new Set(settings.hiddenProviders).size;
  const enabledProviderSelectOptions = PROVIDER_SELECT_OPTIONS.filter(
    (provider) => !settings.disabledProviders.includes(provider),
  );
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const isProviderActivityDirty =
    settings.disabledProviders.length !== defaults.disabledProviders.length ||
    settings.disabledProviders.some(
      (provider, index) => provider !== defaults.disabledProviders[index],
    );

  // Deep links and sidebar search targets all resolve to stable DOM ids in the active panel.
  useEffect(() => {
    if (!settingsTarget) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(settingsTarget)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, settingsTarget]);

  const changedSettingLabels = [
    ...(settings.language !== defaults.language ? ["common:general_languageAria"] : []),
    ...(theme !== "system" ? ["onboarding:changed_theme"] : []),
    ...(!isDefaultActiveTheme
      ? [resolvedTheme === "dark" ? "settings:darkThemePack" : "settings:lightThemePack"]
      : []),
    ...(settings.defaultProvider !== defaults.defaultProvider
      ? ["settings:changed_defaultProvider"]
      : []),
    ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode
      ? ["settings:changed_newThreadMode"]
      : []),
    ...(settings.anchorSentMessagesToTop !== defaults.anchorSentMessagesToTop
      ? ["settings:moveSentMessagesToTop"]
      : []),
    ...(settings.showOpenThreadTabs !== defaults.showOpenThreadTabs ? ["settings:threadTabs"] : []),
    ...(settings.archiveDeletesOrphanedWorktree !== defaults.archiveDeletesOrphanedWorktree
      ? ["settings:deleteWorktreeOnArchive"]
      : []),
    ...(settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder
      ? ["settings:changed_projectSortOrder"]
      : []),
    ...(settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder
      ? ["settings:changed_threadSortOrder"]
      : []),
    ...(settings.sidebarThreadAttentionFirst !== defaults.sidebarThreadAttentionFirst
      ? ["workspace:workingAndUnreadOnTop"]
      : []),
    ...(settings.showChatsSection !== defaults.showChatsSection
      ? ["settings:changed_chatsSection"]
      : []),
    ...(GROUPS_ON && settings.showGroupsSection !== defaults.showGroupsSection
      ? ["settings:hubsSection"]
      : []),
    ...(settings.showAutomationRunThreads !== defaults.showAutomationRunThreads
      ? ["settings:automationRuns"]
      : []),
    ...(settings.showAsciiBackground !== defaults.showAsciiBackground ? ["ASCII background"] : []),
    ...(settings.uiDensity !== defaults.uiDensity ? ["settings:changed_uiDensity"] : []),
    ...(settings.chatWidth !== defaults.chatWidth ? ["settings:chatWidth"] : []),
    ...(settings.desktopAppIcon !== defaultDesktopAppIcon ? ["settings:appIcon"] : []),
    ...(customTitleBarPreferenceDirty ? ["settings:customTitleBar"] : []),
    ...(settings.chatFontSizePx !== defaults.chatFontSizePx
      ? ["settings:changed_baseFontSize"]
      : []),
    ...(settings.terminalFontSizePx !== defaults.terminalFontSizePx
      ? ["settings:changed_terminalFontSize"]
      : []),
    ...(settings.terminalFontFamily !== defaults.terminalFontFamily
      ? ["settings:changed_terminalFont"]
      : []),
    ...(shouldShowFontSmoothing &&
    settings.enableNativeFontSmoothing !== defaults.enableNativeFontSmoothing
      ? ["settings:changed_fontSmoothing"]
      : []),
    ...(settings.timestampFormat !== defaults.timestampFormat
      ? ["settings:changed_timeFormat"]
      : []),
    ...(settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts
      ? ["settings:changed_activityToasts"]
      : []),
    ...(settings.enableSystemTaskCompletionNotifications !==
    defaults.enableSystemTaskCompletionNotifications
      ? ["settings:changed_desktopNotifications"]
      : []),
    ...(settings.notifyAfterSubagentsFinish !== defaults.notifyAfterSubagentsFinish
      ? ["settings:waitForSubagents"]
      : []),
    ...(settings.enableAssistantStreaming !== defaults.enableAssistantStreaming
      ? ["settings:changed_assistantOutput"]
      : []),
    ...(settings.collapseFinishedTurns !== defaults.collapseFinishedTurns
      ? ["settings:foldFinishedTurns"]
      : []),
    ...(settings.composerEffortSlider !== defaults.composerEffortSlider
      ? ["settings:effortSlider"]
      : []),
    ...(settings.messageTrailAudioSource !== defaults.messageTrailAudioSource
      ? ["settings:messageTrailSound"]
      : []),
    ...(settings.messageTrailMicrophoneId !== defaults.messageTrailMicrophoneId
      ? ["settings:messageTrailMicrophone"]
      : []),
    ...(settings.followUpBehavior !== defaults.followUpBehavior
      ? ["settings:followUpBehavior"]
      : []),
    ...(settings.sidechatExpiry !== defaults.sidechatExpiry ? ["settings:sideChatExpiry"] : []),
    ...(settings.voiceEnterBehavior !== defaults.voiceEnterBehavior
      ? ["settings:enterWhileDictating"]
      : []),
    ...(settings.autoOpenDevicePane !== defaults.autoOpenDevicePane
      ? ["settings:automaticallyOpenSimulator"]
      : []),
    ...(settings.enableAppSnap !== defaults.enableAppSnap ? ["settings:appSnap"] : []),
    ...(!sameAppSnapShortcut(settings.appSnapShortcut, defaults.appSnapShortcut)
      ? ["settings:appSnapShortcut"]
      : []),
    ...(settings.appSnapPlaySound !== defaults.appSnapPlaySound
      ? ["settings:appSnapCaptureSound"]
      : []),
    ...(settings.computerControlEnabled !== defaults.computerControlEnabled
      ? ["settings:computerControl"]
      : []),
    ...(settings.autoOpenComputerPane !== defaults.autoOpenComputerPane
      ? ["settings:computerPreviewAutoOpen"]
      : []),
    ...(settings.agentCursorColorMode !== defaults.agentCursorColorMode
      ? ["settings:agentCursorColors"]
      : []),
    ...(settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks
      ? ["settings:changed_providerUpdateChecks"]
      : []),
    ...(settings.lowerProviderProcessPriority !== defaults.lowerProviderProcessPriority
      ? ["settings:keepSynaraResponsive"]
      : []),
    ...(defaultDiffRenderMode !== DEFAULT_DIFF_RENDER_MODE ? ["settings:diffLayout"] : []),
    ...(settings.diffWordWrap !== defaults.diffWordWrap
      ? ["settings:changed_diffLineWrapping"]
      : []),
    ...(settings.githubLinkOpenTarget !== defaults.githubLinkOpenTarget
      ? ["settings:openPullRequestsAndIssues"]
      : []),
    ...(settings.showPullRequestDiffColors !== defaults.showPullRequestDiffColors
      ? ["settings:pullRequestDiffColors"]
      : []),
    ...(settings.githubInboxIncludeUpstreams !== defaults.githubInboxIncludeUpstreams
      ? ["settings:includeForkUpstreams"]
      : []),
    ...(settings.confirmThreadDelete !== defaults.confirmThreadDelete
      ? ["settings:changed_deleteConfirmation"]
      : []),
    ...(settings.confirmThreadArchive !== defaults.confirmThreadArchive
      ? ["settings:changed_archiveConfirmation"]
      : []),
    ...(settings.confirmTerminalTabClose !== defaults.confirmTerminalTabClose
      ? ["settings:changed_terminalCloseConfirmation"]
      : []),
    ...(isGitTextGenerationModelDirty ? ["settings:changed_gitWritingModel"] : []),
    ...(settings.sourceControlWritingStyle !== defaults.sourceControlWritingStyle ||
    settings.sourceControlCustomInstructions !== defaults.sourceControlCustomInstructions
      ? ["settings:sourceControlWritingStyle"]
      : []),
    ...(settings.customCodexModels.length > 0 ||
    settings.customClaudeModels.length > 0 ||
    settings.customCursorModels.length > 0 ||
    settings.customAntigravityModels.length > 0 ||
    settings.customGrokModels.length > 0 ||
    settings.customDroidModels.length > 0 ||
    settings.customOpenCodeModels.length > 0 ||
    settings.customPiModels.length > 0
      ? ["settings:changed_customModels"]
      : []),
    ...(isInstallSettingsDirty ? ["settings:changed_providerInstalls"] : []),
    ...(isProviderActivityDirty ? ["settings:providerActivity"] : []),
    ...(hiddenProviderCount > 0 ? ["settings:changed_providerVisibility"] : []),
    ...(isProviderOrderDirty ? ["settings:changed_providerOrder"] : []),
  ].map((label) => t(label));

  async function restoreDefaults() {
    if (changedSettingLabels.length === 0) return;

    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      [
        t("settings:restoreDefaultSettings"),
        t("settings:thisWillReset", {
          settings: new Intl.ListFormat(locale).format(changedSettingLabels),
        }),
      ].join("\n"),
    );
    if (!confirmed) return;

    if (customTitleBarPreferenceDirty) {
      const state = await persistCustomTitleBarPreference(defaults.useCustomTitleBar);
      if (state === null) return;
      if (state.restartRequired) showCustomTitleBarRestartToast();
    }

    setTheme("system");
    resetAllThemes();
    setDefaultDiffRenderMode(DEFAULT_DIFF_RENDER_MODE);
    await resetSettings();
    setResetEpoch((current) => current + 1);
  }

  // Shared on/off settings row: a labelled Switch bound to a boolean AppSettings
  // key, with the standard "reset to default" affordance shown only when changed.
  // Rows with bespoke controls (e.g. the desktop-notifications Test button) keep
  // their own markup instead of using this helper.
  const renderBooleanSettingRow = (config: {
    settingKey: BooleanSettingKey;
    id: string;
    title: string;
    description: string;
    resetLabel: string;
    ariaLabel: string;
  }) => {
    const { settingKey, id, title, description, resetLabel, ariaLabel } = config;
    const isChanged = settings[settingKey] !== defaults[settingKey];
    return (
      <SettingsRow
        id={id}
        title={title}
        description={description}
        resetAction={
          isChanged ? (
            <SettingResetButton
              label={resetLabel}
              onClick={() =>
                updateSettings({ [settingKey]: defaults[settingKey] } as Partial<AppSettings>)
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings[settingKey]}
            onCheckedChange={(checked) =>
              updateSettings({ [settingKey]: Boolean(checked) } as Partial<AppSettings>)
            }
            aria-label={ariaLabel}
          />
        }
      />
    );
  };

  const renderGeneralPanel = () => (
    <div className="space-y-6">
      <SafariAccessSetupButton />
      <BetaChannelSettingsPanel active={true} />
      <SettingsSection title="settings:general_coreDefaults">
        <SettingsRow
          id="setting-language"
          status={<EditorLanguageReloadNotice />}
          title="common:general_languageAria"
          description="settings:chooseTheLanguageUsedByTheInterfaceSystemFollows"
          resetAction={
            settings.language !== defaults.language ? (
              <SettingResetButton
                label={t("common:language")}
                onClick={() => updateSettings({ language: defaults.language })}
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={languagePreference}
              onValueChange={(language) => {
                if (AVAILABLE_LANGUAGE_PREFERENCES.includes(language as LanguagePreference)) {
                  updateSettings({ language: language as LanguagePreference });
                }
              }}
              ariaLabel={t("common:general_languageAria")}
              valueContent={
                languagePreference === "system"
                  ? t("common:themeOptions_system")
                  : UI_LOCALE_REGISTRY[languagePreference].nativeName
              }
            >
              <SelectItem value="system">{t("common:themeOptions_system")}</SelectItem>
              {UI_LOCALES.map((locale) => (
                <SelectItem key={locale} value={locale}>
                  {UI_LOCALE_REGISTRY[locale].nativeName}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
        <SettingsRow
          id="setting-default-provider"
          title="settings:changed_defaultProvider"
          description="settings:providerUsedForNewChatsUntilYouPickA"
          resetAction={
            settings.defaultProvider !== defaults.defaultProvider ? (
              <SettingResetButton
                label={t("settings:defaultProvider")}
                onClick={() => updateSettings({ defaultProvider: defaults.defaultProvider })}
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={
                settings.disabledProviders.includes(settings.defaultProvider)
                  ? null
                  : settings.defaultProvider
              }
              disabled={enabledProviderSelectOptions.length === 0}
              onValueChange={(value) => {
                if (!isProviderSelectOption(value) || settings.disabledProviders.includes(value))
                  return;
                updateSettings({ defaultProvider: value });
              }}
              ariaLabel={t("settings:changed_defaultProvider")}
              valueContent={
                settings.disabledProviders.includes(settings.defaultProvider) ? (
                  "Choose an enabled provider"
                ) : (
                  <ProviderOptionLabel
                    provider={settings.defaultProvider}
                    label={PROVIDER_DISPLAY_NAMES[settings.defaultProvider]}
                  />
                )
              }
            >
              {enabledProviderSelectOptions.map((provider) => (
                <SelectItem hideIndicator key={provider} value={provider}>
                  <ProviderOptionLabel
                    provider={provider}
                    label={PROVIDER_DISPLAY_NAMES[provider]}
                  />
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          id="setting-new-threads"
          title="settings:general_newThreads"
          description="settings:pickTheDefaultWorkspaceModeForNewlyCreatedDraft"
          resetAction={
            settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
              <SettingResetButton
                label={t("settings:newThreads")}
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value !== "local" && value !== "worktree") return;
                updateSettings({
                  defaultThreadEnvMode: value,
                });
              }}
              ariaLabel={t("settings:general_defaultThreadMode")}
              valueContent={
                settings.defaultThreadEnvMode === "worktree"
                  ? t("chat:general_newWorktree")
                  : t("computer:worktreeMode_local")
              }
            >
              <SelectItem hideIndicator value="local">
                {t("computer:worktreeMode_local")}
              </SelectItem>
              <SelectItem hideIndicator value="worktree">
                {t("chat:general_newWorktree")}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        {renderBooleanSettingRow({
          id: "setting-delete-worktree-on-archive",
          settingKey: "archiveDeletesOrphanedWorktree",
          title: "settings:deleteWorktreeOnArchive",
          description: t("settings:afterArchiveSUndoPeriodRemoveACleanWorktree"),
          resetLabel: t("settings:deleteWorktreeOnArchive2"),
          ariaLabel: t("settings:deleteWorktreeOnArchive"),
        })}

        {renderBooleanSettingRow({
          id: "setting-move-sent-messages-to-top",
          settingKey: "anchorSentMessagesToTop",
          title: "settings:moveSentMessagesToTop",
          description: t("settings:moveEachSentMessageToTheTopOfThe"),
          resetLabel: t("settings:moveSentMessagesToTop2"),
          ariaLabel: t("settings:moveSentMessagesToTop"),
        })}

        {renderBooleanSettingRow({
          id: "setting-thread-tabs",
          settingKey: "showOpenThreadTabs",
          title: "settings:threadTabs",
          description: t("settings:showOpenThreadsAsTabsInTheChatHeader2"),
          resetLabel: t("settings:threadTabs2"),
          ariaLabel: t("settings:showOpenThreadsAsTabsInTheChatHeader"),
        })}

        <SettingsRow
          id="setting-welcome-tour"
          title="settings:welcomeTour"
          description="settings:replayTheFirstRunSetupFeatureTourProviderSelection"
          control={
            <Button
              variant="outline"
              onClick={() => useOnboardingDialogStore.getState().openDialog()}
            >
              {t("settings:openWelcomeTour")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="settings:general_sidebarOrganization">
        <SettingsRow
          id="setting-project-order"
          title="settings:general_projectOrder"
          description="settings:controlsHowProjectsAreArrangedInTheMainSidebar"
          resetAction={
            settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder ? (
              <SettingResetButton
                label={t("settings:projectOrder")}
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: defaults.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (value !== "updated_at" && value !== "created_at" && value !== "manual") {
                  return;
                }
                updateSettings({ sidebarProjectSortOrder: value });
              }}
              ariaLabel={t("settings:changed_projectSortOrder")}
              valueContent={t(SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder])}
            >
              <SelectItem hideIndicator value="updated_at">
                {t(SIDEBAR_PROJECT_SORT_ORDER_LABELS.updated_at)}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {t(SIDEBAR_PROJECT_SORT_ORDER_LABELS.created_at)}
              </SelectItem>
              <SelectItem hideIndicator value="manual">
                {t(SIDEBAR_PROJECT_SORT_ORDER_LABELS.manual)}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        <SettingsRow
          id="setting-thread-order"
          title="settings:general_threadOrder"
          description="settings:controlsHowThreadsAreArrangedInsideEachProjectIn"
          resetAction={
            settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder ? (
              <SettingResetButton
                label={t("settings:threadOrder")}
                onClick={() =>
                  updateSettings({
                    sidebarThreadSortOrder: defaults.sidebarThreadSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.sidebarThreadSortOrder}
              onValueChange={(value) => {
                if (value !== "updated_at" && value !== "created_at") {
                  return;
                }
                updateSettings({ sidebarThreadSortOrder: value });
              }}
              ariaLabel={t("settings:changed_threadSortOrder")}
              valueContent={t(SIDEBAR_THREAD_SORT_ORDER_LABELS[settings.sidebarThreadSortOrder])}
            >
              <SelectItem hideIndicator value="updated_at">
                {t(SIDEBAR_THREAD_SORT_ORDER_LABELS.updated_at)}
              </SelectItem>
              <SelectItem hideIndicator value="created_at">
                {t(SIDEBAR_THREAD_SORT_ORDER_LABELS.created_at)}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        {renderBooleanSettingRow({
          id: "setting-working-and-unread-on-top",
          settingKey: "sidebarThreadAttentionFirst",
          title: "workspace:workingAndUnreadOnTop",
          description: t("settings:withRecentlyActiveOrderMoveWorkingAndUnreadThreads2"),
          resetLabel: t("settings:workingAndUnreadOnTop"),
          ariaLabel: t("settings:moveWorkingAndUnreadThreadsToTheTopOf"),
        })}
      </SettingsSection>

      <SettingsSection title="settings:general_sidebarSections">
        {renderBooleanSettingRow({
          id: "setting-chats",
          settingKey: "showChatsSection",
          title: "workspace:general_chats",
          description: t("settings:showTheStandaloneChatsListInTheSidebarFooter"),
          resetLabel: t("settings:chatsSection"),
          ariaLabel: t("settings:showTheChatsSectionInTheSidebar"),
        })}

        {GROUPS_ON
          ? renderBooleanSettingRow({
              id: "setting-hubs",
              settingKey: "showGroupsSection",
              title: "common:hubs",
              description: t("settings:showTheHubsTabInTheSidebarSwitcher"),
              resetLabel: t("settings:hubsSection2"),
              ariaLabel: t("settings:showTheHubsSectionInTheSidebar"),
            })
          : null}

        {renderBooleanSettingRow({
          id: "setting-automation-runs",
          settingKey: "showAutomationRunThreads",
          title: "settings:automationRuns",
          description: t("settings:showTheThreadEachStandaloneAutomationRunCreatesRuns"),
          resetLabel: t("settings:automationRuns2"),
          ariaLabel: t("settings:showAutomationRunThreadsInTheSidebar"),
        })}
      </SettingsSection>

      <div id={SETTINGS_TARGETS.environmentPanel} className="space-y-6">
        <SettingsSection title="settings:environmentPanel">
          {renderBooleanSettingRow({
            id: "setting-open-by-default",
            settingKey: "environmentPanelDefaultOpen",
            title: "settings:openByDefault",
            description: t("settings:openTheChatEnvironmentPanelAutomaticallyOnNormalThreads2"),
            resetLabel: t("settings:environmentPanelDefaultOpen"),
            ariaLabel: t("settings:openTheEnvironmentPanelByDefaultOnNormalThreads"),
          })}
        </SettingsSection>

        <SettingsSection title="settings:codeAndStatus">
          {renderBooleanSettingRow({
            id: "setting-subagents",
            settingKey: "showEnvironmentSubagents",
            title: "chat:subagents",
            description: t("settings:showACompactSummaryOfTheChatSSubagents"),
            resetLabel: t("settings:subagentsSection"),
            ariaLabel: t("settings:showTheSubagentsSectionInTheEnvironmentPanel"),
          })}

          {renderBooleanSettingRow({
            id: "setting-usage",
            settingKey: "showEnvironmentUsage",
            title: "chat:general_usage",
            description: t("settings:showTheProviderUsageRowInTheChatEnvironment"),
            resetLabel: t("settings:usageSection"),
            ariaLabel: t("settings:showTheUsageSectionInTheEnvironmentPanel"),
          })}

          {renderBooleanSettingRow({
            id: "setting-repository",
            settingKey: "showEnvironmentRepository",
            title: "git:general_repository",
            description: t("settings:showTheGitHubRepositoryLinkInTheChatEnvironment2"),
            resetLabel: t("settings:repositorySection"),
            ariaLabel: t("settings:showTheRepositorySectionInTheEnvironmentPanel"),
          })}

          {renderBooleanSettingRow({
            id: "setting-pull-request",
            settingKey: "showEnvironmentPullRequest",
            title: "git:general_environmentPullRequest",
            description: t("settings:showTheOpenPullRequestCIChecksAndReview2"),
            resetLabel: t("settings:pullRequestSection"),
            ariaLabel: t("settings:showThePullRequestSectionInTheEnvironmentPanel"),
          })}

          {renderBooleanSettingRow({
            id: "setting-editor",
            settingKey: "showEnvironmentEditor",
            title: "chat:general_editor",
            description: t("settings:showTheEditorSectionInAppEditorViewAnd2"),
            resetLabel: t("settings:editorSection"),
            ariaLabel: t("settings:showTheEditorSectionInTheEnvironmentPanel"),
          })}

          {renderBooleanSettingRow({
            id: "setting-actions",
            settingKey: "showEnvironmentActions",
            title: "workspace:actions",
            description: t("settings:environmentActionsDescription"),
            resetLabel: t("settings:actionsSection"),
            ariaLabel: t("settings:environmentActionsLabel"),
          })}
        </SettingsSection>

        <SettingsSection title="settings:contextAndNotes">
          {renderBooleanSettingRow({
            id: "setting-recap",
            settingKey: "showEnvironmentRecap",
            title: "chat:recap_label",
            description: t("settings:showTheAutoGeneratedChatRecapInTheEnvironment"),
            resetLabel: t("settings:recapSection"),
            ariaLabel: t("settings:showTheRecapSectionInTheEnvironmentPanel"),
          })}

          {renderBooleanSettingRow({
            id: "setting-pinned-messages",
            settingKey: "showEnvironmentPinned",
            title: "settings:general_pinnedMessages",
            description: t("settings:showThePinnedMessagesChecklistInTheEnvironmentPanel"),
            resetLabel: t("settings:pinnedMessagesSection"),
            ariaLabel: t("settings:showThePinnedMessagesSectionInTheEnvironmentPanel"),
          })}

          {renderBooleanSettingRow({
            id: "setting-project-instructions",
            settingKey: "showEnvironmentInstructions",
            title: "workspace:general_projectInstructions",
            description: t("settings:showProjectLevelInstructionsInTheEnvironmentPanel"),
            resetLabel: t("settings:projectInstructionsSection"),
            ariaLabel: t("settings:showTheProjectInstructionsSectionInTheEnvironmentPanel"),
          })}

          {renderBooleanSettingRow({
            id: "setting-notepad",
            settingKey: "showEnvironmentNotepad",
            title: "chat:general_notepad",
            description: t("settings:showThePerThreadNotepadInTheEnvironmentPanel"),
            resetLabel: t("settings:notepadSection"),
            ariaLabel: t("settings:showTheNotepadSectionInTheEnvironmentPanel"),
          })}
        </SettingsSection>
      </div>

      <SettingsSection title="settings:chatTopBar">
        {renderBooleanSettingRow({
          id: "setting-hand-off",
          settingKey: "showHeaderHandoff",
          title: "common:header_handOff",
          description: t("settings:headerHandoffDescription"),
          resetLabel: t("settings:headerHandoffReset"),
          ariaLabel: t("settings:headerHandoffLabel"),
        })}

        {renderBooleanSettingRow({
          id: "setting-project-actions",
          settingKey: "showHeaderActions",
          title: "workspace:projectActions",
          description: t("settings:headerActionsDescription"),
          resetLabel: t("settings:headerActionsReset"),
          ariaLabel: t("settings:headerActionsLabel"),
        })}
      </SettingsSection>
    </div>
  );

  const renderAppearancePanel = () => (
    <div className="space-y-6">
      <SettingsSectionShell
        title="onboarding:changed_theme"
        action={
          theme !== "system" ? (
            <SettingResetButton label={t("workspace:theme")} onClick={() => setTheme("system")} />
          ) : null
        }
      >
        {/* The mode picker is the one settings control that sits directly on the page
            instead of inside a card — the mockups are the whole UI, so boxing them in
            a card reads as chrome around chrome. The anchor keeps search deep-links
            (`?target=setting-theme`) working without the SettingsRow. */}
        <div id={settingRowAnchorId("Theme")} className="scroll-mt-24 pb-1.5">
          <ThemeModePicker
            value={theme}
            onValueChange={setTheme}
            ariaLabel={t("onboarding:themePreference")}
          />
        </div>

        <div className="space-y-3">
          {(resolvedTheme === "dark"
            ? (["dark", "light"] as const)
            : (["light", "dark"] as const)
          ).map((variant) => (
            <ThemePackEditor
              key={variant}
              variant={variant}
              isActive={resolvedTheme === variant}
              mode={theme}
            />
          ))}
        </div>
      </SettingsSectionShell>

      {isElectron ? (
        <SettingsSection title="computer:nav_app">
          <SettingsRow
            id="setting-app-icon"
            title="settings:appIcon"
            description="settings:chooseTheIconSynaraUsesInTheDockOr"
            resetAction={
              settings.desktopAppIcon !== defaultDesktopAppIcon ? (
                <SettingResetButton
                  label={t("settings:appIcon2")}
                  onClick={() => updateSettings({ desktopAppIcon: defaultDesktopAppIcon })}
                />
              ) : null
            }
            control={
              <AppIconPicker
                platform={platform}
                value={settings.desktopAppIcon}
                onValueChange={async (desktopAppIcon) => {
                  if (desktopAppIcon !== settings.desktopAppIcon) {
                    updateSettings({ desktopAppIcon });
                  }
                  await window.desktopBridge?.setAppIcon(desktopAppIcon);
                }}
              />
            }
          />
          {supportsCustomTitleBarSetting ? (
            <SettingsRow
              id="setting-use-custom-title-bar"
              title="settings:useCustomTitleBar"
              description={
                customTitleBarRestartRequired
                  ? "settings:restartSynaraToApplySomeLinuxWindowManagersWork"
                  : "settings:replaceTheSystemTitleBarWithSynaraSFrameless"
              }
              status={customTitleBarRestartRequired ? t("settings:restartRequired") : undefined}
              resetAction={
                settings.useCustomTitleBar !== defaults.useCustomTitleBar ? (
                  <SettingResetButton
                    label={t("settings:customTitleBar2")}
                    onClick={() => {
                      void applyCustomTitleBarPreference(defaults.useCustomTitleBar);
                    }}
                  />
                ) : null
              }
              control={
                <div className="flex items-center gap-2">
                  {customTitleBarRestartRequired ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        void window.desktopBridge?.customTitleBar?.relaunch();
                      }}
                    >
                      {t("common:restart")}
                    </Button>
                  ) : null}
                  <Switch
                    checked={settings.useCustomTitleBar}
                    onCheckedChange={(checked) => {
                      void applyCustomTitleBarPreference(Boolean(checked));
                    }}
                    aria-label={t("settings:useCustomTitleBar")}
                  />
                </div>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title="settings:chatBackground">
        {renderBooleanSettingRow({
          id: "setting-ascii-background",
          settingKey: "showAsciiBackground",
          title: "settings:asciiBackground",
          description: t("settings:asciiBackgroundDescription"),
          resetLabel: t("settings:asciiBackground"),
          ariaLabel: t("settings:asciiBackground"),
        })}
      </SettingsSection>

      <SettingsSection title="settings:typographyAndSpacing">
        <SettingsRow
          id="setting-use-system-ui-font"
          title="settings:useSystemUIFont"
          description="settings:ignoreTheThemeSCustomUIFontAndRender"
          resetAction={
            !systemUiFont ? (
              <SettingResetButton
                label={t("settings:systemUIFont")}
                onClick={() => setSystemUiFont(true)}
              />
            ) : null
          }
          control={
            <Switch
              checked={systemUiFont}
              onCheckedChange={(checked) => setSystemUiFont(Boolean(checked))}
              aria-label={t("settings:useSystemUIFont")}
            />
          }
        />

        <SettingsRow
          id="setting-ui-density"
          title="settings:changed_uiDensity"
          description="settings:controlSpacingInTheSidebarComposerChatGuttersAnd"
          resetAction={
            settings.uiDensity !== defaults.uiDensity ? (
              <SettingResetButton
                label={t("settings:changed_uiDensity")}
                onClick={() =>
                  updateSettings({
                    uiDensity: DEFAULT_UI_DENSITY,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.uiDensity}
              onValueChange={(value) => {
                if (!isUiDensity(value)) {
                  return;
                }
                updateSettings({ uiDensity: value });
              }}
              ariaLabel={t("settings:changed_uiDensity")}
              options={UI_DENSITY_OPTIONS}
            />
          }
        />

        <SettingsRow
          id="setting-chat-width"
          title="settings:chatWidth"
          description="settings:controlHowWideTheChatColumnGrowsWideAnd"
          resetAction={
            settings.chatWidth !== defaults.chatWidth ? (
              <SettingResetButton
                label={t("settings:chatWidth2")}
                onClick={() =>
                  updateSettings({
                    chatWidth: DEFAULT_CHAT_WIDTH,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.chatWidth}
              onValueChange={(value) => {
                if (!isChatWidthMode(value)) {
                  return;
                }
                updateSettings({ chatWidth: value });
              }}
              ariaLabel={t("settings:chatWidth")}
              options={CHAT_WIDTH_OPTIONS}
            />
          }
        />

        <SettingsRow
          id="setting-base-font-size"
          title="settings:changed_baseFontSize"
          description="settings:adjustTheAppTextBaseInPixelsChatAnd2"
          resetAction={
            settings.chatFontSizePx !== defaults.chatFontSizePx ? (
              <SettingResetButton
                label={t("settings:baseFontSize")}
                onClick={() =>
                  updateSettings({
                    chatFontSizePx: defaults.chatFontSizePx,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Input
                type="number"
                size="sm"
                min={MIN_CHAT_FONT_SIZE_PX}
                max={MAX_CHAT_FONT_SIZE_PX}
                step={1}
                inputMode="numeric"
                variant="soft"
                className="w-full text-right sm:w-20"
                value={String(settings.chatFontSizePx)}
                onChange={(event) => {
                  const nextValue = event.target.value.trim();
                  if (nextValue.length === 0) return;
                  updateSettings({
                    chatFontSizePx: normalizeChatFontSizePx(Number(nextValue)),
                  });
                }}
                aria-label={t("settings:baseFontSizeInPixels")}
              />
              <span className="text-ui leading-snug text-muted-foreground">
                {t("settings:appearance_px")}
              </span>
            </div>
          }
        />

        <SettingsRow
          id="setting-terminal-font-size"
          title="settings:changed_terminalFontSize"
          description="settings:adjustTerminalTextIndependentlyFromTheAppAndChat"
          resetAction={
            settings.terminalFontSizePx !== defaults.terminalFontSizePx ? (
              <SettingResetButton
                label={t("settings:terminalFontSize")}
                onClick={() =>
                  updateSettings({
                    terminalFontSizePx: defaults.terminalFontSizePx,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Input
                type="number"
                size="sm"
                min={MIN_TERMINAL_FONT_SIZE_PX}
                max={MAX_TERMINAL_FONT_SIZE_PX}
                step={1}
                inputMode="numeric"
                variant="soft"
                className="w-full text-right sm:w-20"
                value={String(settings.terminalFontSizePx)}
                onChange={(event) => {
                  const nextValue = event.target.value.trim();
                  if (nextValue.length === 0) return;
                  updateSettings({
                    terminalFontSizePx: normalizeTerminalFontSizePx(Number(nextValue)),
                  });
                }}
                aria-label={t("settings:terminalFontSizeInPixels")}
              />
              <span className="text-ui leading-snug text-muted-foreground">
                {t("settings:appearance_px")}
              </span>
            </div>
          }
        />

        <SettingsRow
          id="setting-terminal-font"
          title="settings:changed_terminalFont"
          description="settings:typeAnyMonospaceFontInstalledOnThisDeviceE2"
          resetAction={
            settings.terminalFontFamily !== defaults.terminalFontFamily ? (
              <SettingResetButton
                label={t("settings:terminalFont")}
                onClick={() =>
                  updateSettings({
                    terminalFontFamily: defaults.terminalFontFamily,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end sm:w-auto">
              <Autocomplete
                items={visibleTerminalFontFamilySuggestions}
                mode="none"
                openOnInputClick
                value={settings.terminalFontFamily}
                onValueChange={(value) => {
                  updateSettings({
                    terminalFontFamily: normalizeTerminalFontFamily(value),
                  });
                }}
              >
                <AutocompleteInput
                  size="sm"
                  variant="soft"
                  showTrigger
                  showClear={settings.terminalFontFamily.length > 0}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t("settings:defaultJetBrainsMono")}
                  className="w-full sm:w-56"
                  aria-label={t("settings:terminalFontFamily")}
                />
                <AutocompletePopup className="w-56 min-w-56 font-system-ui">
                  <AutocompleteList>
                    {visibleTerminalFontFamilySuggestions.map((suggestion, index) => (
                      <AutocompleteItem
                        key={suggestion}
                        index={index}
                        value={suggestion}
                        className="font-normal text-[var(--color-text-foreground)]"
                        onClick={() => {
                          updateSettings({
                            terminalFontFamily: normalizeTerminalFontFamily(suggestion),
                          });
                        }}
                      >
                        {suggestion}
                      </AutocompleteItem>
                    ))}
                    <AutocompleteEmpty>{t("settings:noMatchingSuggestedFonts")}</AutocompleteEmpty>
                  </AutocompleteList>
                </AutocompletePopup>
              </Autocomplete>
            </div>
          }
        />

        {shouldShowFontSmoothing
          ? renderBooleanSettingRow({
              id: "setting-font-smoothing",
              settingKey: "enableNativeFontSmoothing",
              title: "settings:changed_fontSmoothing",
              description: t("settings:useMacOSStyleAntialiasingForLighterCrisperTextRendering"),
              resetLabel: t("settings:fontSmoothing"),
              ariaLabel: t("settings:enableFontSmoothing"),
            })
          : null}
      </SettingsSection>

      <SettingsSection title="settings:appearance_timeAndReading">
        <SettingsRow
          id="setting-time-format"
          title="settings:changed_timeFormat"
          description="settings:systemDefaultFollowsYourBrowserOrOSClockPreference"
          resetAction={
            settings.timestampFormat !== defaults.timestampFormat ? (
              <SettingResetButton
                label={t("settings:timeFormat")}
                onClick={() =>
                  updateSettings({
                    timestampFormat: defaults.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value !== "locale" && value !== "12-hour" && value !== "24-hour") {
                  return;
                }
                updateSettings({
                  timestampFormat: value,
                });
              }}
              ariaLabel={t("settings:timestampFormat")}
              triggerClassName="w-full sm:w-40"
              valueContent={t(TIMESTAMP_FORMAT_LABELS[settings.timestampFormat])}
            >
              <SelectItem hideIndicator value="locale">
                {t(TIMESTAMP_FORMAT_LABELS.locale)}
              </SelectItem>
              <SelectItem hideIndicator value="12-hour">
                {t(TIMESTAMP_FORMAT_LABELS["12-hour"])}
              </SelectItem>
              <SelectItem hideIndicator value="24-hour">
                {t(TIMESTAMP_FORMAT_LABELS["24-hour"])}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
    </div>
  );

  const renderBehaviorPanel = () => (
    <div className="space-y-6">
      <SettingsSection title="settings:conversation">
        <SettingsRow
          id="setting-follow-up-behavior"
          title="settings:followUpBehavior"
          description="settings:chooseWhetherMessagesSentDuringAnActiveTurnWait2"
          resetAction={
            settings.followUpBehavior !== defaults.followUpBehavior ? (
              <SettingResetButton
                label={t("settings:followUpBehavior2")}
                onClick={() =>
                  updateSettings({
                    followUpBehavior: defaults.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.followUpBehavior}
              onValueChange={(value) => updateSettings({ followUpBehavior: value })}
              ariaLabel={t("settings:followUpBehavior")}
              options={FOLLOW_UP_BEHAVIOR_OPTIONS}
            />
          }
        />

        <SettingsRow
          id="setting-side-chat-expiry"
          title="settings:sideChatExpiry"
          description="settings:expireASideChatAfterItSitsIdleUnviewed"
          resetAction={
            settings.sidechatExpiry !== defaults.sidechatExpiry ? (
              <SettingResetButton
                label={t("settings:sideChatExpiry2")}
                onClick={() =>
                  updateSettings({
                    sidechatExpiry: defaults.sidechatExpiry,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.sidechatExpiry}
              onValueChange={(value) => updateSettings({ sidechatExpiry: value })}
              ariaLabel={t("settings:sideChatExpiry")}
              options={SIDECHAT_EXPIRY_OPTIONS}
            />
          }
        />

        <SettingsRow
          id="setting-enter-while-dictating"
          title="settings:enterWhileDictating"
          description="settings:chooseWhatEnterDoesWhileAVoiceNoteIs"
          resetAction={
            settings.voiceEnterBehavior !== defaults.voiceEnterBehavior ? (
              <SettingResetButton
                label={t("settings:enterWhileDictating2")}
                onClick={() =>
                  updateSettings({
                    voiceEnterBehavior: defaults.voiceEnterBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.voiceEnterBehavior}
              onValueChange={(value) => updateSettings({ voiceEnterBehavior: value })}
              ariaLabel={t("settings:enterWhileDictating")}
              options={VOICE_ENTER_BEHAVIOR_OPTIONS}
            />
          }
        />

        {renderBooleanSettingRow({
          id: "setting-assistant-output",
          settingKey: "enableAssistantStreaming",
          title: "settings:changed_assistantOutput",
          description: t("settings:showTokenByTokenOutputWhileAResponseIs"),
          resetLabel: t("settings:assistantOutput"),
          ariaLabel: t("settings:streamAssistantMessages"),
        })}

        {renderBooleanSettingRow({
          id: "setting-fold-finished-turns",
          settingKey: "collapseFinishedTurns",
          title: "settings:foldFinishedTurns",
          description: t("settings:hideAFinishedTurnSToolCallsAndIntermediate2"),
          resetLabel: t("settings:foldFinishedTurns2"),
          ariaLabel: t("settings:foldFinishedTurns"),
        })}

        {renderBooleanSettingRow({
          id: "setting-effort-slider",
          settingKey: "composerEffortSlider",
          title: "settings:effortSlider",
          description: t("settings:showEffortAsASliderAtTheBottomOf"),
          resetLabel: t("settings:effortSlider2"),
          ariaLabel: t("settings:showEffortSliderInTheComposer"),
        })}

        {isAudioLevelAvailable() ? (
          <SettingsRow
            id="setting-message-trail-sound"
            title="settings:messageTrailSound"
            description="settings:makeTheMessageMarksOnTheLeftOfLong"
            resetAction={
              settings.messageTrailAudioSource !== defaults.messageTrailAudioSource ? (
                <SettingResetButton
                  label={t("settings:messageTrailSound2")}
                  onClick={() =>
                    updateSettings({ messageTrailAudioSource: defaults.messageTrailAudioSource })
                  }
                />
              ) : null
            }
            control={
              <SettingsSegmentedControl
                value={settings.messageTrailAudioSource}
                onValueChange={(value) => updateSettings({ messageTrailAudioSource: value })}
                ariaLabel={t("settings:messageTrailSound")}
                options={MESSAGE_TRAIL_AUDIO_SOURCE_OPTIONS}
              />
            }
          />
        ) : null}

        {isAudioLevelAvailable() &&
        (settings.messageTrailAudioSource === "microphone" ||
          settings.messageTrailAudioSource === "both") ? (
          <MessageTrailMicrophoneRow
            value={settings.messageTrailMicrophoneId}
            defaultValue={defaults.messageTrailMicrophoneId}
            onChange={(messageTrailMicrophoneId) => updateSettings({ messageTrailMicrophoneId })}
          />
        ) : null}

        {renderBooleanSettingRow({
          id: "setting-automatically-open-simulator",
          settingKey: "autoOpenDevicePane",
          title: "settings:automaticallyOpenSimulator",
          description: t("settings:openTheIOSSimulatorPaneWhenAnAgentUses"),
          resetLabel: t("settings:automaticallyOpenSimulator2"),
          ariaLabel: t("settings:automaticallyOpenSimulator"),
        })}
      </SettingsSection>

      <KeepAwakeSettingsSection
        state={keepAwake}
        mode={settings.keepAwakeMode}
        defaultMode={defaults.keepAwakeMode}
        onSelectMode={(keepAwakeMode) => updateSettings({ keepAwakeMode })}
      />

      <SettingsSection title="chat:review">
        <SettingsRow
          id="setting-diff-layout"
          title="settings:diffLayout"
          description="settings:defaultStackedOrSplitLayoutForThreadsWithoutA"
          resetAction={
            defaultDiffRenderMode !== DEFAULT_DIFF_RENDER_MODE ? (
              <SettingResetButton
                label={t("settings:diffLayout2")}
                onClick={() => setDefaultDiffRenderMode(DEFAULT_DIFF_RENDER_MODE)}
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={defaultDiffRenderMode}
              onValueChange={setDefaultDiffRenderMode}
              ariaLabel={t("settings:diffLayout")}
              options={
                [
                  { value: "stacked", label: t("common:diff_stacked") },
                  { value: "split", label: t("common:diff_split") },
                ] satisfies ReadonlyArray<{ value: DiffRenderMode; label: string }>
              }
            />
          }
        />
        <SettingsRow
          id="setting-open-pull-requests-and-issues"
          title="settings:openPullRequestsAndIssues"
          description="settings:chooseWhereAPullRequestOrIssueLinkIn"
          resetAction={
            settings.githubLinkOpenTarget !== defaults.githubLinkOpenTarget ? (
              <SettingResetButton
                label={t("settings:openPullRequestsAndIssues2")}
                onClick={() =>
                  updateSettings({
                    githubLinkOpenTarget: defaults.githubLinkOpenTarget,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.githubLinkOpenTarget}
              onValueChange={(value) => {
                if (value !== "app" && value !== "browser" && value !== "external") {
                  return;
                }
                updateSettings({
                  githubLinkOpenTarget: value,
                });
              }}
              ariaLabel={t("settings:openPullRequestsAndIssues")}
              triggerClassName="w-full sm:w-40"
              valueContent={t(GITHUB_LINK_OPEN_TARGET_LABELS[settings.githubLinkOpenTarget])}
            >
              <SelectItem hideIndicator value="app">
                {t(GITHUB_LINK_OPEN_TARGET_LABELS.app)}
              </SelectItem>
              <SelectItem hideIndicator value="browser">
                {t(GITHUB_LINK_OPEN_TARGET_LABELS.browser)}
              </SelectItem>
              <SelectItem hideIndicator value="external">
                {t(GITHUB_LINK_OPEN_TARGET_LABELS.external)}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        {renderBooleanSettingRow({
          id: "setting-pull-request-diff-colors",
          settingKey: "showPullRequestDiffColors",
          title: "settings:pullRequestDiffColors",
          description: t("settings:showAdditionsInGreenAndDeletionsInRedIn"),
          resetLabel: t("settings:pullRequestDiffColors2"),
          ariaLabel: t("settings:showPullRequestDiffColors"),
        })}

        {renderBooleanSettingRow({
          id: "setting-include-fork-upstreams",
          settingKey: "githubInboxIncludeUpstreams",
          title: "settings:includeForkUpstreams",
          description: t("settings:alsoListPullRequestsAndIssuesFromEachProject"),
          resetLabel: t("settings:includeForkUpstreams2"),
          ariaLabel: t("settings:includeForkUpstreamsInCodeReview"),
        })}

        {renderBooleanSettingRow({
          id: "setting-diff-line-wrapping",
          settingKey: "diffWordWrap",
          title: "settings:changed_diffLineWrapping",
          description: t("settings:setTheDefaultWrapStateWhenTheDiffPanel2"),
          resetLabel: t("settings:diffLineWrapping"),
          ariaLabel: t("settings:wrapDiffLinesByDefault"),
        })}
      </SettingsSection>

      <SettingsSection title="settings:behavior_safetyConfirmations">
        {renderBooleanSettingRow({
          id: "setting-delete-confirmation",
          settingKey: "confirmThreadDelete",
          title: "settings:changed_deleteConfirmation",
          description: t("settings:askBeforeDeletingAThreadAndItsChatHistory"),
          resetLabel: t("settings:deleteConfirmation"),
          ariaLabel: t("settings:confirmThreadDeletion"),
        })}

        {renderBooleanSettingRow({
          id: "setting-archive-confirmation",
          settingKey: "confirmThreadArchive",
          title: "settings:changed_archiveConfirmation",
          description: t("settings:askBeforeArchivingAThread"),
          resetLabel: t("settings:archiveConfirmation"),
          ariaLabel: t("settings:confirmThreadArchive"),
        })}

        {renderBooleanSettingRow({
          id: "setting-terminal-close-confirmation",
          settingKey: "confirmTerminalTabClose",
          title: "settings:changed_terminalCloseConfirmation",
          description: t("settings:askBeforeClosingATerminalTabAndClearingIts"),
          resetLabel: t("settings:terminalCloseConfirmation"),
          ariaLabel: t("settings:confirmTerminalTabClose"),
        })}
      </SettingsSection>
    </div>
  );

  const renderRouteOwnedPanel = () => {
    switch (activeSection) {
      case "general":
        return renderGeneralPanel();
      case "appearance":
        return renderAppearancePanel();
      case "behavior":
        return renderBehaviorPanel();
      case "shortcuts":
        return <KeyboardShortcutsSettingsPanel />;
      case "profile":
        return <ProfileSettingsPanel />;
      case "skills":
        return <SkillsSettingsPanel />;
      case "usage":
        return <ProviderUsageSettingsPanel />;
      default:
        return null;
    }
  };

  return (
    <div
      className={cn(
        CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
        SETTINGS_PAGE_BACKGROUND_CLASS_NAME,
        CHAT_CONTENT_CARD_CLASS_NAME,
      )}
    >
      <RouteInsetSurface surfaceClassName={SETTINGS_PAGE_BACKGROUND_CLASS_NAME}>
        {/* Companion sidebar trigger so settings is reachable-and-exitable even when the
          sidebar is collapsed (web/mobile have no global Back arrow). Pinned to the
          card's top-left — at the same header height + traffic-light gutter as the
          chat and route headers — so the collapsed-state toggle sits by the traffic
          lights instead of floating in the centered settings body. It renders nothing
          while the sidebar is open (SidebarHeaderNavigationControls returns null), so it
          adds no navigation chrome in the common (open) state and never shifts the centered
          content (hence absolute, not a layout-occupying header row). The strip stays a
          drag-region so the Windows frameless window can be moved by its top edge; the
          caption buttons themselves are a separate fixed cluster (see root route). */}
        <div
          className={cn(
            "drag-region absolute inset-x-0 top-0 z-10 flex items-center",
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            CHAT_SURFACE_HEADER_HEIGHT_CLASS,
            desktopTopBarTrafficLightGutterClassName,
          )}
        >
          <div className="pointer-events-auto">
            <SidebarHeaderNavigationControls />
          </div>
        </div>
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <div
              className={cn(
                "mx-auto w-full px-6 py-8",
                activeSection === "connectors"
                  ? "max-w-4xl"
                  : activeSection === "profile"
                    ? "max-w-3xl"
                    : "max-w-2xl",
              )}
            >
              {activeSection !== "profile" ? (
                <div className="mb-8 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h1 className="flex items-center gap-2 text-xl font-medium tracking-tight text-foreground">
                      {t(activeSectionItem.label)}
                      {activeSectionItem.badge ? (
                        <Badge
                          variant="outline"
                          className="rounded-full px-2 font-normal tracking-normal text-muted-foreground"
                        >
                          {t(activeSectionItem.badge)}
                        </Badge>
                      ) : null}
                    </h1>
                    <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
                      {t(activeSectionItem.description)}
                    </p>
                  </div>
                  {activeSection === "shortcuts" ? (
                    <KeyboardShortcutsResetButton />
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      className="shrink-0"
                      disabled={changedSettingLabels.length === 0}
                      onClick={() => void restoreDefaults()}
                    >
                      <ResetIcon className="size-3.5" />
                      {t("settings:advanced_restoreDefaults")}
                    </Button>
                  )}
                </div>
              ) : null}

              {renderRouteOwnedPanel()}
              {/* These workflow owners stay mounted so drafts, request guards, and pending
                  mutations retain route lifetime while inactive panels render no DOM. */}
              <div className="contents">
                <NotificationsSettingsPanel
                  active={activeSection === "notifications"}
                  settings={settings}
                  defaults={defaults}
                  updateSettings={updateSettings}
                />
                <AppSnapSettingsPanel
                  active={activeSection === "appsnap"}
                  settings={settings}
                  defaults={defaults}
                  updateSettings={updateSettings}
                />
                <ComputerSettingsPanel
                  active={activeSection === "computer"}
                  settings={settings}
                  defaults={defaults}
                  updateSettings={updateSettings}
                />
                <WorktreesSettingsPanel active={activeSection === "worktrees"} />
                <ArchivedSettingsPanel active={activeSection === "archived"} />
                <ModelsSettingsPanel
                  active={activeSection === "models"}
                  settings={settings}
                  defaults={defaults}
                  updateSettings={updateSettings}
                  resetEpoch={resetEpoch}
                />
                <ProvidersSettingsPanel
                  active={activeSection === "providers"}
                  providerTarget={settingsProviderTarget}
                  settings={settings}
                  defaults={defaults}
                  updateSettings={updateSettings}
                  updateSettingsAndWait={updateSettingsAndWait}
                  resetEpoch={resetEpoch}
                />
                <McpConnectorsSettingsPanel active={activeSection === "connectors"} />
                <ExternalMcpSettingsPanel active={activeSection === "integrations"} />
                <AdvancedSettingsPanel
                  active={activeSection === "advanced"}
                  onOpenReleaseHistory={() => setReleaseHistoryOpen(true)}
                  resetEpoch={resetEpoch}
                />
              </div>
            </div>
          </div>
        </div>
        {/* Mounted at the route level (outside the scrollable panel) so the
          dialog portal can overlay the entire settings view without being
          clipped by the content wrapper's overflow. */}
        <ReleaseHistoryDialog
          open={releaseHistoryOpen}
          onOpenChange={setReleaseHistoryOpen}
          defaultExpandedVersion={APP_VERSION}
        />
      </RouteInsetSurface>
    </div>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
