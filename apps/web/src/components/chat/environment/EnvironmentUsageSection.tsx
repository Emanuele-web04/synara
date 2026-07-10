// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — same menu as the header chip.

import type { ProviderKind } from "@synara/contracts";

import {
  ProviderUsageMenuPopup,
  useProviderUsageMenuModel,
} from "~/components/ProviderUsageMenuControl";
import { ProviderIcon } from "~/components/ProviderIcon";
import { MenuTrigger } from "~/components/ui/menu";

import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

export function EnvironmentUsageSection({ provider }: { provider: ProviderKind }) {
  const model = useProviderUsageMenuModel(provider);

  if (!model) {
    return null;
  }

  return (
    <EnvironmentLabeledSection label="Usage">
      <ProviderUsageMenuPopup provider={provider} model={model} align="start">
        <MenuTrigger
          render={
            <button
              type="button"
              className={ENVIRONMENT_ROW_CLASS_NAME}
              aria-label={model.menuTitle}
            />
          }
        >
          <EnvironmentRowBody
            icon={
              <ProviderIcon
                provider={provider}
                tone="header"
                className={ENVIRONMENT_ROW_ICON_CLASS_NAME}
              />
            }
            label={model.primaryRow.remainingLabel}
            trailing={<EnvironmentRowChevron />}
          />
        </MenuTrigger>
      </ProviderUsageMenuPopup>
    </EnvironmentLabeledSection>
  );
}
