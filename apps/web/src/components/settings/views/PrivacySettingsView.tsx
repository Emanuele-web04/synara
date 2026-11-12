// FILE: PrivacySettingsView.tsx
// Purpose: Settings › Privacy: what Synara shares (product analytics) and what it may read
//          on this computer (Safari sign-ins for the in-app browser).
// Layer: Settings view
// Exports: PrivacySettingsView

import { SafariAccessSetupButton } from "~/components/SafariAccessOnboarding";
import { ProductAnalyticsSettingsPanel } from "~/components/settings/ProductAnalyticsSettingsPanel";

export function PrivacySettingsView() {
  return (
    <div className="space-y-6">
      <SafariAccessSetupButton />
      <ProductAnalyticsSettingsPanel />
    </div>
  );
}
