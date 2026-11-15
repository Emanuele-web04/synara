// FILE: settingsNavigation.ts
// Purpose: Share the settings topic taxonomy between the main sidebar and the settings screen.
// Layer: Route/UI support
// Exports: section ids, nav items, and search normalization helper

import { MCP_CONNECTORS_BETA_FEATURE } from "@synara/shared/betaFeatures";

import { isBetaFeatureOn } from "~/betaFeatures";
import { ACCOUNT_BILLING_ENABLED } from "~/lib/accountBillingFlag";
import { KEYBINDINGS_ICON_NAME } from "~/lib/icons";

export const SETTINGS_SECTION_IDS = [
  "general",
  "profile",
  "accounts",
  "appearance",
  "layout",
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
  "connections",
  "privacy",
  "advanced",
  "about",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
export type SettingsNavGroupId =
  | "pinned"
  | "synara"
  | "agents"
  | "connections"
  | "workspace"
  | "system";

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
// The pinned group (Profile, Accounts) sits above every titled group and has no visible
// heading, the way an account row tops a system settings sidebar.
export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: SettingsNavGroupId;
  label: string;
  hideLabel?: boolean;
}> = [
  { id: "pinned", label: "settings:navGroup_you", hideLabel: true },
  { id: "synara", label: "settings:navGroup_synara" },
  { id: "agents", label: "settings:navGroup_agents" },
  { id: "connections", label: "settings:navGroup_connections" },
  { id: "workspace", label: "settings:navGroup_workspace" },
  { id: "system", label: "common:themeOptions_system" },
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
    id: "profile",
    group: "pinned",
    label: "computer:nav_profile",
    description: "settings:nav_profileDescription",
    icon: "user",
    eyebrow: "Your stats",
  },
  {
    id: "accounts",
    group: "pinned",
    label: "settings:nav_accounts",
    description: "settings:nav_accountsDescription",
    icon: "people-id-card",
    eyebrow: "Agent sign-ins",
  },
  {
    id: "general",
    group: "synara",
    label: "settings:nav_general",
    description: "settings:nav_generalDescription",
    icon: "settings-gear-4",
    eyebrow: "Workflow defaults",
  },
  {
    id: "appearance",
    group: "synara",
    label: "common:nav_appearance",
    description: "settings:customizeTheThemeTypographyDensityAndTimeFormat",
    icon: "color-palette",
    eyebrow: "Visual language",
  },
  {
    id: "layout",
    group: "synara",
    label: "settings:nav_layout",
    description: "settings:nav_layoutDescription",
    icon: "layout-sidebar",
    eyebrow: "Sidebar and panels",
  },
  {
    id: "behavior",
    group: "synara",
    label: "settings:nav_chats",
    description: "settings:controlLiveResponsesFollowUpsReviewDefaultsAndSafety",
    icon: "chat-bubbles",
    eyebrow: "Interaction rules",
  },
  {
    id: "notifications",
    group: "synara",
    label: "settings:nav_notifications",
    description: "settings:chooseHowSynaraTellsYouWhenWorkFinishesOr",
    icon: "bell",
    eyebrow: "Alerts",
  },
  {
    id: "shortcuts",
    group: "synara",
    label: "settings:nav_keyboardShortcuts",
    description: "settings:changeAddOrRemoveTheShortcutForEverySynara",
    icon: KEYBINDINGS_ICON_NAME,
    eyebrow: "Key bindings",
  },
  {
    id: "providers",
    group: "agents",
    label: "settings:nav_providers",
    description: "settings:chooseVisibleCodingAgentsAndManageTheirInstalledCLI",
    icon: "puzzle",
    eyebrow: "Coding agents",
  },
  {
    id: "models",
    group: "agents",
    label: "settings:nav_models",
    description: "settings:chooseTheSourceControlWritingStyleGitWritingModel",
    icon: "brain",
    eyebrow: "Model configuration",
  },
  {
    id: "skills",
    group: "agents",
    label: "settings:nav_skills",
    description: "settings:reviewReusableWorkflowsDiscoveredAcrossAllConfiguredProviders",
    icon: "building-blocks",
    eyebrow: "Reusable workflows",
  },
  {
    id: "usage",
    group: "agents",
    // The Synara plan is the Billing tab here, so builds that ship it say so.
    label: ACCOUNT_BILLING_ENABLED ? "settings:usageAndBilling" : "settings:nav_usage",
    description: "settings:seeRemainingQuotaAndCreditsForEverySignedIn",
    icon: "gauge",
    eyebrow: "Provider limits",
  },
  {
    id: "connectors",
    group: "connections",
    label: "settings:connectors",
    description: "settings:connectorsDescription",
    icon: "connectors-1",
    eyebrow: "Remote MCP servers",
  },
  {
    id: "integrations",
    group: "connections",
    label: "settings:nav_externalAgents",
    description: "settings:giveCodexClaudeAndOtherLocalAgentsScopedAccess",
    icon: "plugin-1",
    eyebrow: "External agents",
  },
  {
    id: "connections",
    group: "connections",
    label: "settings:nav_devices",
    description:
      "Control this computer from your other devices, or control other computers from here.",
    icon: "globe",
    eyebrow: "Remote access",
  },
  {
    id: "computer",
    group: "connections",
    label: "settings:computerUse",
    description: "settings:letAgentsSeeAndControlThisComputerSDesktop",
    icon: "computer-use",
    eyebrow: "Desktop control",
    badge: "workspace:beta",
  },
  {
    id: "appsnap",
    group: "connections",
    label: "settings:appSnap",
    description: "settings:captureAnotherAppSFrontmostWindowDirectlyIntoA",
    icon: "screen-capture",
    eyebrow: "Screen capture",
  },
  {
    id: "worktrees",
    group: "workspace",
    label: "settings:nav_worktrees",
    description: "settings:reviewAndCleanUpIsolatedWorkspacesCreatedBySynara",
    icon: "branch-simple",
    eyebrow: "Workspace management",
  },
  {
    id: "archived",
    group: "workspace",
    label: "settings:nav_archive",
    description: "settings:findAndRestoreThreadsYouPreviouslyArchived",
    icon: "archive",
    eyebrow: "Thread management",
  },
  {
    id: "privacy",
    group: "system",
    label: "settings:nav_privacy",
    description: "settings:nav_privacyDescription",
    icon: "shield",
    eyebrow: "Sharing and access",
  },
  {
    id: "advanced",
    group: "system",
    label: "settings:nav_advanced",
    description: "settings:nav_advancedDescription",
    icon: "toolbox",
    eyebrow: "System tools",
  },
  {
    id: "about",
    group: "system",
    label: "settings:nav_about",
    description: "settings:nav_aboutDescription",
    icon: "circle-info",
    eyebrow: "Version and releases",
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

/** Stable scroll target for one account's row on the Accounts page. */
export function providerAccountAnchorId(instanceId: string): string {
  return `setting-account-${instanceId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * Route search for opening a settings page (optionally scrolled to a row). Page-scoped keys
 * — an open account, a provider filter — belong to the page they were opened on, so moving
 * to any page clears them.
 */
export function settingsPageSearch(section: SettingsSectionId | undefined, target?: string) {
  return {
    section: section === "general" ? undefined : section,
    target,
    account: undefined,
    provider: undefined,
  };
}

/** Stable scroll target for one provider's card on the Accounts page. */
export function providerAccountsSectionId(provider: string): string {
  return `accounts-${provider.toLowerCase()}`;
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

/** Sections whose state lives on the computer that runs the agents, so Settings can open them on a connected computer. */
const HOST_SETTINGS_SECTIONS: ReadonlySet<SettingsSectionId> = new Set([
  "accounts",
  "worktrees",
  "archived",
  "models",
  "providers",
  "skills",
  "usage",
  "connectors",
  "integrations",
]);

export function isHostSettingsSection(section: SettingsSectionId): boolean {
  return HOST_SETTINGS_SECTIONS.has(section);
}
