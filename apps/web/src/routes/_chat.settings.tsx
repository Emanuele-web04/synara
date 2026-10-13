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
import { LANGUAGE_PREFERENCES, type LanguagePreference } from "~/i18n/locale";
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
    label: "Compact",
    description: "Tighter spacing in the sidebar, composer, and settings rows.",
  },
  {
    value: "comfortable",
    label: "Comfortable",
    description: "Balanced spacing for everyday use.",
  },
  {
    value: "spacious",
    label: "Spacious",
    description: "More breathing room across the main workspace surfaces.",
  },
] as const satisfies ReadonlyArray<{
  value: UiDensity;
  label: string;
  description: string;
}>;

const CHAT_WIDTH_OPTIONS = [
  {
    value: "standard",
    label: "Standard",
    description: "Keeps the chat column at the default reading width (46rem).",
  },
  {
    value: "wide",
    label: "Wide",
    description: "Gives tables and wide content more room (72rem).",
  },
  {
    value: "full",
    label: "Full",
    description: "Lets the chat column use the full window width.",
  },
] as const satisfies ReadonlyArray<{
  value: ChatWidthMode;
  label: string;
  description: string;
}>;

const PROVIDER_SELECT_OPTIONS = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.kind);

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const SIDEBAR_PROJECT_SORT_ORDER_LABELS = {
  updated_at: "Recently active",
  created_at: "Recently added",
  manual: "Manual order",
} as const;

const SIDEBAR_THREAD_SORT_ORDER_LABELS = {
  updated_at: "Recently active",
  created_at: "Newest first",
} as const;

const FOLLOW_UP_BEHAVIOR_OPTIONS = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
] as const satisfies ReadonlyArray<{ value: FollowUpBehavior; label: string }>;

const SIDECHAT_EXPIRY_OPTIONS = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "never", label: "Never" },
] as const satisfies ReadonlyArray<{ value: SidechatExpiry; label: string }>;

const GITHUB_LINK_OPEN_TARGET_LABELS = {
  app: "In Synara",
  browser: "In-app browser",
  external: "External browser",
} as const satisfies Record<GitHubLinkOpenTarget, string>;

const MESSAGE_TRAIL_AUDIO_SOURCE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "system", label: "Mac audio" },
  { value: "microphone", label: "Microphone" },
  { value: "both", label: "Both" },
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
    ? t("Mac default: {{microphone}}", { microphone: microphoneLabel(macDefault) })
    : t("Mac default");
  const valueContent = !value
    ? macDefaultLabel
    : selected
      ? microphoneLabel(selected)
      : t("Not connected");

  return (
    <SettingsRow
      title="Message trail microphone"
      description="Microphone the message trail listens to. Pick a built-in one if you use Bluetooth headphones: opening their microphone lowers their sound quality. If the chosen microphone is not connected, the trail ignores the microphone instead of falling back to another one."
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton
            label={t("message trail microphone")}
            onClick={() => onChange(defaultValue)}
          />
        ) : null
      }
      control={
        <SettingsSelectControl
          value={value || MAC_DEFAULT_MICROPHONE_VALUE}
          onValueChange={(next) => onChange(next === MAC_DEFAULT_MICROPHONE_VALUE ? "" : next)}
          ariaLabel={t("Message trail microphone")}
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
              {t("Not connected")}
            </SelectItem>
          ) : null}
        </SettingsSelectControl>
      }
    />
  );
}

const VOICE_ENTER_BEHAVIOR_OPTIONS = [
  { value: "stop", label: "Stop" },
  { value: "send", label: "Stop and send" },
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
  const { t } = useTranslation();
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
      title: t("Restart to apply title bar"),
      description: t("The window frame updates the next time Synara launches."),
      actionProps: {
        "aria-label": "Restart Synara",
        children: "Restart",
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
        title: t("Could not update title bar"),
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
    ...(settings.language !== defaults.language ? ["Language"] : []),
    ...(theme !== "system" ? ["Theme"] : []),
    ...(!isDefaultActiveTheme ? [`${resolvedTheme === "dark" ? "Dark" : "Light"} theme pack`] : []),
    ...(settings.defaultProvider !== defaults.defaultProvider ? ["Default provider"] : []),
    ...(settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? ["New thread mode"] : []),
    ...(settings.anchorSentMessagesToTop !== defaults.anchorSentMessagesToTop
      ? ["Move sent messages to top"]
      : []),
    ...(settings.showOpenThreadTabs !== defaults.showOpenThreadTabs ? ["Thread tabs"] : []),
    ...(settings.archiveDeletesOrphanedWorktree !== defaults.archiveDeletesOrphanedWorktree
      ? ["Delete worktree on archive"]
      : []),
    ...(settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder
      ? ["Project sort order"]
      : []),
    ...(settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder
      ? ["Thread sort order"]
      : []),
    ...(settings.sidebarThreadAttentionFirst !== defaults.sidebarThreadAttentionFirst
      ? ["Working and unread on top"]
      : []),
    ...(settings.showChatsSection !== defaults.showChatsSection ? ["Chats section"] : []),
    ...(GROUPS_ON && settings.showGroupsSection !== defaults.showGroupsSection
      ? ["Hubs section"]
      : []),
    ...(settings.showAutomationRunThreads !== defaults.showAutomationRunThreads
      ? ["Automation runs"]
      : []),
    ...(settings.uiDensity !== defaults.uiDensity ? ["UI density"] : []),
    ...(settings.chatWidth !== defaults.chatWidth ? ["Chat width"] : []),
    ...(settings.desktopAppIcon !== defaultDesktopAppIcon ? ["App icon"] : []),
    ...(customTitleBarPreferenceDirty ? ["Custom title bar"] : []),
    ...(settings.chatFontSizePx !== defaults.chatFontSizePx ? ["Base font size"] : []),
    ...(settings.terminalFontSizePx !== defaults.terminalFontSizePx ? ["Terminal font size"] : []),
    ...(settings.terminalFontFamily !== defaults.terminalFontFamily ? ["Terminal font"] : []),
    ...(shouldShowFontSmoothing &&
    settings.enableNativeFontSmoothing !== defaults.enableNativeFontSmoothing
      ? ["Font smoothing"]
      : []),
    ...(settings.timestampFormat !== defaults.timestampFormat ? ["Time format"] : []),
    ...(settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts
      ? ["Activity toasts"]
      : []),
    ...(settings.enableSystemTaskCompletionNotifications !==
    defaults.enableSystemTaskCompletionNotifications
      ? ["Desktop notifications"]
      : []),
    ...(settings.notifyAfterSubagentsFinish !== defaults.notifyAfterSubagentsFinish
      ? ["Wait for subagents"]
      : []),
    ...(settings.enableAssistantStreaming !== defaults.enableAssistantStreaming
      ? ["Assistant output"]
      : []),
    ...(settings.collapseFinishedTurns !== defaults.collapseFinishedTurns
      ? ["Fold finished turns"]
      : []),
    ...(settings.composerEffortSlider !== defaults.composerEffortSlider ? ["Effort slider"] : []),
    ...(settings.messageTrailAudioSource !== defaults.messageTrailAudioSource
      ? ["Message trail sound"]
      : []),
    ...(settings.messageTrailMicrophoneId !== defaults.messageTrailMicrophoneId
      ? ["Message trail microphone"]
      : []),
    ...(settings.followUpBehavior !== defaults.followUpBehavior ? ["Follow-up behavior"] : []),
    ...(settings.sidechatExpiry !== defaults.sidechatExpiry ? ["Side chat expiry"] : []),
    ...(settings.voiceEnterBehavior !== defaults.voiceEnterBehavior
      ? ["Enter while dictating"]
      : []),
    ...(settings.autoOpenDevicePane !== defaults.autoOpenDevicePane
      ? ["Automatically open simulator"]
      : []),
    ...(settings.enableAppSnap !== defaults.enableAppSnap ? ["AppSnap"] : []),
    ...(!sameAppSnapShortcut(settings.appSnapShortcut, defaults.appSnapShortcut)
      ? ["AppSnap shortcut"]
      : []),
    ...(settings.appSnapPlaySound !== defaults.appSnapPlaySound ? ["AppSnap capture sound"] : []),
    ...(settings.computerControlEnabled !== defaults.computerControlEnabled
      ? ["Computer control"]
      : []),
    ...(settings.autoOpenComputerPane !== defaults.autoOpenComputerPane
      ? ["Computer preview auto-open"]
      : []),
    ...(settings.agentCursorColorMode !== defaults.agentCursorColorMode
      ? ["Agent cursor colors"]
      : []),
    ...(settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks
      ? ["Provider update checks"]
      : []),
    ...(settings.lowerProviderProcessPriority !== defaults.lowerProviderProcessPriority
      ? ["Keep Synara responsive"]
      : []),
    ...(defaultDiffRenderMode !== DEFAULT_DIFF_RENDER_MODE ? ["Diff layout"] : []),
    ...(settings.diffWordWrap !== defaults.diffWordWrap ? ["Diff line wrapping"] : []),
    ...(settings.githubLinkOpenTarget !== defaults.githubLinkOpenTarget
      ? ["Open pull requests and issues"]
      : []),
    ...(settings.showPullRequestDiffColors !== defaults.showPullRequestDiffColors
      ? ["Pull request diff colors"]
      : []),
    ...(settings.githubInboxIncludeUpstreams !== defaults.githubInboxIncludeUpstreams
      ? ["Include fork upstreams"]
      : []),
    ...(settings.confirmThreadDelete !== defaults.confirmThreadDelete
      ? ["Delete confirmation"]
      : []),
    ...(settings.confirmThreadArchive !== defaults.confirmThreadArchive
      ? ["Archive confirmation"]
      : []),
    ...(settings.confirmTerminalTabClose !== defaults.confirmTerminalTabClose
      ? ["Terminal close confirmation"]
      : []),
    ...(isGitTextGenerationModelDirty ? ["Git writing model"] : []),
    ...(settings.sourceControlWritingStyle !== defaults.sourceControlWritingStyle ||
    settings.sourceControlCustomInstructions !== defaults.sourceControlCustomInstructions
      ? ["Source control writing style"]
      : []),
    ...(settings.customCodexModels.length > 0 ||
    settings.customClaudeModels.length > 0 ||
    settings.customCursorModels.length > 0 ||
    settings.customAntigravityModels.length > 0 ||
    settings.customGrokModels.length > 0 ||
    settings.customDroidModels.length > 0 ||
    settings.customOpenCodeModels.length > 0 ||
    settings.customPiModels.length > 0
      ? ["Custom models"]
      : []),
    ...(isInstallSettingsDirty ? ["Provider installs"] : []),
    ...(isProviderActivityDirty ? ["Provider activity"] : []),
    ...(hiddenProviderCount > 0 ? ["Provider visibility"] : []),
    ...(isProviderOrderDirty ? ["Provider order"] : []),
  ].map((label) => t(label));

  async function restoreDefaults() {
    if (changedSettingLabels.length === 0) return;

    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      [
        t("Restore default settings?"),
        t("This will reset: {{settings}}.", { settings: changedSettingLabels.join(", ") }),
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
    title: string;
    description: string;
    resetLabel: string;
    ariaLabel: string;
  }) => {
    const { settingKey, title, description, resetLabel, ariaLabel } = config;
    const isChanged = settings[settingKey] !== defaults[settingKey];
    return (
      <SettingsRow
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
      <SettingsSection title="Core defaults">
        <SettingsRow
          title="Language"
          description="Choose the language used by the interface. System follows your browser or device language."
          resetAction={
            settings.language !== defaults.language ? (
              <SettingResetButton
                label={t("language")}
                onClick={() => updateSettings({ language: defaults.language })}
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.language}
              onValueChange={(language) => {
                if (LANGUAGE_PREFERENCES.includes(language as LanguagePreference)) {
                  updateSettings({ language: language as LanguagePreference });
                }
              }}
              ariaLabel={t("Language")}
              valueContent={
                settings.language === "system"
                  ? t("System")
                  : settings.language === "en"
                    ? "English"
                    : "Español"
              }
            >
              <SelectItem value="system">{t("System")}</SelectItem>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="es">Español</SelectItem>
            </SettingsSelectControl>
          }
        />
        <SettingsRow
          title="Default provider"
          description="Provider used for new chats until you pick a model. New chats then reuse your most recent model and options."
          resetAction={
            settings.defaultProvider !== defaults.defaultProvider ? (
              <SettingResetButton
                label={t("default provider")}
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
              ariaLabel={t("Default provider")}
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
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          resetAction={
            settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
              <SettingResetButton
                label={t("new threads")}
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
              ariaLabel={t("Default thread mode")}
              valueContent={settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
            >
              <SelectItem hideIndicator value="local">
                {t("Local")}
              </SelectItem>
              <SelectItem hideIndicator value="worktree">
                {t("New worktree")}
              </SelectItem>
            </SettingsSelectControl>
          }
        />

        {renderBooleanSettingRow({
          settingKey: "archiveDeletesOrphanedWorktree",
          title: "Delete worktree on archive",
          description: t(
            "After Archive's Undo period, remove a clean worktree only if the task has stopped and no other task uses it. Its branch remains available for recovery.",
          ),
          resetLabel: t("delete worktree on archive"),
          ariaLabel: t("Delete worktree on archive"),
        })}

        {renderBooleanSettingRow({
          settingKey: "anchorSentMessagesToTop",
          title: "Move sent messages to top",
          description: t(
            "Move each sent message to the top of the conversation. Turn off to keep it at the bottom and follow replies as they stream.",
          ),
          resetLabel: t("move sent messages to top"),
          ariaLabel: t("Move sent messages to top"),
        })}

        {renderBooleanSettingRow({
          settingKey: "showOpenThreadTabs",
          title: "Thread tabs",
          description: t(
            "Show open threads as tabs in the chat header. Turn off to show only the current thread's title.",
          ),
          resetLabel: t("thread tabs"),
          ariaLabel: t("Show open threads as tabs in the chat header"),
        })}

        <SettingsRow
          title="Welcome tour"
          description="Replay the first-run setup: feature tour, provider selection, appearance, and first project."
          control={
            <Button
              variant="outline"
              onClick={() => useOnboardingDialogStore.getState().openDialog()}
            >
              {t("Open welcome tour")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Sidebar organization">
        <SettingsRow
          title="Project order"
          description="Controls how projects are arranged in the main sidebar."
          resetAction={
            settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder ? (
              <SettingResetButton
                label={t("project order")}
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
              ariaLabel={t("Project sort order")}
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
          title="Thread order"
          description="Controls how threads are arranged inside each project in the main sidebar."
          resetAction={
            settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder ? (
              <SettingResetButton
                label={t("thread order")}
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
              ariaLabel={t("Thread sort order")}
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
          settingKey: "sidebarThreadAttentionFirst",
          title: "Working and unread on top",
          description: t(
            "With Recently active order, move working and unread threads above the rest. The list holds still while your pointer is over it.",
          ),
          resetLabel: t("working and unread on top"),
          ariaLabel: t("Move working and unread threads to the top of the sidebar"),
        })}
      </SettingsSection>

      <SettingsSection title="Sidebar sections">
        {renderBooleanSettingRow({
          settingKey: "showChatsSection",
          title: "Chats",
          description: t(
            "Show the standalone Chats list in the sidebar footer (chats not tied to a project).",
          ),
          resetLabel: t("chats section"),
          ariaLabel: t("Show the Chats section in the sidebar"),
        })}

        {GROUPS_ON
          ? renderBooleanSettingRow({
              settingKey: "showGroupsSection",
              title: "Hubs",
              description: t("Show the Hubs tab in the sidebar switcher."),
              resetLabel: t("hubs section"),
              ariaLabel: t("Show the Hubs section in the sidebar"),
            })
          : null}

        {renderBooleanSettingRow({
          settingKey: "showAutomationRunThreads",
          title: "Automation runs",
          description: t(
            "Show the thread each standalone automation run creates. Runs stay listed on the automation's page either way; threads owned by dedicated or heartbeat automations always stay visible.",
          ),
          resetLabel: t("automation runs"),
          ariaLabel: t("Show automation run threads in the sidebar"),
        })}
      </SettingsSection>

      <div id={SETTINGS_TARGETS.environmentPanel} className="space-y-6">
        <SettingsSection title="Environment panel">
          {renderBooleanSettingRow({
            settingKey: "environmentPanelDefaultOpen",
            title: "Open by default",
            description: t(
              "Open the chat Environment panel automatically on normal threads. When off, the panel stays closed until you open it. Your last open/close also updates this preference.",
            ),
            resetLabel: t("environment panel default open"),
            ariaLabel: t("Open the Environment panel by default on normal threads"),
          })}
        </SettingsSection>

        <SettingsSection title="Code and status">
          {renderBooleanSettingRow({
            settingKey: "showEnvironmentSubagents",
            title: "Subagents",
            description: t(
              "Show a compact summary of the chat's subagents in the Environment panel. Click it to open the full list, running and done, in the right dock.",
            ),
            resetLabel: t("subagents section"),
            ariaLabel: t("Show the Subagents section in the Environment panel"),
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentUsage",
            title: "Usage",
            description: t("Show the provider usage row in the chat Environment panel."),
            resetLabel: t("usage section"),
            ariaLabel: t("Show the Usage section in the Environment panel"),
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentRepository",
            title: "Repository",
            description: t(
              "Show the GitHub repository link in the chat Environment panel. The git block (Changes, Worktree, branch, Commit and Push) always stays visible.",
            ),
            resetLabel: t("repository section"),
            ariaLabel: t("Show the Repository section in the Environment panel"),
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentPullRequest",
            title: "Pull request",
            description: t(
              "Show the open pull request (CI checks and review comments) for the current branch in the chat Environment panel.",
            ),
            resetLabel: t("pull request section"),
            ariaLabel: t("Show the Pull request section in the Environment panel"),
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentEditor",
            title: "Editor",
            description: t(
              "Show the Editor section (in-app editor view and Open in editor picker) in the chat Environment panel.",
            ),
            resetLabel: t("editor section"),
            ariaLabel: t("Show the Editor section in the Environment panel"),
          })}
        </SettingsSection>

        <SettingsSection title="Context and notes">
          {renderBooleanSettingRow({
            settingKey: "showEnvironmentRecap",
            title: "Recap",
            description: t("Show the auto-generated chat recap in the Environment panel."),
            resetLabel: t("recap section"),
            ariaLabel: t("Show the Recap section in the Environment panel"),
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentPinned",
            title: "Pinned messages",
            description: t("Show the pinned-messages checklist in the Environment panel."),
            resetLabel: t("pinned messages section"),
            ariaLabel: t("Show the Pinned messages section in the Environment panel"),
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentInstructions",
            title: "Project instructions",
            description: t("Show project-level instructions in the Environment panel."),
            resetLabel: t("project instructions section"),
            ariaLabel: t("Show the Project instructions section in the Environment panel"),
          })}

          {renderBooleanSettingRow({
            settingKey: "showEnvironmentNotepad",
            title: "Notepad",
            description: t("Show the per-thread notepad in the Environment panel."),
            resetLabel: t("notepad section"),
            ariaLabel: t("Show the Notepad section in the Environment panel"),
          })}
        </SettingsSection>
      </div>
    </div>
  );

  const renderAppearancePanel = () => (
    <div className="space-y-6">
      <SettingsSectionShell
        title="Theme"
        action={
          theme !== "system" ? (
            <SettingResetButton label={t("theme")} onClick={() => setTheme("system")} />
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
            ariaLabel={t("Theme preference")}
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
        <SettingsSection title="App">
          <SettingsRow
            title="App icon"
            description="Choose the icon Synara uses in the dock or taskbar."
            resetAction={
              settings.desktopAppIcon !== defaultDesktopAppIcon ? (
                <SettingResetButton
                  label={t("app icon")}
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
              title="Use custom title bar"
              description={
                customTitleBarRestartRequired
                  ? "Restart Synara to apply. Some Linux window managers work better with the system title bar."
                  : "Replace the system title bar with Synara's frameless chrome and window controls. Restart required to apply."
              }
              status={customTitleBarRestartRequired ? t("Restart required") : undefined}
              resetAction={
                settings.useCustomTitleBar !== defaults.useCustomTitleBar ? (
                  <SettingResetButton
                    label={t("custom title bar")}
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
                      {t("Restart")}
                    </Button>
                  ) : null}
                  <Switch
                    checked={settings.useCustomTitleBar}
                    onCheckedChange={(checked) => {
                      void applyCustomTitleBarPreference(Boolean(checked));
                    }}
                    aria-label={t("Use custom title bar")}
                  />
                </div>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Typography and spacing">
        <SettingsRow
          title="Use system UI font"
          description="Ignore the theme's custom UI font and render the interface with the native system font (SF Pro on macOS)."
          resetAction={
            !systemUiFont ? (
              <SettingResetButton
                label={t("system UI font")}
                onClick={() => setSystemUiFont(true)}
              />
            ) : null
          }
          control={
            <Switch
              checked={systemUiFont}
              onCheckedChange={(checked) => setSystemUiFont(Boolean(checked))}
              aria-label={t("Use system UI font")}
            />
          }
        />

        <SettingsRow
          title="UI density"
          description="Control spacing in the sidebar, composer, chat gutters, and settings rows without changing font size."
          resetAction={
            settings.uiDensity !== defaults.uiDensity ? (
              <SettingResetButton
                label={t("UI density")}
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
              ariaLabel={t("UI density")}
              options={UI_DENSITY_OPTIONS}
            />
          }
        />

        <SettingsRow
          title="Chat width"
          description="Control how wide the chat column grows. Wide and Full give tables and wide content more room."
          resetAction={
            settings.chatWidth !== defaults.chatWidth ? (
              <SettingResetButton
                label={t("chat width")}
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
              ariaLabel={t("Chat width")}
              options={CHAT_WIDTH_OPTIONS}
            />
          }
        />

        <SettingsRow
          title="Base font size"
          description="Adjust the app text base in pixels. Chat and UI typography scale proportionally from this value."
          resetAction={
            settings.chatFontSizePx !== defaults.chatFontSizePx ? (
              <SettingResetButton
                label={t("base font size")}
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
                aria-label={t("Base font size in pixels")}
              />
              <span className="text-ui leading-snug text-muted-foreground">{t("px")}</span>
            </div>
          }
        />

        <SettingsRow
          title="Terminal font size"
          description="Adjust terminal text independently from the app and chat font size."
          resetAction={
            settings.terminalFontSizePx !== defaults.terminalFontSizePx ? (
              <SettingResetButton
                label={t("terminal font size")}
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
                aria-label={t("Terminal font size in pixels")}
              />
              <span className="text-ui leading-snug text-muted-foreground">{t("px")}</span>
            </div>
          }
        />

        <SettingsRow
          title="Terminal font"
          description="Type any monospace font installed on this device (e.g. Fira Code). Leave empty for the default. Fonts that aren't installed fall back to the system monospace."
          resetAction={
            settings.terminalFontFamily !== defaults.terminalFontFamily ? (
              <SettingResetButton
                label={t("terminal font")}
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
                  placeholder={t("Default (JetBrains Mono)")}
                  className="w-full sm:w-56"
                  aria-label={t("Terminal font family")}
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
                    <AutocompleteEmpty>{t("No matching suggested fonts.")}</AutocompleteEmpty>
                  </AutocompleteList>
                </AutocompletePopup>
              </Autocomplete>
            </div>
          }
        />

        {shouldShowFontSmoothing
          ? renderBooleanSettingRow({
              settingKey: "enableNativeFontSmoothing",
              title: "Font smoothing",
              description: t("Use macOS-style antialiasing for lighter, crisper text rendering."),
              resetLabel: t("font smoothing"),
              ariaLabel: t("Enable font smoothing"),
            })
          : null}
      </SettingsSection>

      <SettingsSection title="Time and reading">
        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== defaults.timestampFormat ? (
              <SettingResetButton
                label={t("time format")}
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
              ariaLabel={t("Timestamp format")}
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
      <SettingsSection title="Conversation">
        <SettingsRow
          title="Follow-up behavior"
          description="Choose whether messages sent during an active turn wait in the queue or steer the current run. Ctrl/Cmd+Enter uses the opposite behavior for one message."
          resetAction={
            settings.followUpBehavior !== defaults.followUpBehavior ? (
              <SettingResetButton
                label={t("follow-up behavior")}
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
              ariaLabel={t("Follow-up behavior")}
              options={FOLLOW_UP_BEHAVIOR_OPTIONS}
            />
          }
        />

        <SettingsRow
          title="Side chat expiry"
          description="Expire a side chat after it sits idle, unviewed and not running, for this long. Expired side chats are read-only and unload their provider session."
          resetAction={
            settings.sidechatExpiry !== defaults.sidechatExpiry ? (
              <SettingResetButton
                label={t("side chat expiry")}
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
              ariaLabel={t("Side chat expiry")}
              options={SIDECHAT_EXPIRY_OPTIONS}
            />
          }
        />

        <SettingsRow
          title="Enter while dictating"
          description="Choose what Enter does while a voice note is recording: stop and transcribe into the composer, or stop and send the message once it is transcribed."
          resetAction={
            settings.voiceEnterBehavior !== defaults.voiceEnterBehavior ? (
              <SettingResetButton
                label={t("enter while dictating")}
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
              ariaLabel={t("Enter while dictating")}
              options={VOICE_ENTER_BEHAVIOR_OPTIONS}
            />
          }
        />

        {renderBooleanSettingRow({
          settingKey: "enableAssistantStreaming",
          title: "Assistant output",
          description: t("Show token-by-token output while a response is in progress."),
          resetLabel: t("assistant output"),
          ariaLabel: t("Stream assistant messages"),
        })}

        {renderBooleanSettingRow({
          settingKey: "collapseFinishedTurns",
          title: "Fold finished turns",
          description: t(
            'Hide a finished turn\'s tool calls and intermediate messages behind a single "Worked for…" line. A turn stays open while it runs or while its background subagents are still working. Turn this off to keep every step visible.',
          ),
          resetLabel: t("fold finished turns"),
          ariaLabel: t("Fold finished turns"),
        })}

        {renderBooleanSettingRow({
          settingKey: "composerEffortSlider",
          title: "Effort slider",
          description: t(
            "Show effort as a slider at the bottom of the composer's model picker, with fast mode and reset alongside it, instead of separate Effort and Speed rows.",
          ),
          resetLabel: t("effort slider"),
          ariaLabel: t("Show effort slider in the composer"),
        })}

        {isAudioLevelAvailable() ? (
          <SettingsRow
            title="Message trail sound"
            description="Make the message marks on the left of long chats move with sound: what your Mac plays (a video, a meeting), your microphone, or whichever is louder. macOS asks for access the first time. Synara only reads how loud the sound is and never records it."
            resetAction={
              settings.messageTrailAudioSource !== defaults.messageTrailAudioSource ? (
                <SettingResetButton
                  label={t("message trail sound")}
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
                ariaLabel={t("Message trail sound")}
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
          settingKey: "autoOpenDevicePane",
          title: "Automatically open simulator",
          description: t(
            "Open the iOS Simulator pane when an agent uses a device. Turn this off to use Simulator.app without the mirrored pane reopening. You can still open the pane manually.",
          ),
          resetLabel: t("automatically open simulator"),
          ariaLabel: t("Automatically open simulator"),
        })}
      </SettingsSection>

      <KeepAwakeSettingsSection
        state={keepAwake}
        mode={settings.keepAwakeMode}
        defaultMode={defaults.keepAwakeMode}
        onSelectMode={(keepAwakeMode) => updateSettings({ keepAwakeMode })}
      />

      <SettingsSection title="Review">
        <SettingsRow
          title="Diff layout"
          description="Default stacked or split layout for threads without a saved choice. Each thread remembers its review-panel changes independently."
          resetAction={
            defaultDiffRenderMode !== DEFAULT_DIFF_RENDER_MODE ? (
              <SettingResetButton
                label={t("diff layout")}
                onClick={() => setDefaultDiffRenderMode(DEFAULT_DIFF_RENDER_MODE)}
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={defaultDiffRenderMode}
              onValueChange={setDefaultDiffRenderMode}
              ariaLabel={t("Diff layout")}
              options={
                [
                  { value: "stacked", label: t("Stacked") },
                  { value: "split", label: t("Split") },
                ] satisfies ReadonlyArray<{ value: DiffRenderMode; label: string }>
              }
            />
          }
        />
        <SettingsRow
          title="Open pull requests and issues"
          description="Choose where a pull request or issue link in a chat opens: the built-in review view, the in-app browser, or your external browser. Ctrl/Cmd+click always opens the external browser."
          resetAction={
            settings.githubLinkOpenTarget !== defaults.githubLinkOpenTarget ? (
              <SettingResetButton
                label={t("open pull requests and issues")}
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
              ariaLabel={t("Open pull requests and issues")}
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
          settingKey: "showPullRequestDiffColors",
          title: "Pull request diff colors",
          description: t("Show additions in green and deletions in red in pull request summaries."),
          resetLabel: t("pull request diff colors"),
          ariaLabel: t("Show pull request diff colors"),
        })}

        {renderBooleanSettingRow({
          settingKey: "githubInboxIncludeUpstreams",
          title: "Include fork upstreams",
          description: t(
            "Also list pull requests and issues from each project's other GitHub remotes, such as the repository a fork was made from. Off reads only the project's own repository.",
          ),
          resetLabel: t("include fork upstreams"),
          ariaLabel: t("Include fork upstreams in code review"),
        })}

        {renderBooleanSettingRow({
          settingKey: "diffWordWrap",
          title: "Diff line wrapping",
          description: t(
            "Set the default wrap state when the diff panel opens. The in-panel wrap toggle only affects the current diff session.",
          ),
          resetLabel: t("diff line wrapping"),
          ariaLabel: t("Wrap diff lines by default"),
        })}
      </SettingsSection>

      <SettingsSection title="Safety confirmations">
        {renderBooleanSettingRow({
          settingKey: "confirmThreadDelete",
          title: "Delete confirmation",
          description: t("Ask before deleting a thread and its chat history."),
          resetLabel: t("delete confirmation"),
          ariaLabel: t("Confirm thread deletion"),
        })}

        {renderBooleanSettingRow({
          settingKey: "confirmThreadArchive",
          title: "Archive confirmation",
          description: t("Ask before archiving a thread."),
          resetLabel: t("archive confirmation"),
          ariaLabel: t("Confirm thread archive"),
        })}

        {renderBooleanSettingRow({
          settingKey: "confirmTerminalTabClose",
          title: "Terminal close confirmation",
          description: t("Ask before closing a terminal tab and clearing its history."),
          resetLabel: t("terminal close confirmation"),
          ariaLabel: t("Confirm terminal tab close"),
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
                activeSection === "profile" ? "max-w-3xl" : "max-w-2xl",
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
                      {t("Restore defaults")}
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
