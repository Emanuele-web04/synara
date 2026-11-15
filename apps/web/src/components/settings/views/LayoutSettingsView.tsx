// FILE: LayoutSettingsView.tsx
// Purpose: Settings › Layout: what the sidebar, the chat top bar, and the Environment panel show.
// Layer: Settings view
// Exports: LayoutSettingsView

import { type AppSettingsBinding } from "~/appSettings";
import { GROUPS_ON } from "~/betaFeatures";
import { BooleanSettingRow, BooleanSettingToggle } from "~/components/settings/BooleanSettingRow";
import { SettingResetButton, SettingsSelectControl } from "~/components/settings/SettingControls";
import {
  SettingsRow,
  SettingsSection,
  SettingsToggleGroup,
} from "~/components/settings/SettingsPanelPrimitives";
import { SelectItem } from "~/components/ui/select";
import { useTranslation } from "~/i18n";
import { SETTINGS_TARGETS } from "~/settingsNavigation";

const SIDEBAR_PROJECT_SORT_ORDER_LABELS = {
  updated_at: "settings:sortLabels_recentlyActive",
  created_at: "settings:sortLabels_recentlyAdded",
  manual: "settings:sortLabels_manualOrder",
} as const;

const SIDEBAR_THREAD_SORT_ORDER_LABELS = {
  updated_at: "settings:sortLabels_recentlyActive",
  created_at: "settings:sortLabels_newestFirst",
} as const;

export function LayoutSettingsView(binding: AppSettingsBinding) {
  const { settings, defaults, updateSettings } = binding;
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
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

        <BooleanSettingRow
          {...binding}
          id="setting-working-and-unread-on-top"
          settingKey="sidebarThreadAttentionFirst"
          title="workspace:workingAndUnreadOnTop"
          description="settings:withRecentlyActiveOrderMoveWorkingAndUnreadThreads2"
          resetLabel="settings:workingAndUnreadOnTop"
          ariaLabel="settings:moveWorkingAndUnreadThreadsToTheTopOf"
        />
      </SettingsSection>

      <SettingsSection title="settings:general_sidebarSections">
        <BooleanSettingRow
          {...binding}
          id="setting-chats"
          settingKey="showChatsSection"
          title="workspace:general_chats"
          description="settings:showTheStandaloneChatsListInTheSidebarFooter"
          resetLabel="settings:chatsSection"
          ariaLabel="settings:showTheChatsSectionInTheSidebar"
        />

        {GROUPS_ON ? (
          <BooleanSettingRow
            {...binding}
            id="setting-hubs"
            settingKey="showGroupsSection"
            title="common:hubs"
            description="settings:showTheHubsTabInTheSidebarSwitcher"
            resetLabel="settings:hubsSection2"
            ariaLabel="settings:showTheHubsSectionInTheSidebar"
          />
        ) : null}

        <BooleanSettingRow
          {...binding}
          id="setting-automation-runs"
          settingKey="showAutomationRunThreads"
          title="settings:automationRuns"
          description="settings:showTheThreadEachStandaloneAutomationRunCreatesRuns"
          resetLabel="settings:automationRuns2"
          ariaLabel="settings:showAutomationRunThreadsInTheSidebar"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-nest-child-threads"
          settingKey="nestAgentCreatedThreads"
          title="settings:childThreads"
          description="settings:nestAgentCreatedThreadsDescription"
          resetLabel="settings:childThreadsReset"
          ariaLabel="settings:nestAgentCreatedThreadsAria"
        />
      </SettingsSection>

      <div id={SETTINGS_TARGETS.environmentPanel}>
        <SettingsSection title="settings:environmentPanel">
          <BooleanSettingRow
            {...binding}
            id="setting-open-by-default"
            settingKey="environmentPanelDefaultOpen"
            title="settings:openByDefault"
            description="settings:openTheChatEnvironmentPanelAutomaticallyOnNormalThreads2"
            resetLabel="settings:environmentPanelDefaultOpen"
            ariaLabel="settings:openTheEnvironmentPanelByDefaultOnNormalThreads"
          />
          <SettingsToggleGroup title="settings:codeAndStatus">
            <BooleanSettingToggle
              {...binding}
              id="setting-subagents"
              settingKey="showEnvironmentSubagents"
              title="chat:subagents"
              description="settings:showACompactSummaryOfTheChatSSubagents"
              ariaLabel="settings:showTheSubagentsSectionInTheEnvironmentPanel"
            />

            <BooleanSettingToggle
              {...binding}
              id="setting-usage"
              settingKey="showEnvironmentUsage"
              title="chat:general_usage"
              description="settings:showTheProviderUsageRowInTheChatEnvironment"
              ariaLabel="settings:showTheUsageSectionInTheEnvironmentPanel"
            />

            <BooleanSettingToggle
              {...binding}
              id="setting-repository"
              settingKey="showEnvironmentRepository"
              title="git:general_repository"
              description="settings:showTheGitHubRepositoryLinkInTheChatEnvironment2"
              ariaLabel="settings:showTheRepositorySectionInTheEnvironmentPanel"
            />

            <BooleanSettingToggle
              {...binding}
              id="setting-pull-request"
              settingKey="showEnvironmentPullRequest"
              title="git:general_environmentPullRequest"
              description="settings:showTheOpenPullRequestCIChecksAndReview2"
              ariaLabel="settings:showThePullRequestSectionInTheEnvironmentPanel"
            />

            <BooleanSettingToggle
              {...binding}
              id="setting-editor"
              settingKey="showEnvironmentEditor"
              title="chat:general_editor"
              description="settings:showTheEditorSectionInAppEditorViewAnd2"
              ariaLabel="settings:showTheEditorSectionInTheEnvironmentPanel"
            />

            <BooleanSettingToggle
              {...binding}
              id="setting-actions"
              settingKey="showEnvironmentActions"
              title="workspace:actions"
              description="settings:environmentActionsDescription"
              ariaLabel="settings:environmentActionsLabel"
            />
          </SettingsToggleGroup>
          <SettingsToggleGroup title="settings:contextAndNotes">
            <BooleanSettingToggle
              {...binding}
              id="setting-recap"
              settingKey="showEnvironmentRecap"
              title="chat:recap_label"
              description="settings:showTheAutoGeneratedChatRecapInTheEnvironment"
              ariaLabel="settings:showTheRecapSectionInTheEnvironmentPanel"
            />

            <BooleanSettingToggle
              {...binding}
              id="setting-pinned-messages"
              settingKey="showEnvironmentPinned"
              title="settings:general_pinnedMessages"
              description="settings:showThePinnedMessagesChecklistInTheEnvironmentPanel"
              ariaLabel="settings:showThePinnedMessagesSectionInTheEnvironmentPanel"
            />

            <BooleanSettingToggle
              {...binding}
              id="setting-project-instructions"
              settingKey="showEnvironmentInstructions"
              title="workspace:general_projectInstructions"
              description="settings:showProjectLevelInstructionsInTheEnvironmentPanel"
              ariaLabel="settings:showTheProjectInstructionsSectionInTheEnvironmentPanel"
            />

            <BooleanSettingToggle
              {...binding}
              id="setting-notepad"
              settingKey="showEnvironmentNotepad"
              title="chat:general_notepad"
              description="settings:showThePerThreadNotepadInTheEnvironmentPanel"
              ariaLabel="settings:showTheNotepadSectionInTheEnvironmentPanel"
            />
          </SettingsToggleGroup>
        </SettingsSection>
      </div>

      <SettingsSection title="settings:chatTopBar">
        <BooleanSettingRow
          {...binding}
          id="setting-thread-tabs"
          settingKey="showOpenThreadTabs"
          title="settings:threadTabs"
          description="settings:showOpenThreadsAsTabsInTheChatHeader2"
          resetLabel="settings:threadTabs2"
          ariaLabel="settings:showOpenThreadsAsTabsInTheChatHeader"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-hand-off"
          settingKey="showHeaderHandoff"
          title="common:header_handOff"
          description="settings:headerHandoffDescription"
          resetLabel="settings:headerHandoffReset"
          ariaLabel="settings:headerHandoffLabel"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-project-actions"
          settingKey="showHeaderActions"
          title="workspace:projectActions"
          description="settings:headerActionsDescription"
          resetLabel="settings:headerActionsReset"
          ariaLabel="settings:headerActionsLabel"
        />
      </SettingsSection>

      <SettingsSection title="settings:layout_opensOnItsOwn">
        <BooleanSettingRow
          {...binding}
          id="setting-automatically-open-simulator"
          settingKey="autoOpenDevicePane"
          title="settings:automaticallyOpenSimulator"
          description="settings:openTheIOSSimulatorPaneWhenAnAgentUses"
          resetLabel="settings:automaticallyOpenSimulator2"
          ariaLabel="settings:automaticallyOpenSimulator"
        />
      </SettingsSection>
    </div>
  );
}
