// FILE: BehaviorSettings.tsx
// Purpose: Behavior settings panel (runtime behavior toggles and safety confirmations).
// Layer: Settings UI components
// Exports: BehaviorSettings

import { type AppSettings } from "../../appSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function BehaviorSettings({
  settings,
  defaults,
  updateSettings,
}: {
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <div className="space-y-6">
      <SettingsSection title="Runtime behavior">
        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: defaults.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({
                  enableAssistantStreaming: Boolean(checked),
                })
              }
              aria-label="Stream assistant messages"
            />
          }
        />

        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens. The in-panel wrap toggle only affects the current diff session."
          resetAction={
            settings.diffWordWrap !== defaults.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: defaults.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) =>
                updateSettings({
                  diffWordWrap: Boolean(checked),
                })
              }
              aria-label="Wrap diff lines by default"
            />
          }
        />

        <SettingsRow
          title="Prompt suggestions"
          description="Show suggested prompts under the composer when starting a new thread."
          resetAction={
            settings.enableComposerSuggestions !== defaults.enableComposerSuggestions ? (
              <SettingResetButton
                label="prompt suggestions"
                onClick={() =>
                  updateSettings({
                    enableComposerSuggestions: defaults.enableComposerSuggestions,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableComposerSuggestions}
              onCheckedChange={(checked) =>
                updateSettings({
                  enableComposerSuggestions: Boolean(checked),
                })
              }
              aria-label="Show composer prompt suggestions"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Safety confirmations">
        <SettingsRow
          title="Delete confirmation"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: defaults.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({
                  confirmThreadDelete: Boolean(checked),
                })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />

        <SettingsRow
          title="Archive confirmation"
          description="Ask before archiving a thread."
          resetAction={
            settings.confirmThreadArchive !== defaults.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: defaults.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({
                  confirmThreadArchive: Boolean(checked),
                })
              }
              aria-label="Confirm thread archive"
            />
          }
        />

        <SettingsRow
          title="Terminal close confirmation"
          description="Ask before closing a terminal tab and clearing its history."
          resetAction={
            settings.confirmTerminalTabClose !== defaults.confirmTerminalTabClose ? (
              <SettingResetButton
                label="terminal close confirmation"
                onClick={() =>
                  updateSettings({
                    confirmTerminalTabClose: defaults.confirmTerminalTabClose,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmTerminalTabClose}
              onCheckedChange={(checked) =>
                updateSettings({
                  confirmTerminalTabClose: Boolean(checked),
                })
              }
              aria-label="Confirm terminal tab close"
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
