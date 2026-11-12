// FILE: settingsSearchIndex.ts
// Purpose: Declarative, searchable index of settings rows/sections so the sidebar can
//          surface matches by title/description the same way the editor file search does.
// Layer: Route/UI support
// Exports: entry type, the index, section label lookup, and the ranking helper

import { rankProviderDiscoveryItems } from "~/lib/providerDiscovery";
import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";
import { i18n, t } from "~/i18n";
import {
  GENERATED_SETTINGS_SEARCH_ROWS,
  type GeneratedSettingsSearchRow,
} from "./settingsSearchRows.generated";
import {
  isSettingsSectionAvailable,
  providerAccountAnchorId,
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
  /** Catalog keys (or, for literal entries, plain words) the query is also matched against. */
  keywords: readonly string[];
  /** The row's own description key, shown under the title where results have room. */
  description?: string;
  target?: string | null;
  /**
   * Whether this row exists on the machine the user is actually looking at.
   * Omitted means "always". A search result for a row the panel does not render
   * is a dead end: it scrolls to an anchor that is not there, and it tells the
   * user Synara has a setting it does not.
   */
  applies?: (context: SettingsSearchContext) => boolean;
  /**
   * Title and keywords are user data (an account's name and email), shown and matched
   * as written instead of being looked up as catalog keys.
   */
  literal?: boolean;
}

/** One configured agent account, so search can find it by name, email, or agent. */
export interface SettingsSearchAccount {
  readonly instanceId: string;
  readonly label: string;
  readonly providerLabel: string;
  readonly identity: string | null;
}

/**
 * What the index needs to know about this server to decide which rows exist.
 * Deliberately a handful of booleans rather than the status objects themselves —
 * the index answers "does this row render", not "what does it say".
 */
export interface SettingsSearchContext {
  /** Configured accounts; each becomes a result that opens its row on Accounts. */
  readonly accounts?: ReadonlyArray<SettingsSearchAccount> | undefined;
}

const DEFAULT_SETTINGS_SEARCH_CONTEXT: SettingsSearchContext = {};

/** DOM id a result deep-links to, or null for panel-level entries with no anchored row. */
export function settingsSearchEntryTarget(entry: SettingsSearchEntry): string | null {
  return entry.target ?? null;
}

/** Text of a catalog key (or a literal entry's own words) in the given language. */
function entryText(entry: SettingsSearchEntry, value: string, lng?: string): string {
  if (entry.literal) return value;
  return lng ? i18n.t(value, { lng }) : t(value);
}

/** One line about a result: the row's description, else its search words. */
export function settingsSearchEntryDescription(entry: SettingsSearchEntry): string {
  if (entry.literal) return entry.keywords.join(" ");
  return t(entry.description ?? entry.keywords.at(-1) ?? "");
}

/** The title a result shows: a catalog title translated, an account name as written. */
export function settingsSearchEntryTitle(entry: SettingsSearchEntry): string {
  return entryText(entry, entry.title);
}

function accountSearchEntries(
  accounts: ReadonlyArray<SettingsSearchAccount>,
): SettingsSearchEntry[] {
  return accounts.map((account) => ({
    id: `accounts:account:${account.instanceId}`,
    section: "accounts",
    title: providerAccountQualifiedLabel(account.providerLabel, account.label),
    keywords: [account.identity ?? "", account.providerLabel].filter(Boolean),
    target: providerAccountAnchorId(account.instanceId),
    literal: true,
  }));
}

/**
 * Words people search with that a row's own copy does not say (synonyms, older names),
 * keyed by the row's anchor. The row itself — title, description, page — comes from
 * {@link GENERATED_SETTINGS_SEARCH_ROWS}, read from the settings source.
 */
export const ROW_EXTRA_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "setting-default-provider": [
    "settings:chooseTheProviderUsedForNewChatsAgentCodex",
    "default provider default agent default account",
  ],
  "setting-new-threads": ["settings:pickTheDefaultWorkspaceModeForNewlyCreatedDraft2"],
  "setting-delete-worktree-on-archive": ["settings:afterArchiveSUndoPeriodRemoveACleanWorktree2"],
  "setting-move-sent-messages-to-top": ["settings:moveEachSentMessageToTheTopOfThe2"],
  "setting-thread-tabs": ["settings:showOpenThreadsAsTabsInTheChatHeader3"],
  "setting-welcome-tour": ["settings:replayTheFirstRunSetupFeatureTourProviderSelection2"],
  "setting-project-order": ["settings:controlsHowProjectsAreArrangedInTheMainSidebar2"],
  "setting-thread-order": ["settings:controlsHowThreadsAreArrangedInsideEachProjectIn2"],
  "setting-working-and-unread-on-top": [
    "settings:withRecentlyActiveOrderMoveWorkingAndUnreadThreads",
  ],
  "setting-chats": ["settings:showTheStandaloneChatsListInTheSidebarFooter2"],
  "setting-hubs": ["settings:showTheHubsTabInTheSidebarSwitcherSidebar"],
  "setting-automation-runs": ["settings:showTheThreadEachStandaloneAutomationRunCreatesIn"],
  "setting-open-by-default": ["settings:openTheChatEnvironmentPanelAutomaticallyOnNormalThreads"],
  "setting-subagents": ["settings:showACompactSummaryOfTheChatSSubagents2"],
  "setting-repository": ["settings:showTheGitHubRepositoryLinkInTheChatEnvironment"],
  "setting-pull-request": ["settings:showTheOpenPullRequestCIChecksAndReview"],
  "setting-editor": ["settings:showTheEditorSectionInAppEditorViewAnd"],
  "setting-ascii-background": ["settings:asciiBackgroundSearch"],
  "setting-app-icon": ["settings:chooseTheIconSynaraUsesInTheDockOr2"],
  "setting-use-custom-title-bar": [
    "settings:framelessWindowSystemTitleBarWindowsLinuxCaptionControls",
  ],
  "setting-use-system-ui-font": ["settings:useTheOperatingSystemInterfaceFontThroughoutSynara"],
  "setting-ui-density": ["settings:controlSpacingInTheSidebarComposerChatGuttersAnd2"],
  "setting-chat-width": ["settings:controlHowWideTheChatColumnGrowsSoTables"],
  "setting-base-font-size": ["settings:adjustTheAppTextBaseInPixelsChatAnd"],
  "setting-terminal-font": ["settings:typeAnyMonospaceFontInstalledOnThisDeviceE"],
  "setting-time-format": ["settings:systemDefaultFollowsYourBrowserOrOSClockPreference2"],
  "setting-activity-toasts": ["settings:showAnInAppToastWhenAChatOr2"],
  "setting-desktop-notifications": ["settings:showAnOSNotificationWhenAChatOrManaged2"],
  "setting-wait-for-subagents": ["settings:alertOnceTheAgentAndAllOfItsBackground2"],
  "setting-enable-appsnap": ["settings:captureTheFrontmostMacOSAppWindowWithAConfigurable"],
  "setting-shortcut": ["settings:pressTheLeftAndRightOptionKeysAtThe"],
  "setting-destination": ["settings:snapsJoinTheTaskYouInteractedWithInThe"],
  "setting-capture-sound": ["settings:playAShortShutterCueWhenAWindowIs2"],
  "setting-preview": ["settings:showTheInChatComputerPreviewTheFirstTime"],
  "setting-cursor-colors": ["settings:theAgentPointerSColorsStockMonochromeByDefault"],
  "setting-side-chat-expiry": ["settings:expireASideChatAfterItSitsIdleFor"],
  "setting-follow-up-behavior": ["settings:chooseWhetherMessagesSentDuringAnActiveTurnWait"],
  "setting-enter-while-dictating": ["settings:chooseWhatEnterDoesWhileAVoiceNoteIs2"],
  "setting-assistant-output": ["settings:showTokenByTokenOutputWhileAResponseIs2"],
  "setting-fold-finished-turns": ["settings:hideAFinishedTurnSToolCallsAndIntermediate"],
  "setting-effort-slider": ["settings:showReasoningEffortAsASliderInTheComposer"],
  "setting-automatically-open-simulator": [
    "settings:disableAutomaticIOSSimulatorDevicePaneOpeningUseSimulator",
  ],
  "setting-open-pull-requests-and-issues": ["settings:chooseWhereGitHubLinksInChatsOpenBuiltIn"],
  "setting-pull-request-diff-colors": ["settings:showAdditionsInGreenAndDeletionsInRedIn2"],
  "setting-include-fork-upstreams": ["settings:alsoListPullRequestsAndIssuesFromEachProject2"],
  "setting-diff-layout": ["settings:defaultStackedSplitReviewPanelSideBySideUnified"],
  "setting-diff-line-wrapping": ["settings:setTheDefaultWrapStateWhenTheDiffPanel"],
  "setting-delete-confirmation": ["settings:askBeforeDeletingAThreadAndItsChatHistory2"],
  "setting-archive-confirmation": ["settings:askBeforeArchivingAThreadSafetyConfirm"],
  "setting-terminal-close-confirmation": ["settings:askBeforeClosingATerminalTabAndClearingIts2"],
  "setting-keybindings": ["settings:openThePersistedKeybindingsJsonFileToEditAdvanced2"],
  "setting-source-control-writing-style": [
    "settings:repositoryConventionsConventionalCommitsCustomInstructionsCommitMessagesPR",
  ],
  "setting-saved-model-slugs": ["settings:addCustomModelSlugsForSupportedProvidersCustomModel"],
  "setting-keep-synara-responsive": [
    "settings:lowerAgentCPUSchedulingPriorityPerformanceLoadNiceResponsiveness",
  ],
  "setting-automatic-cli-update-checks": ["settings:checkCodexClaudeAndOtherProviderCLIsForNewer2"],
  "setting-provider-updates": ["settings:updateInstalledProviderToolsThatSynaraCanSafelyUpdate"],
  "setting-version": ["settings:currentApplicationVersionAbout"],
  "setting-app-tour": ["settings:appTourKeywords"],
  "setting-release-history": ["settings:aRunningLogOfEveryUpdateNewestFirstChangelog"],
  "setting-keep-computer-awake": ["settings:caffeinateSleepMacOSPreventSleepKeepAwakeAgentWorking"],
  "setting-stay-awake-for-remote-access": [
    "Keep the Mac awake while plugged in and remote access is on. prevent sleep power battery",
  ],
};

/** Rows that exist only on some machines; omitted rows are offered everywhere. */
export const ROW_APPLIES: Readonly<Record<string, (context: SettingsSearchContext) => boolean>> = {
  // Only the desktop app can keep the machine awake for remote access.
  "setting-stay-awake-for-remote-access": () =>
    typeof window !== "undefined" && Boolean(window.desktopBridge?.keepAwake),
};

function generatedRowEntry(row: GeneratedSettingsSearchRow): SettingsSearchEntry {
  const applies = ROW_APPLIES[row.target];
  return {
    id: `${row.section}:${row.target.replace(/^setting-/, "")}`,
    section: row.section,
    title: row.title,
    keywords: [...(ROW_EXTRA_KEYWORDS[row.target] ?? []), row.description].filter(
      (value) => value.length > 0,
    ),
    ...(row.description ? { description: row.description } : {}),
    target: row.target,
    ...(applies ? { applies } : {}),
  };
}

// Results that are a page or a group rather than one row (no row to read them from), plus
// the theme picker, which sits on the page instead of in a row. Everything else is generated.
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // ── Accounts (first, so they win ties with other "account" rows) ─────────────
  {
    id: "accounts:accounts",
    section: "accounts",
    title: "settings:nav_accounts",
    keywords: ["settings:accounts_searchKeywords"],
    target: null,
  },
  {
    id: "accounts:add-account",
    section: "accounts",
    title: "settings:addAccount",
    keywords: ["settings:accounts_addAccountKeywords"],
    target: null,
  },

  // ── Every anchored settings row, read from the settings source ──────────────
  ...GENERATED_SETTINGS_SEARCH_ROWS.map(generatedRowEntry),

  // ── Pages and groups ─────────────────────────────────────────────────────────
  {
    target: "setting-providers",
    id: "providers:agents",
    section: "providers",
    title: "settings:providers_agentsList",
    description: "settings:chooseVisibleCodingAgentsAndManageTheirInstalledCLI",
    // The one list that replaced Enabled providers, Available CLIs, and Installed CLIs.
    keywords: [
      "settings:allowBackgroundChecksAndNewTurnsEnablingAProvider",
      "settings:showOrHideInstalledProvidersInThePickerAnd",
      "settings:reviewProviderVersionsAndUpdateToolsBinaryOverridesPath",
      "enabled providers available CLIs installed CLIs picker order",
    ],
  },
  {
    id: "privacy:share-product-analytics",
    section: "privacy",
    title: "Share product analytics",
    keywords: ["Privacy consent anonymous statistics collection tracking performance Cloudflare"],
  },
  {
    target: "setting-theme",
    id: "appearance:theme",
    section: "appearance",
    title: "onboarding:changed_theme",
    keywords: ["settings:chooseHowSynaraLooksAcrossTheAppDarkLight"],
  },
  {
    id: "appsnap:permissions",
    section: "appsnap",
    title: "settings:permissionStatus",
    keywords: ["settings:inputMonitoringAndScreenRecordingPermissionsForAppSnapIn"],
    // Renders only in the macOS desktop app, so no stable anchor on other platforms.
    target: null,
  },
  {
    id: "computer:status",
    section: "computer",
    title: "settings:computerStatus",
    keywords: ["settings:whetherAgentsCanSeeAndControlThisComputerS"],
    // The status row is conditional and its title is dynamic (Ready /
    // Reconnecting / Unavailable), so link to the section rather than an
    // anchored row.
    target: null,
  },
  {
    target: "setting-computer-control",
    id: "computer:how-agents-use-the-desktop",
    section: "computer",
    title: "settings:computerControl",
    keywords: ["settings:letTheAgentUseTheDesktopInAnyChat2"],
  },
  {
    id: "computer:always-allowed",
    section: "computer",
    title: "settings:alwaysAllowed",
    keywords: ["settings:durablePerAppAlwaysAllowGrantsFromComputerApprovals"],
    target: null,
  },
  {
    id: "worktrees:managed-worktrees",
    section: "worktrees",
    title: "onboarding:managedWorktrees",
    keywords: ["settings:reviewAndCleanUpTheWorktreesCreatedBySynara"],
    target: null,
  },
  {
    id: "archived:archived-threads",
    section: "archived",
    title: "settings:archivedThreads",
    keywords: ["settings:viewAndRestoreArchivedThreadsUnarchiveHistory"],
    target: null,
  },
  {
    id: "skills:skills",
    section: "skills",
    title: "common:plugin_skillsSection",
    keywords: ["settings:everySkillFoundAcrossProvidersWithTogglesToControl"],
    target: null,
  },
  {
    id: "usage:usage",
    section: "usage",
    title: "settings:usageAndBilling",
    keywords: ["settings:remainingQuotaAndCreditsForEachSignedInProvider"],
    target: null,
  },
  {
    id: "usage:sidebar-rings",
    section: "usage",
    title: "settings:sidebarUsageRings",
    keywords: ["settings:chooseUpToTwoProviderAccountsForUsageRings"],
    target: null,
  },
  {
    id: "connectors:catalog",
    section: "connectors",
    title: "settings:connectors",
    keywords: ["settings:connectorsSearch"],
    target: null,
    applies: () => isSettingsSectionAvailable("connectors"),
  },
  {
    target: "setting-external-mcp-integrations",
    id: "integrations:external-mcp",
    section: "integrations",
    title: "settings:externalMCPIntegrations",
    keywords: ["settings:pairCodexClaudeAndOtherLocalMCPClientsWith"],
  },
  {
    id: "connections:this-computer",
    section: "connections",
    title: "Control this computer",
    keywords: [
      "Devices that can control this Mac or computer. allow connections add iphone ipad qr code pairing approve revoke access trusted devices",
    ],
    target: null,
  },
  {
    id: "connections:other-computers",
    section: "connections",
    title: "Control other devices",
    keywords: [
      "Computers you can control from this one. host server laptop connect open remote relay back to this computer disconnect forget pairing code share workspace discoverable",
    ],
    target: null,
  },
  {
    id: "connections:ssh",
    section: "connections",
    title: "SSH",
    keywords: [
      "Link a headless machine with a short code, or forward the SSH port. device code link approve vps cli browserless",
    ],
    target: null,
  },
  {
    id: "connections:advanced",
    section: "connections",
    title: "Account devices and sessions",
    keywords: [
      "Advanced: devices signed in to your account, active sessions, and unlinking this machine. revoke sign out lost stolen last used end session unlink",
    ],
    target: null,
  },
];

const SETTINGS_SECTION_LABEL_BY_ID = new Map<SettingsSectionId, string>(
  SETTINGS_NAV_ITEMS.map((item) => [item.id, item.label]),
);

export function settingsSectionLabel(section: SettingsSectionId): string {
  const label = SETTINGS_SECTION_LABEL_BY_ID.get(section);
  return label === undefined ? section : t(label);
}

/** Fuzzy-rank settings rows for the sidebar search and the command palette. */
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
  const available = [
    ...SETTINGS_SEARCH_ENTRIES.filter((entry) => entry.applies?.(resolvedContext) ?? true),
    ...(isSettingsSectionAvailable("accounts")
      ? accountSearchEntries(resolvedContext.accounts ?? [])
      : []),
  ];
  const ranked = rankProviderDiscoveryItems(available, trimmed, searchHaystack);
  return ranked.slice(0, limit);
}

type SearchHaystack = ReadonlyArray<{ readonly value: string; readonly weight?: number }>;

// English copy is bundled, so an entry's match text never changes; build it once per entry
// rather than on every keystroke. Account entries are rebuilt per query and fall out of the
// map with them.
const HAYSTACK_BY_ENTRY = new WeakMap<SettingsSearchEntry, SearchHaystack>();

/**
 * Title carries the strongest intent; the description/synonym keywords and the owning
 * section label match more loosely so a query like "appearance" or "wrap" still surfaces
 * the right rows.
 */
function searchHaystack(entry: SettingsSearchEntry): SearchHaystack {
  const cached = HAYSTACK_BY_ENTRY.get(entry);
  if (cached) return cached;
  const haystack: SearchHaystack = [
    { value: entryText(entry, entry.title, "en") },
    {
      value: entry.keywords.map((keyword) => entryText(entry, keyword, "en")).join(" "),
      weight: 200,
    },
    {
      value: i18n.t(SETTINGS_SECTION_LABEL_BY_ID.get(entry.section) ?? entry.section, {
        lng: "en",
      }),
      weight: 400,
    },
  ];
  HAYSTACK_BY_ENTRY.set(entry, haystack);
  return haystack;
}
