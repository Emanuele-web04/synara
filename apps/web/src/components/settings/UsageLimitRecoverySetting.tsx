// FILE: UsageLimitRecoverySetting.tsx
// Purpose: Opt into host-owned usage-limit recovery without changing another computer's policy.

import { useUsageLimitRecoverySetting } from "~/hooks/useUsageLimitRecoverySetting";
import { useTranslation } from "~/i18n";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsPanelPrimitives";

export function UsageLimitRecoverySetting() {
  const { t } = useTranslation();
  const recoverySetting = useUsageLimitRecoverySetting();

  if (!recoverySetting.supported) return null;

  return (
    <SettingsRow
      id="setting-resume-after-usage-limits"
      title="settings:resumeAfterUsageLimits"
      description="settings:resumeAfterUsageLimitsDescription"
      control={
        <Switch
          checked={recoverySetting.enabled}
          disabled={!recoverySetting.ready}
          onCheckedChange={(checked) => void recoverySetting.setEnabled(Boolean(checked))}
          aria-label={t("settings:resumeAfterUsageLimits")}
        />
      }
    />
  );
}
