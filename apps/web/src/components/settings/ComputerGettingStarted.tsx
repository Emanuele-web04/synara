import { Schema } from "effect";
import { useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Button } from "~/components/ui/button";
import { SettingsCard, SettingsRow, SettingsSectionShell } from "./SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

const STORAGE_KEY = "synara:computer-getting-started:v1";

/** Introduce Computer where it is enabled, without opening another startup dialog. */
export function ComputerGettingStarted({
  appSnapAvailable,
}: {
  readonly appSnapAvailable: boolean;
}) {
  const { t } = useTranslation();

  const [acknowledged, setAcknowledged] = useLocalStorage(STORAGE_KEY, false, Schema.Boolean);
  const [requestedOpen, setRequestedOpen] = useState(false);
  const open = !acknowledged || requestedOpen;
  const dismiss = () => {
    setRequestedOpen(false);
    if (!acknowledged) setAcknowledged(true);
  };

  return (
    <SettingsSectionShell
      title="settings:gettingStarted"
      action={
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          onClick={() => (open ? dismiss() : setRequestedOpen(true))}
        >
          <DisclosureChevron open={open} />
          {open ? t("settings:hideGuide") : t("settings:showGuide")}
        </Button>
      }
    >
      <DisclosureRegion open={open}>
        <SettingsCard>
          <SettingsRow
            id="setting-ask-for-a-task"
            title="settings:askForATask"
            description="settings:typeComputerUseFollowedByYourTaskForExample"
          />
          <SettingsRow
            id="setting-approve-the-task"
            title="settings:approveTheTask"
            description="settings:ifAskedApproveComputerForTheTaskUseThe"
          />
          <SettingsRow
            id="setting-follow-and-stop"
            title="settings:followAndStop"
            description="settings:watchThePreviewWhileTheAgentWorksUseStop"
          />
        </SettingsCard>
        {appSnapAvailable ? (
          <p className="mt-3 px-2 text-ui-sm text-muted-foreground">
            {t("settings:appSnapIsSeparateItAttachesAWindowImageWithout")}
          </p>
        ) : null}
        {!acknowledged ? (
          <Button className="mt-3" size="sm" variant="outline" onClick={dismiss}>
            {t("common:whatsNew_gotIt")}
          </Button>
        ) : null}
      </DisclosureRegion>
    </SettingsSectionShell>
  );
}
