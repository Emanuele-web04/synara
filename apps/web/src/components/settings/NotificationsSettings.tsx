// FILE: NotificationsSettings.tsx
// Purpose: Notifications settings panel (activity toasts and desktop notifications).
// Layer: Settings UI components
// Exports: NotificationsSettings

import { type AppSettings } from "../../appSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  buildNotificationSettingsSupportText,
  type BrowserNotificationPermissionState,
} from "../../notifications/taskCompletion";
import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function NotificationsSettings({
  settings,
  defaults,
  updateSettings,
  browserNotificationPermission,
  onSetSystemNotifications,
  onSendTestNotification,
}: {
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  browserNotificationPermission: BrowserNotificationPermissionState;
  onSetSystemNotifications: (nextEnabled: boolean) => void;
  onSendTestNotification: () => void;
}) {
  return (
    <div className="space-y-6">
      <SettingsSection title="Activity alerts">
        <SettingsRow
          title="Activity toasts"
          description="Show an in-app toast when a chat or managed terminal agent finishes or needs input."
          resetAction={
            settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts ? (
              <SettingResetButton
                label="activity toasts"
                onClick={() =>
                  updateSettings({
                    enableTaskCompletionToasts: defaults.enableTaskCompletionToasts,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableTaskCompletionToasts}
              onCheckedChange={(checked) =>
                updateSettings({ enableTaskCompletionToasts: Boolean(checked) })
              }
              aria-label="Activity toast notifications"
            />
          }
        />

        <SettingsRow
          title="Desktop notifications"
          description="Show an OS notification when a chat or managed terminal agent finishes or needs input while the app is in the background."
          status={buildNotificationSettingsSupportText(browserNotificationPermission)}
          resetAction={
            settings.enableSystemTaskCompletionNotifications !==
            defaults.enableSystemTaskCompletionNotifications ? (
              <SettingResetButton
                label="desktop notifications"
                onClick={() =>
                  updateSettings({
                    enableSystemTaskCompletionNotifications:
                      defaults.enableSystemTaskCompletionNotifications,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
              <Button size="xs" variant="outline" onClick={() => onSendTestNotification()}>
                Test
              </Button>
              <Switch
                checked={settings.enableSystemTaskCompletionNotifications}
                onCheckedChange={(checked) => {
                  onSetSystemNotifications(Boolean(checked));
                }}
                aria-label="Desktop activity notifications"
              />
            </div>
          }
        />
      </SettingsSection>
    </div>
  );
}
