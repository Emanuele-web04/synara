// FILE: ChatsSettingsView.tsx
// Purpose: Settings › Chats: composer and conversation behavior, code review defaults, confirmations.
// Layer: Settings view
// Exports: ChatsSettingsView

import { type SidechatExpiry } from "@synara/contracts";
import {
  type AppSettingsBinding,
  type FollowUpBehavior,
  type GitHubLinkOpenTarget,
  type VoiceEnterBehavior,
} from "~/appSettings";
import { BooleanSettingRow } from "~/components/settings/BooleanSettingRow";
import {
  SettingResetButton,
  SettingsSegmentedControl,
  SettingsSelectControl,
} from "~/components/settings/SettingControls";
import { SettingsRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { SelectItem } from "~/components/ui/select";
import {
  DEFAULT_DIFF_RENDER_MODE,
  DIFF_RENDER_MODE_STORAGE_KEY,
  type DiffRenderMode,
  DiffRenderModeSchema,
} from "~/diffRenderMode";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTranslation } from "~/i18n";

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

const VOICE_ENTER_BEHAVIOR_OPTIONS = [
  { value: "stop", label: "chat:stop" },
  { value: "send", label: "settings:stopAndSend" },
] as const satisfies ReadonlyArray<{ value: VoiceEnterBehavior; label: string }>;

// ── Settings UI primitives ────────────────────────────────────────────────

// Shared settings controls live in ~/components/settings/SettingControls.

export function ChatsSettingsView(binding: AppSettingsBinding) {
  const { settings, defaults, updateSettings } = binding;
  const { t } = useTranslation();
  const [defaultDiffRenderMode, setDefaultDiffRenderMode] = useLocalStorage(
    DIFF_RENDER_MODE_STORAGE_KEY,
    DEFAULT_DIFF_RENDER_MODE,
    DiffRenderModeSchema,
  );
  return (
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

        <BooleanSettingRow
          {...binding}
          id="setting-assistant-output"
          settingKey="enableAssistantStreaming"
          title="settings:changed_assistantOutput"
          description="settings:showTokenByTokenOutputWhileAResponseIs"
          resetLabel="settings:assistantOutput"
          ariaLabel="settings:streamAssistantMessages"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-fold-finished-turns"
          settingKey="collapseFinishedTurns"
          title="settings:foldFinishedTurns"
          description="settings:hideAFinishedTurnSToolCallsAndIntermediate2"
          resetLabel="settings:foldFinishedTurns2"
          ariaLabel="settings:foldFinishedTurns"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-move-sent-messages-to-top"
          settingKey="anchorSentMessagesToTop"
          title="settings:moveSentMessagesToTop"
          description="settings:moveEachSentMessageToTheTopOfThe"
          resetLabel="settings:moveSentMessagesToTop2"
          ariaLabel="settings:moveSentMessagesToTop"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-effort-slider"
          settingKey="composerEffortSlider"
          title="settings:effortSlider"
          description="settings:showEffortAsASliderAtTheBottomOf"
          resetLabel="settings:effortSlider2"
          ariaLabel="settings:showEffortSliderInTheComposer"
        />
      </SettingsSection>

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

        <BooleanSettingRow
          {...binding}
          id="setting-pull-request-diff-colors"
          settingKey="showPullRequestDiffColors"
          title="settings:pullRequestDiffColors"
          description="settings:showAdditionsInGreenAndDeletionsInRedIn"
          resetLabel="settings:pullRequestDiffColors2"
          ariaLabel="settings:showPullRequestDiffColors"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-include-fork-upstreams"
          settingKey="githubInboxIncludeUpstreams"
          title="settings:includeForkUpstreams"
          description="settings:alsoListPullRequestsAndIssuesFromEachProject"
          resetLabel="settings:includeForkUpstreams2"
          ariaLabel="settings:includeForkUpstreamsInCodeReview"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-diff-line-wrapping"
          settingKey="diffWordWrap"
          title="settings:changed_diffLineWrapping"
          description="settings:setTheDefaultWrapStateWhenTheDiffPanel2"
          resetLabel="settings:diffLineWrapping"
          ariaLabel="settings:wrapDiffLinesByDefault"
        />
      </SettingsSection>

      <SettingsSection title="settings:behavior_safetyConfirmations">
        <BooleanSettingRow
          {...binding}
          id="setting-delete-confirmation"
          settingKey="confirmThreadDelete"
          title="settings:changed_deleteConfirmation"
          description="settings:askBeforeDeletingAThreadAndItsChatHistory"
          resetLabel="settings:deleteConfirmation"
          ariaLabel="settings:confirmThreadDeletion"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-archive-confirmation"
          settingKey="confirmThreadArchive"
          title="settings:changed_archiveConfirmation"
          description="settings:askBeforeArchivingAThread"
          resetLabel="settings:archiveConfirmation"
          ariaLabel="settings:confirmThreadArchive"
        />

        <BooleanSettingRow
          {...binding}
          id="setting-terminal-close-confirmation"
          settingKey="confirmTerminalTabClose"
          title="settings:changed_terminalCloseConfirmation"
          description="settings:askBeforeClosingATerminalTabAndClearingIts"
          resetLabel="settings:terminalCloseConfirmation"
          ariaLabel="settings:confirmTerminalTabClose"
        />
      </SettingsSection>
    </div>
  );
}
