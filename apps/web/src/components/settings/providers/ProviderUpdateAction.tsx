// FILE: ProviderUpdateAction.tsx
// Purpose: The Update button for one agent CLI, with its in-progress spinner.
// Layer: Settings UI
// Exports: ProviderUpdateAction

import type { ProviderInstanceId, ProviderKind, ServerProviderStatus } from "@synara/contracts";
import type { MouseEvent } from "react";

import { useTranslation } from "~/i18n";
import { providerStatusInstanceKey } from "~/lib/providerAvailability";
import { DownloadIcon, Loader2Icon } from "~/lib/icons";
import { isProviderKind } from "~/providerOrdering";

import { Button } from "../../ui/button";

export function ProviderUpdateAction(props: {
  providerStatus: ServerProviderStatus;
  active: boolean;
  disabled: boolean;
  onUpdate: (provider: ProviderKind, instanceId?: ProviderInstanceId) => void;
}) {
  const { t } = useTranslation();

  const advisory = props.providerStatus.versionAdvisory;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={props.disabled}
      title={
        advisory?.updateCommand ? t("workspace:run", { value0: advisory.updateCommand }) : undefined
      }
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const driver = props.providerStatus.driver ?? props.providerStatus.provider;
        if (!isProviderKind(driver)) return;
        props.onUpdate(driver, providerStatusInstanceKey(props.providerStatus));
      }}
    >
      {props.active ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <DownloadIcon className="size-3.5" />
      )}
      {props.active ? t("settings:providers_updating") : t("computer:providerUpdates_update")}
    </Button>
  );
}
