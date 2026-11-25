// FILE: EnvironmentToggle.tsx
// Purpose: The single chat-header "Environment" button that replaces the former
//          Open-in-editor + git-actions + diff-toggle cluster. It toggles the Environment
//          panel overlay, which is always pinned to the top-right of the chat column
//          (with matching p-3 gutters). When the right dock is closed the overlay also
//          reserves transcript/composer inset; when the dock is open it overlays only.
// Layer: Chat header control

import { PanelTopOpenIcon } from "~/lib/icons";
import { SurfacePanelToggle, type SurfacePanelToggleState } from "../chatHeaderControls";
import { useTranslation } from "~/i18n";

export type EnvironmentToggleState = SurfacePanelToggleState;

export function EnvironmentToggle({ environment }: { environment: EnvironmentToggleState }) {
  const { t } = useTranslation();
  return (
    <SurfacePanelToggle
      state={environment}
      icon={PanelTopOpenIcon}
      ariaLabel={t("chat:environment_togglePanel")}
      tooltip={t("chat:general_environmentPanel")}
    />
  );
}
