// FILE: UsageLimitSettingsSection.tsx
// Purpose: Settings › Usage › "When you hit a limit": warnings near a limit and resuming after it resets.
// Layer: Settings view
// Exports: UsageLimitSettingsSection

import { type AppSettingsBinding } from "~/appSettings";
import { BooleanSettingRow } from "~/components/settings/BooleanSettingRow";
import { SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { UsageLimitRecoverySetting } from "~/components/settings/UsageLimitRecoverySetting";
import { readWorkspaceFrame } from "~/lib/hosts/workspaceFrame";

export function UsageLimitSettingsSection(binding: AppSettingsBinding) {
  const isController = !readWorkspaceFrame();
  return (
    <SettingsSection title="settings:usage_whenYouHitALimit">
      {isController ? (
        <BooleanSettingRow
          {...binding}
          id="setting-rate-limit-warnings"
          settingKey="showRateLimitWarnings"
          title="settings:rateLimitWarnings"
          description="settings:rateLimitWarningsDescription"
          resetLabel="settings:rateLimitWarnings2"
          ariaLabel="settings:showRateLimitWarnings"
        />
      ) : null}
      <UsageLimitRecoverySetting />
    </SettingsSection>
  );
}
