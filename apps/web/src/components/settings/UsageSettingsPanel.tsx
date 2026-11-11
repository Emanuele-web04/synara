// FILE: UsageSettingsPanel.tsx
// Purpose: The Usage pane — an Overview tab with provider limits and display options,
//          and a Billing tab with the Synara Alto plan when billing is enabled.
// Layer: Settings UI components
// Exports: UsageSettingsPanel

import { useState } from "react";

import { SegmentedPicker } from "../SegmentedPicker";
import { BillingSettingsPanel, SYNARA_PLAN_SECTION_ID } from "./BillingSettingsPanel";
import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";

type UsageTab = "overview" | "billing";

/**
 * Deep links to the plan (`target=settings-synara-plan`) open on Billing. The route
 * keys this panel by its target, so a new link resets the tab.
 */
export function UsageSettingsPanel({
  billingEnabled,
  target,
}: {
  billingEnabled: boolean;
  target: string | null;
}) {
  const [tab, setTab] = useState<UsageTab>(() =>
    target === SYNARA_PLAN_SECTION_ID ? "billing" : "overview",
  );
  if (!billingEnabled) return <ProviderUsageSettingsPanel />;
  return (
    <div className="space-y-6">
      <SegmentedPicker<UsageTab>
        ariaLabel="Usage"
        variant="buttons"
        value={tab}
        onValueChange={setTab}
        options={[
          { value: "overview", label: "Overview" },
          { value: "billing", label: "Billing" },
        ]}
      />
      <div>{tab === "billing" ? <BillingSettingsPanel /> : <ProviderUsageSettingsPanel />}</div>
    </div>
  );
}
