// FILE: _chat.settings.tsx
// Purpose: Render the dedicated settings experience with its own section sidebar and grouped panels.
// Layer: Route screen
// Exports: Settings route component for `/settings`

import type { ProviderKind } from "@synara/contracts";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useAppSettings } from "../appSettings";
import { APP_VERSION } from "../branding";
import { RouteInsetSurface } from "../components/RouteInsetSurface";
import ReleaseHistoryDialog from "../components/ReleaseHistoryDialog";
import { SidebarHeaderNavigationControls } from "../components/SidebarHeaderNavigationControls";
import {
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "../components/chat/chatHeaderControls";
import {
  CHAT_CONTENT_CARD_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "../components/chat/composerPickerStyles";
import { SettingsComputerPicker } from "../components/hosts/ComputerPicker";
import {
  AdvancedSettingsPanel,
  KeybindingsFileSettingsSection,
} from "../components/settings/AdvancedSettingsPanel";
import { AccountsSettingsPanel } from "../components/settings/accounts/AccountsSettingsPanel";
import { ComputerSettingsPanel } from "../components/settings/ComputerSettingsPanel";
import { ConnectionsSettingsPanel } from "../components/settings/ConnectionsSettingsPanel";
import {
  ArchivedSettingsPanel,
  WorktreesSettingsPanel,
} from "../components/settings/ConversationStorageSettingsPanels";
import {
  AppSnapSettingsPanel,
  NotificationsSettingsPanel,
} from "../components/settings/DesktopSettingsPanels";
import { ExternalMcpSettingsPanel } from "../components/settings/ExternalMcpSettingsPanel";
import {
  KeyboardShortcutsResetButton,
  KeyboardShortcutsSettingsPanel,
} from "../components/settings/KeyboardShortcutsSettingsPanel";
import { McpConnectorsSettingsPanel } from "../components/settings/McpConnectorsSettingsPanel";
import { ModelsSettingsPanel } from "../components/settings/ModelsSettingsPanel";
import { ProfileSettingsPanel } from "../components/settings/ProfileSettingsPanel";
import { ProvidersSettingsPanel } from "../components/settings/providers/ProvidersSettingsPanel";
import { SkillsSettingsPanel } from "../components/settings/SkillsSettingsPanel";
import { UsageSettingsPanel } from "../components/settings/UsageSettingsPanel";
import { AboutSettingsView } from "../components/settings/views/AboutSettingsView";
import { AppearanceSettingsView } from "../components/settings/views/AppearanceSettingsView";
import { ChatsSettingsView } from "../components/settings/views/ChatsSettingsView";
import { GeneralSettingsView } from "../components/settings/views/GeneralSettingsView";
import { LayoutSettingsView } from "../components/settings/views/LayoutSettingsView";
import { PrivacySettingsView } from "../components/settings/views/PrivacySettingsView";
import { UsageLimitSettingsSection } from "../components/settings/views/UsageLimitSettingsSection";
import { WorktreeDefaultsSection } from "../components/settings/views/WorktreeDefaultsSection";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useDesktopTopBarTrafficLightGutterClassName } from "../hooks/useDesktopTopBarGutter";
import { useSettingsRestoreDefaults } from "../hooks/useSettingsRestoreDefaults";
import { useTranslation } from "../i18n";
import { ACCOUNT_BILLING_ENABLED } from "../lib/accountBillingFlag";
import { useSettingsComputerRoute } from "../lib/hosts/settingsComputer";
import { readWorkspaceFrame } from "../lib/hosts/workspaceFrame";
import { ResetIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { isProviderKind } from "../providerOrdering";
import {
  normalizeSettingsSection,
  providerAccountsSectionId,
  SETTINGS_NAV_ITEMS,
} from "../settingsNavigation";
import { SETTINGS_PAGE_BACKGROUND_CLASS_NAME } from "../settingsPanelStyles";

// ── Route screen ───────────────────────────────────────────────────────────

function SettingsRoute() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const redirecting = useSettingsComputerRoute(normalizeSettingsSection(search.section), search);
  return redirecting ? null : <SettingsRouteView />;
}

function SettingsRouteView() {
  const { t } = useTranslation();
  const isController = !readWorkspaceFrame();
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const activeSection = normalizeSettingsSection(routeSearch.section);
  const settingsTarget = typeof routeSearch.target === "string" ? routeSearch.target : null;
  const settingsProviderTarget =
    typeof routeSearch.provider === "string" && isProviderKind(routeSearch.provider)
      ? routeSearch.provider
      : null;
  const settingsAccountTarget =
    activeSection === "accounts" && typeof routeSearch.account === "string"
      ? routeSearch.account
      : null;
  const activeSectionItem = SETTINGS_NAV_ITEMS.find((item) => item.id === activeSection)!;
  const navigate = useNavigate();
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const openAccount = (instanceId: string | null) => {
    void navigate({
      to: "/settings",
      search: (previous) => ({
        ...previous,
        section: "accounts",
        account: instanceId ?? undefined,
        provider: undefined,
        target: undefined,
      }),
    });
  };
  const manageAccounts = (provider: ProviderKind) => {
    void navigate({
      to: "/settings",
      search: (previous) => ({
        ...previous,
        section: "accounts",
        account: undefined,
        provider: undefined,
        target: providerAccountsSectionId(provider),
      }),
    });
  };

  const { settings, defaults, updateSettings, updateSettingsAndWait, resetSettings } =
    useAppSettings();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const [releaseHistoryOpen, setReleaseHistoryOpen] = useState(false);

  const { changedSettingLabels, restoreDefaults, resetEpoch } = useSettingsRestoreDefaults({
    settings,
    defaults,
    updateSettings,
    resetSettings,
  });

  const binding = { settings, defaults, updateSettings };

  // Opening or leaving an account shows its view from the top, like a new page.
  useEffect(() => {
    if (settingsTarget) return;
    contentScrollRef.current?.scrollTo({ top: 0 });
  }, [settingsAccountTarget, settingsTarget]);

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

  const billingEnabled = ACCOUNT_BILLING_ENABLED;

  const renderRouteOwnedPanel = () => {
    switch (activeSection) {
      case "general":
        return <GeneralSettingsView {...binding} />;
      case "appearance":
        return <AppearanceSettingsView {...binding} />;
      case "layout":
        return <LayoutSettingsView {...binding} />;
      case "behavior":
        return <ChatsSettingsView {...binding} />;
      case "privacy":
        return <PrivacySettingsView />;
      case "about":
        return <AboutSettingsView onOpenReleaseHistory={() => setReleaseHistoryOpen(true)} />;
      case "worktrees":
        return isController ? (
          <div className="mb-6">
            <WorktreeDefaultsSection {...binding} />
          </div>
        ) : null;
      case "shortcuts":
        return (
          <div className="space-y-6">
            <KeyboardShortcutsSettingsPanel />
            <KeybindingsFileSettingsSection resetEpoch={resetEpoch} />
          </div>
        );
      case "profile":
        return <ProfileSettingsPanel />;
      case "skills":
        return <SkillsSettingsPanel />;
      case "usage":
        // The plan lives with usage ("Usage and billing"), never above the profile.
        // Keyed by target so a plan deep link reopens the Billing tab.
        return (
          <UsageSettingsPanel
            key={settingsTarget ?? ""}
            billingEnabled={billingEnabled && isController}
            target={settingsTarget}
            overviewExtra={<UsageLimitSettingsSection {...binding} />}
          />
        );
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
          <div ref={contentScrollRef} className="flex-1 overflow-y-auto">
            <div
              className={cn(
                "mx-auto w-full px-6 py-8",
                activeSection === "connectors" || activeSection === "usage"
                  ? "max-w-4xl"
                  : activeSection === "profile"
                    ? "max-w-3xl"
                    : "max-w-2xl",
              )}
            >
              <SettingsComputerPicker section={activeSection} />
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
                  ) : isController ? (
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
                  ) : null}
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
                <AccountsSettingsPanel
                  active={activeSection === "accounts"}
                  accountId={settingsAccountTarget}
                  settings={settings}
                  defaults={defaults}
                  updateSettings={updateSettings}
                  updateSettingsAndWait={updateSettingsAndWait}
                  onOpenAccount={openAccount}
                />
                <ProvidersSettingsPanel
                  active={activeSection === "providers"}
                  providerTarget={settingsProviderTarget}
                  settings={settings}
                  defaults={defaults}
                  updateSettings={updateSettings}
                  updateSettingsAndWait={updateSettingsAndWait}
                  resetEpoch={resetEpoch}
                  onManageAccounts={manageAccounts}
                />
                <McpConnectorsSettingsPanel active={activeSection === "connectors"} />
                <ExternalMcpSettingsPanel active={activeSection === "integrations"} />
                <ConnectionsSettingsPanel
                  active={activeSection === "connections"}
                  billingEnabled={billingEnabled}
                />
                <AdvancedSettingsPanel
                  active={activeSection === "advanced"}
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
  component: SettingsRoute,
});
