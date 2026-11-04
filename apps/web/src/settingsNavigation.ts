// FILE: settingsNavigation.ts
// Purpose: Share the settings topic taxonomy between the main sidebar and the settings screen.
// Layer: Route/UI support
// Exports: section ids, nav items, and search normalization helper

import { MCP_CONNECTORS_BETA_FEATURE } from "@synara/shared/betaFeatures";

import { isBetaFeatureOn } from "~/betaFeatures";
import { KEYBINDINGS_ICON_NAME } from "~/lib/icons";

export const SETTINGS_SECTION_IDS = [
  "general",
  "profile",
  "appearance",
  "notifications",
  "behavior",
  "appsnap",
  "computer",
  "shortcuts",
  "worktrees",
  "archived",
  "models",
  "providers",
  "skills",
  "usage",
  "connectors",
  "integrations",
  "advanced",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
export type SettingsNavGroupId = "personal" | "integrations" | "coding" | "system" | "archived";

/**
 * Deep-link scroll targets inside settings panels. Each id is shared by its DOM owner and callers
 * that navigate with `?target=…`; the settings route resolves every target after the active panel
 * mounts.
 */
export const SETTINGS_TARGETS = {
  providerUpdates: "provider-updates",
  providerInstalls: "provider-installs",
  environmentPanel: "environment-panel",
} as const;

export type SettingsNavItem = {
  id: SettingsSectionId;
  group: SettingsNavGroupId;
  label: string;
  description: string;
  /** Basename of a SVG under `/central-icons-reversed`. */
  icon: string;
  eyebrow: string;
  /**
   * Maturity label shown beside the section name, in the sidebar and on the
   * panel's own heading. Absent for a settled feature; one source so the two
   * places can never disagree about what is still in beta.
   */
  badge?: string;
};

// Keep English source keys here: callers translate at render time, while section/row ids stay stable.
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: SettingsNavGroupId;
  label: string;
}> = [
  { id: "personal", label: "settings:personal" },
  { id: "integrations", label: "common:integrations" },
  { id: "coding", label: "settings:coding" },
  { id: "system", label: "common:themeOptions_system" },
  { id: "archived", label: "workspace:archived_archivedRelative" },
] as const;

/** Sections that exist only where their Beta-only feature is on. */
const SETTINGS_SECTION_BETA_FEATURES: Partial<Record<SettingsSectionId, string>> = {
  connectors: MCP_CONNECTORS_BETA_FEATURE,
};

/** False for a Beta-only section on Stable: no nav entry, search result, or deep link. */
export function isSettingsSectionAvailable(
  section: SettingsSectionId,
  isOn: (feature: string) => boolean = isBetaFeatureOn,
): boolean {
  const feature = SETTINGS_SECTION_BETA_FEATURES[section];
  return feature === undefined || isOn(feature);
}

const ALL_SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    id: "general",
    group: "personal",
    label: "settings:nav_general",
    description: "settings:chooseDefaultsForNewChatsNavigationAndTheEnvironment",
    icon: "settings-gear-4",
    eyebrow: "Workflow defaults",
  },
  {
    id: "profile",
    group: "personal",
    label: "computer:nav_profile",
    description: "settings:nav_profileDescription",
    icon: "user",
    eyebrow: "Your stats",
  },
  {
    id: "appearance",
    group: "personal",
    label: "common:nav_appearance",
    description: "settings:customizeTheThemeTypographyDensityAndTimeFormat",
    icon: "color-palette",
    eyebrow: "Visual language",
  },
  {
    id: "notifications",
    group: "personal",
    label: "settings:nav_notifications",
    description: "settings:chooseHowSynaraTellsYouWhenWorkFinishesOr",
    icon: "bell",
    eyebrow: "Alerts",
  },
  {
    id: "behavior",
    group: "personal",
    label: "settings:chatBehavior",
    description: "settings:controlLiveResponsesFollowUpsReviewDefaultsAndSafety",
    icon: "settings-slider-hor",
    eyebrow: "Interaction rules",
  },
  {
    id: "shortcuts",
    group: "personal",
    label: "common:advanced_keybindings",
    description: "settings:changeAddOrRemoveTheShortcutForEverySynara",
    icon: KEYBINDINGS_ICON_NAME,
    eyebrow: "Key bindings",
  },
  {
    id: "usage",
    group: "personal",
    label: "settings:usageLimits",
    description: "settings:seeRemainingQuotaAndCreditsForEverySignedIn",
    icon: "gauge",
    eyebrow: "Provider limits",
  },
  {
    id: "appsnap",
    group: "integrations",
    label: "settings:appSnap",
    description: "settings:captureAnotherAppSFrontmostWindowDirectlyIntoA",
    icon: "screen-capture",
    eyebrow: "Screen capture",
  },
  {
    id: "computer",
    group: "integrations",
    label: "settings:computerUse",
    description: "settings:letAgentsSeeAndControlThisComputerSDesktop",
    icon: "computer-use",
    eyebrow: "Desktop control",
    badge: "workspace:beta",
  },
  {
    id: "connectors",
    group: "integrations",
    label: "settings:connectors",
    description: "settings:connectorsDescription",
    icon: "connectors-1",
    eyebrow: "Remote MCP servers",
  },
  {
    id: "integrations",
    group: "integrations",
    label: "settings:mCPConnections",
    description: "settings:giveCodexClaudeAndOtherLocalAgentsScopedAccess",
    icon: "plugin-1",
    eyebrow: "External agents",
  },
  {
    id: "providers",
    group: "coding",
    label: "settings:agentProviders",
    description: "settings:chooseVisibleCodingAgentsAndManageTheirInstalledCLI",
    icon: "puzzle",
    eyebrow: "Coding agents",
  },
  {
    id: "models",
    group: "coding",
    label: "settings:modelsWriting",
    description: "settings:chooseTheSourceControlWritingStyleGitWritingModel",
    icon: "brain",
    eyebrow: "Model configuration",
  },
  {
    id: "skills",
    group: "coding",
    label: "settings:nav_skillsEyebrow",
    description: "settings:reviewReusableWorkflowsDiscoveredAcrossAllConfiguredProviders",
    icon: "building-blocks",
    eyebrow: "Reusable workflows",
  },
  {
    id: "worktrees",
    group: "coding",
    label: "onboarding:managedWorktrees",
    description: "settings:reviewAndCleanUpIsolatedWorkspacesCreatedBySynara",
    icon: "branch-simple",
    eyebrow: "Workspace management",
  },
  {
    id: "advanced",
    group: "system",
    label: "settings:nav_advancedEyebrow",
    description: "settings:manageSessionsRecoveryToolsLowLevelKeybindingsAndVersion",
    icon: "toolbox",
    eyebrow: "System tools",
  },
  {
    id: "archived",
    group: "archived",
    label: "settings:archivedThreads",
    description: "settings:findAndRestoreThreadsYouPreviouslyArchived",
    icon: "archive",
    eyebrow: "Thread management",
  },
] as const;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = ALL_SETTINGS_NAV_ITEMS.filter(
  (item) => isSettingsSectionAvailable(item.id),
);

/**
 * Stable DOM id for a settings row, derived from its (string) title. Shared by the row that
 * renders the anchor and by the search index that deep-links to it via `?target=…`, so the
 * two can't drift. Panels stay mounted and render null while inactive, so the slug only needs
 * to be unique within a section.
 */
export function settingRowAnchorId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `setting-${slug}`;
}

export function normalizeSettingsSection(value: unknown): SettingsSectionId {
  if (typeof value !== "string") {
    return "general";
  }
  return (
    SETTINGS_SECTION_IDS.find(
      (candidate) => candidate === value && isSettingsSectionAvailable(candidate),
    ) ?? "general"
  );
}
