// FILE: settingsSearchIndex.ts
// Purpose: Declarative, searchable index of settings rows/sections so the sidebar can
//          surface matches by title/description the same way the editor file search does.
// Layer: Route/UI support
// Exports: entry type, the index, section label lookup, and the ranking helper

import { rankProviderDiscoveryItems } from "~/lib/providerDiscovery";
import { i18n, t } from "~/i18n";
import {
  isSettingsSectionAvailable,
  SETTINGS_NAV_ITEMS,
  type SettingsSectionId,
} from "./settingsNavigation";

/**
 * One searchable settings result. `title` is a stable catalog key; `target` is an explicit DOM anchor,
 * independent of the translated heading; `target: null` marks panel-only or conditional rows.
 */
export interface SettingsSearchEntry {
  id: string;
  section: SettingsSectionId;
  title: string;
  keywords: string;
  target?: string | null;
  /**
   * Whether this row exists on the machine the user is actually looking at.
   * Omitted means "always". A search result for a row the panel does not render
   * is a dead end: it scrolls to an anchor that is not there, and it tells the
   * user Synara has a setting it does not.
   */
  applies?: (context: SettingsSearchContext) => boolean;
}

/**
 * What the index needs to know about this server to decide which rows exist.
 * Deliberately a handful of booleans rather than the status objects themselves —
 * the index answers "does this row render", not "what does it say".
 */
export interface SettingsSearchContext {
  /**
   * The desktop backend drives the screen the user is already looking at, so
   * the preview describes the same visible desktop. True only once the status
   * is known.
   */
  readonly computerBackendIsVisibleDesktop: boolean;
}

const DEFAULT_SETTINGS_SEARCH_CONTEXT: SettingsSearchContext = {
  computerBackendIsVisibleDesktop: false,
};

/** DOM id a result deep-links to, or null for panel-level entries with no anchored row. */
export function settingsSearchEntryTarget(entry: SettingsSearchEntry): string | null {
  return entry.target ?? null;
}

// Mirrors row titles/descriptions rendered in settings panels. Panels stay mounted but render
// null while inactive, so the sidebar cannot read every row at runtime; keep this list in sync
// when rows are added, renamed, hidden conditionally, or represented as panel-level results.
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // ── General ────────────────────────────────────────────────────────────────
  {
    target: "setting-language",
    id: "general:language",
    section: "general",
    title: "common:general_languageAria",
    keywords: "settings:chooseTheLanguageUsedByTheInterfaceSystemEnglish",
  },
  {
    target: "setting-default-provider",
    id: "general:default-provider",
    section: "general",
    title: "settings:changed_defaultProvider",
    keywords: "settings:chooseTheProviderUsedForNewChatsAgentCodex",
  },
  {
    target: "setting-new-threads",
    id: "general:new-threads",
    section: "general",
    title: "settings:general_newThreads",
    keywords: "settings:pickTheDefaultWorkspaceModeForNewlyCreatedDraft2",
  },
  {
    target: "setting-delete-worktree-on-archive",
    id: "general:delete-worktree-on-archive",
    section: "general",
    title: "settings:deleteWorktreeOnArchive",
    keywords: "settings:afterArchiveSUndoPeriodRemoveACleanWorktree2",
  },
  {
    target: "setting-move-sent-messages-to-top",
    id: "general:move-sent-messages-to-top",
    section: "general",
    title: "settings:moveSentMessagesToTop",
    keywords: "settings:moveEachSentMessageToTheTopOfThe2",
  },
  {
    target: "setting-thread-tabs",
    id: "general:thread-tabs",
    section: "general",
    title: "settings:threadTabs",
    keywords: "settings:showOpenThreadsAsTabsInTheChatHeader3",
  },
  {
    target: "setting-welcome-tour",
    id: "general:welcome-tour",
    section: "general",
    title: "settings:welcomeTour",
    keywords: "settings:replayTheFirstRunSetupFeatureTourProviderSelection2",
  },
  {
    target: "setting-project-order",
    id: "general:project-order",
    section: "general",
    title: "settings:general_projectOrder",
    keywords: "settings:controlsHowProjectsAreArrangedInTheMainSidebar2",
  },
  {
    target: "setting-thread-order",
    id: "general:thread-order",
    section: "general",
    title: "settings:general_threadOrder",
    keywords: "settings:controlsHowThreadsAreArrangedInsideEachProjectIn2",
  },
  {
    target: "setting-working-and-unread-on-top",
    id: "general:thread-attention-first",
    section: "general",
    title: "workspace:workingAndUnreadOnTop",
    keywords: "settings:withRecentlyActiveOrderMoveWorkingAndUnreadThreads",
  },
  {
    target: "setting-chats",
    id: "general:chats-section",
    section: "general",
    title: "workspace:general_chats",
    keywords: "settings:showTheStandaloneChatsListInTheSidebarFooter2",
  },
  {
    target: "setting-hubs",
    id: "general:groups-section",
    section: "general",
    title: "common:hubs",
    keywords: "settings:showTheHubsTabInTheSidebarSwitcherSidebar",
  },
  {
    target: "setting-automation-runs",
    id: "general:automation-run-threads",
    section: "general",
    title: "settings:automationRuns",
    keywords: "settings:showTheThreadEachStandaloneAutomationRunCreatesIn",
  },
  {
    target: "setting-open-by-default",
    id: "general:environment-default-open",
    section: "general",
    title: "settings:openByDefault",
    keywords: "settings:openTheChatEnvironmentPanelAutomaticallyOnNormalThreads",
  },
  {
    target: "setting-subagents",
    id: "general:environment-subagents",
    section: "general",
    title: "chat:subagents",
    keywords: "settings:showACompactSummaryOfTheChatSSubagents2",
  },
  {
    target: "setting-usage",
    id: "general:environment-usage",
    section: "general",
    title: "chat:general_usage",
    keywords: "settings:showTheProviderUsageRowInTheChatEnvironment",
  },
  {
    target: "setting-repository",
    id: "general:environment-repository",
    section: "general",
    title: "git:general_repository",
    keywords: "settings:showTheGitHubRepositoryLinkInTheChatEnvironment",
  },
  {
    target: "setting-pull-request",
    id: "general:environment-pull-request",
    section: "general",
    title: "git:general_environmentPullRequest",
    keywords: "settings:showTheOpenPullRequestCIChecksAndReview",
  },
  {
    target: "setting-editor",
    id: "general:environment-editor",
    section: "general",
    title: "chat:general_editor",
    keywords: "settings:showTheEditorSectionInAppEditorViewAnd",
  },
  {
    target: "setting-recap",
    id: "general:environment-recap",
    section: "general",
    title: "chat:recap_label",
    keywords: "settings:showTheAutoGeneratedChatRecapInTheEnvironment",
  },
  {
    target: "setting-pinned-messages",
    id: "general:environment-pinned",
    section: "general",
    title: "settings:general_pinnedMessages",
    keywords: "settings:showThePinnedMessagesChecklistInTheEnvironmentPanel",
  },
  {
    target: "setting-project-instructions",
    id: "general:environment-instructions",
    section: "general",
    title: "workspace:general_projectInstructions",
    keywords: "settings:showProjectLevelInstructionsInTheEnvironmentPanel",
  },
  {
    target: "setting-notepad",
    id: "general:environment-notepad",
    section: "general",
    title: "chat:general_notepad",
    keywords: "settings:showThePerThreadNotepadInTheEnvironmentPanel",
  },

  // ── Appearance ───────────────────────────────────────────────────────────────
  {
    target: "setting-ascii-background",
    id: "appearance:ascii-background",
    section: "appearance",
    title: "settings:asciiBackground",
    keywords: "settings:asciiBackgroundSearch",
  },
  {
    target: "setting-theme",
    id: "appearance:theme",
    section: "appearance",
    title: "onboarding:changed_theme",
    keywords: "settings:chooseHowSynaraLooksAcrossTheAppDarkLight",
  },
  {
    id: "appearance:app-icon",
    section: "appearance",
    title: "settings:appIcon",
    keywords: "settings:chooseTheIconSynaraUsesInTheDockOr2",
    target: null,
  },
  {
    id: "appearance:custom-title-bar",
    section: "appearance",
    title: "settings:useCustomTitleBar",
    keywords: "settings:framelessWindowSystemTitleBarWindowsLinuxCaptionControls",
    target: null,
  },
  {
    target: "setting-use-system-ui-font",
    id: "appearance:system-ui-font",
    section: "appearance",
    title: "settings:useSystemUIFont",
    keywords: "settings:useTheOperatingSystemInterfaceFontThroughoutSynara",
  },
  {
    target: "setting-ui-density",
    id: "appearance:ui-density",
    section: "appearance",
    title: "settings:changed_uiDensity",
    keywords: "settings:controlSpacingInTheSidebarComposerChatGuttersAnd2",
  },
  {
    target: "setting-chat-width",
    id: "appearance:chat-width",
    section: "appearance",
    title: "settings:chatWidth",
    keywords: "settings:controlHowWideTheChatColumnGrowsSoTables",
  },
  {
    target: "setting-base-font-size",
    id: "appearance:base-font-size",
    section: "appearance",
    title: "settings:changed_baseFontSize",
    keywords: "settings:adjustTheAppTextBaseInPixelsChatAnd",
  },
  {
    target: "setting-terminal-font-size",
    id: "appearance:terminal-font-size",
    section: "appearance",
    title: "settings:changed_terminalFontSize",
    keywords: "settings:adjustTerminalTextIndependentlyFromTheAppAndChat",
  },
  {
    target: "setting-terminal-font",
    id: "appearance:terminal-font",
    section: "appearance",
    title: "settings:changed_terminalFont",
    keywords: "settings:typeAnyMonospaceFontInstalledOnThisDeviceE",
  },
  {
    id: "appearance:font-smoothing",
    section: "appearance",
    title: "settings:changed_fontSmoothing",
    keywords: "settings:useMacOSStyleAntialiasingForLighterCrisperTextRendering",
    target: null,
  },
  {
    target: "setting-time-format",
    id: "appearance:time-format",
    section: "appearance",
    title: "settings:changed_timeFormat",
    keywords: "settings:systemDefaultFollowsYourBrowserOrOSClockPreference2",
  },

  // ── Notifications ─────────────────────────────────────────────────────────────
  {
    target: "setting-activity-toasts",
    id: "notifications:activity-toasts",
    section: "notifications",
    title: "settings:changed_activityToasts",
    keywords: "settings:showAnInAppToastWhenAChatOr2",
  },
  {
    target: "setting-desktop-notifications",
    id: "notifications:desktop-notifications",
    section: "notifications",
    title: "settings:changed_desktopNotifications",
    keywords: "settings:showAnOSNotificationWhenAChatOrManaged2",
  },
  {
    target: "setting-wait-for-subagents",
    id: "notifications:wait-for-subagents",
    section: "notifications",
    title: "settings:waitForSubagents",
    keywords: "settings:alertOnceTheAgentAndAllOfItsBackground2",
  },

  // ── AppSnap ───────────────────────────────────────────────────────────────────
  {
    target: "setting-enable-appsnap",
    id: "appsnap:enable",
    section: "appsnap",
    title: "settings:enableAppSnap",
    keywords: "settings:captureTheFrontmostMacOSAppWindowWithAConfigurable",
  },
  {
    target: "setting-shortcut",
    id: "appsnap:shortcut",
    section: "appsnap",
    title: "settings:shortcut",
    keywords: "settings:pressTheLeftAndRightOptionKeysAtThe",
  },
  {
    target: "setting-destination",
    id: "appsnap:destination",
    section: "appsnap",
    title: "git:destination",
    keywords: "settings:snapsJoinTheTaskYouInteractedWithInThe",
  },
  {
    target: "setting-capture-sound",
    id: "appsnap:capture-sound",
    section: "appsnap",
    title: "settings:captureSound",
    keywords: "settings:playAShortShutterCueWhenAWindowIs2",
  },
  {
    id: "appsnap:permissions",
    section: "appsnap",
    title: "settings:permissionStatus",
    keywords: "settings:inputMonitoringAndScreenRecordingPermissionsForAppSnapIn",
    // Renders only in the macOS desktop app, so no stable anchor on other platforms.
    target: null,
  },

  // ── Computer use ──────────────────────────────────────────────────────────────
  {
    id: "computer:status",
    section: "computer",
    title: "settings:computerStatus",
    keywords: "settings:whetherAgentsCanSeeAndControlThisComputerS",
    // The status row is conditional and its title is dynamic (Ready /
    // Reconnecting / Unavailable), so link to the section rather than an
    // anchored row.
    target: null,
  },
  {
    target: "setting-preview",
    id: "computer:open-automatically",
    section: "computer",
    title: "workspace:settings_gitToastPreview",
    keywords: "settings:showTheInChatComputerPreviewTheFirstTime",
    applies: () => true,
  },
  {
    target: "setting-computer-control",
    id: "computer:how-agents-use-the-desktop",
    section: "computer",
    title: "settings:computerControl",
    keywords: "settings:letTheAgentUseTheDesktopInAnyChat2",
  },
  {
    target: "setting-cursor-colors",
    id: "computer:cursor-colors",
    section: "computer",
    title: "settings:cursorColors",
    keywords: "settings:theAgentPointerSColorsStockMonochromeByDefault",
  },
  {
    id: "computer:always-allowed",
    section: "computer",
    title: "settings:alwaysAllowed",
    keywords: "settings:durablePerAppAlwaysAllowGrantsFromComputerApprovals",
    target: null,
  },

  // ── Behavior ──────────────────────────────────────────────────────────────────
  {
    target: "setting-side-chat-expiry",
    id: "behavior:sidechat-expiry",
    section: "behavior",
    title: "settings:sideChatExpiry",
    keywords: "settings:expireASideChatAfterItSitsIdleFor",
  },
  {
    target: "setting-follow-up-behavior",
    id: "behavior:follow-up-behavior",
    section: "behavior",
    title: "settings:followUpBehavior",
    keywords: "settings:chooseWhetherMessagesSentDuringAnActiveTurnWait",
  },
  {
    target: "setting-enter-while-dictating",
    id: "behavior:enter-while-dictating",
    section: "behavior",
    title: "settings:enterWhileDictating",
    keywords: "settings:chooseWhatEnterDoesWhileAVoiceNoteIs2",
  },
  {
    target: "setting-assistant-output",
    id: "behavior:assistant-output",
    section: "behavior",
    title: "settings:changed_assistantOutput",
    keywords: "settings:showTokenByTokenOutputWhileAResponseIs2",
  },
  {
    target: "setting-fold-finished-turns",
    id: "behavior:fold-finished-turns",
    section: "behavior",
    title: "settings:foldFinishedTurns",
    keywords: "settings:hideAFinishedTurnSToolCallsAndIntermediate",
  },
  {
    target: "setting-effort-slider",
    id: "behavior:effort-slider",
    section: "behavior",
    title: "settings:effortSlider",
    keywords: "settings:showReasoningEffortAsASliderInTheComposer",
  },
  {
    target: "setting-automatically-open-simulator",
    id: "behavior:auto-open-simulator",
    section: "behavior",
    title: "settings:automaticallyOpenSimulator",
    keywords: "settings:disableAutomaticIOSSimulatorDevicePaneOpeningUseSimulator",
  },
  {
    target: "setting-open-pull-requests-and-issues",
    id: "behavior:github-link-destination",
    section: "behavior",
    title: "settings:openPullRequestsAndIssues",
    keywords: "settings:chooseWhereGitHubLinksInChatsOpenBuiltIn",
  },
  {
    target: "setting-pull-request-diff-colors",
    id: "behavior:pull-request-diff-colors",
    section: "behavior",
    title: "settings:pullRequestDiffColors",
    keywords: "settings:showAdditionsInGreenAndDeletionsInRedIn2",
  },
  {
    target: "setting-include-fork-upstreams",
    id: "behavior:include-fork-upstreams",
    section: "behavior",
    title: "settings:includeForkUpstreams",
    keywords: "settings:alsoListPullRequestsAndIssuesFromEachProject2",
  },
  {
    target: "setting-diff-layout",
    id: "behavior:diff-layout",
    section: "behavior",
    title: "settings:diffLayout",
    keywords: "settings:defaultStackedSplitReviewPanelSideBySideUnified",
  },
  {
    target: "setting-diff-line-wrapping",
    id: "behavior:diff-line-wrapping",
    section: "behavior",
    title: "settings:changed_diffLineWrapping",
    keywords: "settings:setTheDefaultWrapStateWhenTheDiffPanel",
  },
  {
    target: "setting-delete-confirmation",
    id: "behavior:delete-confirmation",
    section: "behavior",
    title: "settings:changed_deleteConfirmation",
    keywords: "settings:askBeforeDeletingAThreadAndItsChatHistory2",
  },
  {
    target: "setting-archive-confirmation",
    id: "behavior:archive-confirmation",
    section: "behavior",
    title: "settings:changed_archiveConfirmation",
    keywords: "settings:askBeforeArchivingAThreadSafetyConfirm",
  },
  {
    target: "setting-terminal-close-confirmation",
    id: "behavior:terminal-close-confirmation",
    section: "behavior",
    title: "settings:changed_terminalCloseConfirmation",
    keywords: "settings:askBeforeClosingATerminalTabAndClearingIts2",
  },
  {
    id: "behavior:keep-computer-awake",
    section: "behavior",
    title: "common:keepComputerAwake",
    keywords: "settings:caffeinateSleepMacOSPreventSleepKeepAwakeAgentWorking",
    // Row only renders on macOS with caffeinate available.
    target: null,
  },

  // ── Keybindings ───────────────────────────────────────────────────────────────
  {
    id: "shortcuts:keyboard-shortcuts",
    section: "shortcuts",
    title: "common:advanced_keybindings",
    keywords: "settings:everyKeyboardShortcutAvailableInSynaraChangeAddRemove",
    target: null,
  },

  // ── Worktrees ─────────────────────────────────────────────────────────────────
  {
    id: "worktrees:managed-worktrees",
    section: "worktrees",
    title: "onboarding:managedWorktrees",
    keywords: "settings:reviewAndCleanUpTheWorktreesCreatedBySynara",
    target: null,
  },

  // ── Archived ──────────────────────────────────────────────────────────────────
  {
    id: "archived:archived-threads",
    section: "archived",
    title: "settings:archivedThreads",
    keywords: "settings:viewAndRestoreArchivedThreadsUnarchiveHistory",
    target: null,
  },

  // ── Models ────────────────────────────────────────────────────────────────────
  {
    target: "setting-source-control-writing-style",
    id: "models:source-control-writing-style",
    section: "models",
    title: "settings:sourceControlWritingStyle",
    keywords: "settings:repositoryConventionsConventionalCommitsCustomInstructionsCommitMessagesPR",
  },
  {
    target: "setting-git-writing-model",
    id: "models:git-writing-model",
    section: "models",
    title: "settings:changed_gitWritingModel",
    keywords: "settings:usedForGeneratedCommitMessagesPRTitlesAndBranch",
  },
  {
    target: "setting-saved-model-slugs",
    id: "models:saved-model-slugs",
    section: "models",
    title: "settings:models_savedModelSlugs",
    keywords: "settings:addCustomModelSlugsForSupportedProvidersCustomModel",
  },

  // ── Providers ─────────────────────────────────────────────────────────────────
  {
    target: "setting-resume-after-usage-limits",
    id: "providers:usage-limit-recovery",
    section: "providers",
    title: "settings:resumeAfterUsageLimits",
    keywords: "settings:resumeAfterUsageLimitsDescription",
  },
  {
    target: "setting-keep-synara-responsive",
    id: "providers:cpu-priority",
    section: "providers",
    title: "settings:keepSynaraResponsive",
    keywords: "settings:lowerAgentCPUSchedulingPriorityPerformanceLoadNiceResponsiveness",
  },
  {
    target: "setting-automatic-cli-update-checks",
    id: "providers:automatic-cli-update-checks",
    section: "providers",
    title: "settings:providerUpdates_automaticCliUpdateChecks",
    keywords: "settings:checkCodexClaudeAndOtherProviderCLIsForNewer2",
  },
  {
    target: "setting-enabled-providers",
    id: "providers:enabled-providers",
    section: "providers",
    title: "settings:enabledProviders",
    keywords: "settings:allowBackgroundChecksAndNewTurnsEnablingAProvider",
  },
  {
    target: "setting-available-clis",
    id: "providers:available-clis",
    section: "providers",
    title: "settings:availableCLIs",
    keywords: "settings:showOrHideInstalledProvidersInThePickerAnd",
  },
  {
    target: "setting-provider-updates",
    id: "providers:provider-updates",
    section: "providers",
    title: "settings:providerUpdates_providerUpdates",
    keywords: "settings:updateInstalledProviderToolsThatSynaraCanSafelyUpdate",
  },
  {
    target: "setting-installed-clis",
    id: "providers:installed-clis",
    section: "providers",
    title: "settings:providers_installedClis",
    keywords: "settings:reviewProviderVersionsAndUpdateToolsBinaryOverridesPath",
  },

  // ── Skills ────────────────────────────────────────────────────────────────────
  {
    id: "skills:skills",
    section: "skills",
    title: "common:plugin_skillsSection",
    keywords: "settings:everySkillFoundAcrossProvidersWithTogglesToControl",
    target: null,
  },

  // ── Usage ─────────────────────────────────────────────────────────────────────
  {
    id: "usage:usage",
    section: "usage",
    title: "settings:usageAndBilling",
    keywords: "settings:remainingQuotaAndCreditsForEachSignedInProvider",
    target: null,
  },

  {
    id: "usage:sidebar-rings",
    section: "usage",
    title: "settings:sidebarUsageRings",
    keywords: "settings:chooseUpToTwoProviderAccountsForUsageRings",
    target: null,
  },

  // ── Advanced ──────────────────────────────────────────────────────────────────
  {
    target: "setting-keybindings",
    id: "advanced:keybindings",
    section: "advanced",
    title: "common:advanced_keybindings",
    keywords: "settings:openThePersistedKeybindingsJsonFileToEditAdvanced2",
  },
  {
    target: "setting-recovery-tools",
    id: "advanced:recovery-tools",
    section: "advanced",
    title: "settings:advanced_recoveryTools",
    keywords: "settings:advanced_recoveryToolsDescription",
  },
  {
    id: "connectors:catalog",
    section: "connectors",
    title: "settings:connectors",
    keywords: "settings:connectorsSearch",
    target: null,
    applies: () => isSettingsSectionAvailable("connectors"),
  },
  {
    target: "setting-external-mcp-integrations",
    id: "integrations:external-mcp",
    section: "integrations",
    title: "settings:externalMCPIntegrations",
    keywords: "settings:pairCodexClaudeAndOtherLocalMCPClientsWith",
  },
  {
    target: "setting-version",
    id: "advanced:version",
    section: "advanced",
    title: "settings:advanced_version",
    keywords: "settings:currentApplicationVersionAbout",
  },
  {
    target: "setting-what-s-new-since-0-9-2",
    id: "advanced:feature-tour",
    section: "advanced",
    title: "settings:whatSNewSince092",
    keywords: "settings:replayFeatureTourRedesignedWorkspaceProviderAccountsCodeReview",
  },
  {
    target: "setting-release-history",
    id: "advanced:release-history",
    section: "advanced",
    title: "common:advanced_releaseHistory",
    keywords: "settings:aRunningLogOfEveryUpdateNewestFirstChangelog",
  },
] as const;

const SETTINGS_SECTION_LABEL_BY_ID = new Map<SettingsSectionId, string>(
  SETTINGS_NAV_ITEMS.map((item) => [item.id, item.label]),
);

export function settingsSectionLabel(section: SettingsSectionId): string {
  const label = SETTINGS_SECTION_LABEL_BY_ID.get(section);
  return label === undefined ? section : t(label);
}

/**
 * Fuzzy-rank settings rows for the sidebar search. Title carries the strongest intent;
 * the description/synonym keywords and the owning section label match more loosely so a
 * query like "appearance" or "wrap" still surfaces the right rows.
 */
export function rankSettingsSearchEntries(
  query: string,
  limit: number,
  context: SettingsSearchContext | undefined = DEFAULT_SETTINGS_SEARCH_CONTEXT,
): readonly SettingsSearchEntry[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const resolvedContext = context ?? DEFAULT_SETTINGS_SEARCH_CONTEXT;
  const available = SETTINGS_SEARCH_ENTRIES.filter(
    (entry) => entry.applies?.(resolvedContext) ?? true,
  );
  const ranked = rankProviderDiscoveryItems(available, trimmed, (entry) => [
    { value: i18n.t(entry.title, { lng: "en" }) },
    { value: i18n.t(entry.title, { lng: i18n.language, defaultValue: entry.title }) },
    { value: i18n.t(entry.keywords, { lng: "en" }), weight: 200 },
    {
      value: i18n.t(entry.keywords, { lng: i18n.language, defaultValue: entry.keywords }),
      weight: 200,
    },
    {
      value: i18n.t(SETTINGS_SECTION_LABEL_BY_ID.get(entry.section) ?? entry.section, {
        lng: "en",
      }),
      weight: 400,
    },
    {
      value: i18n.t(SETTINGS_SECTION_LABEL_BY_ID.get(entry.section) ?? entry.section, {
        lng: i18n.language,
      }),
      weight: 400,
    },
  ]);
  return ranked.slice(0, limit);
}
