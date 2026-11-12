// FILE: AboutSettingsView.tsx
// Purpose: Settings › About: the release channel (Synara Beta), version, and release history.
// Layer: Settings view
// Exports: AboutSettingsView

import { AboutSettingsSection } from "~/components/settings/AdvancedSettingsPanel";
import { BetaChannelSettingsPanel } from "~/components/settings/DesktopSettingsPanels";

export function AboutSettingsView({ onOpenReleaseHistory }: { onOpenReleaseHistory: () => void }) {
  return (
    <div className="space-y-6">
      <BetaChannelSettingsPanel active={true} />
      <AboutSettingsSection onOpenReleaseHistory={onOpenReleaseHistory} />
    </div>
  );
}
