// FILE: useSettingsRestoreDefaults.ts
// Purpose: Settings › Restore defaults — which settings differ from their defaults (named
//          in the confirmation), and resetting all of them, theme packs and the desktop
//          title bar included. Bumps `resetEpoch` so panels can drop local drafts.
// Layer: Settings hook
// Exports: useSettingsRestoreDefaults

import { sameAppSnapShortcut } from "@synara/shared/appSnapShortcut";
import { useState } from "react";

import { type AppSettings, isGitTextGenerationSettingsDirty } from "~/appSettings";
import { GROUPS_ON } from "~/betaFeatures";
import { isProviderInstallSettingsDirty } from "~/components/settings/providers/providerInstallSettings";
import {
  DEFAULT_DIFF_RENDER_MODE,
  DIFF_RENDER_MODE_STORAGE_KEY,
  DiffRenderModeSchema,
} from "~/diffRenderMode";
import { useTranslation } from "~/i18n";
import { getNavigatorPlatform, isMacPlatform } from "~/lib/utils";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { sameProviderOrder } from "~/providerOrdering";
import { useCustomTitleBarPreference } from "./useCustomTitleBarPreference";
import { useDefaultDesktopAppIcon } from "./useDefaultDesktopAppIcon";
import { useLocalStorage } from "./useLocalStorage";
import { useTheme } from "./useTheme";

export function useSettingsRestoreDefaults({
  settings,
  defaults,
  updateSettings,
  resetSettings,
}: {
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { isDefaultThemePack, resetAllThemes, theme, setTheme, systemUiFont } = useTheme();
  const customTitleBar = useCustomTitleBarPreference({ settings, defaults, updateSettings });
  const defaultDesktopAppIcon = useDefaultDesktopAppIcon();
  const shouldShowFontSmoothing = isMacPlatform(getNavigatorPlatform());
  const [defaultDiffRenderMode, setDefaultDiffRenderMode] = useLocalStorage(
    DIFF_RENDER_MODE_STORAGE_KEY,
    DEFAULT_DIFF_RENDER_MODE,
    DiffRenderModeSchema,
  );
  const [resetEpoch, setResetEpoch] = useState(0);

  const isGitTextGenerationModelDirty = isGitTextGenerationSettingsDirty(settings, defaults);
  const isInstallSettingsDirty = isProviderInstallSettingsDirty(settings, defaults);
  const hiddenProviderCount = new Set(settings.hiddenProviders).size;
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const isProviderActivityDirty =
    settings.disabledProviders.length !== defaults.disabledProviders.length ||
    settings.disabledProviders.some(
      (provider, index) => provider !== defaults.disabledProviders[index],
    );

  const changedSettingLabels = [
    ...(theme !== "system" ? ["onboarding:changed_theme"] : []),
    // resetAllThemes() restores both theme packs and the system-font preference.
    ...(!isDefaultThemePack("dark") ? ["settings:darkThemePack"] : []),
    ...(!isDefaultThemePack("light") ? ["settings:lightThemePack"] : []),
    ...(!systemUiFont ? ["settings:useSystemUIFont"] : []),
    ...(settings.defaultProvider !== defaults.defaultProvider ||
    settings.defaultProviderInstanceId !== defaults.defaultProviderInstanceId
      ? ["settings:general_newChatAccount"]
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
    ...(customTitleBar.preferenceDirty ? ["settings:customTitleBar"] : []),
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
    ...(settings.showRateLimitWarnings !== defaults.showRateLimitWarnings
      ? ["settings:rateLimitWarnings"]
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
          settings: changedSettingLabels.join(", "),
        }),
      ].join("\n"),
    );
    if (!confirmed) return;

    if (customTitleBar.preferenceDirty) {
      const state = await customTitleBar.persist(defaults.useCustomTitleBar);
      if (state === null) return;
      if (state.restartRequired) customTitleBar.showRestartToast();
    }

    setTheme("system");
    resetAllThemes();
    setDefaultDiffRenderMode(DEFAULT_DIFF_RENDER_MODE);
    await resetSettings();
    setResetEpoch((current) => current + 1);
  }

  return { changedSettingLabels, restoreDefaults, resetEpoch };
}
