// FILE: ConnectionsSettingsPanel.tsx
// Purpose: The Connections pane — three tabs: devices that control this computer,
//          computers this one controls, and SSH.
// Layer: Settings UI components
// Exports: ConnectionsSettingsPanel

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import { Translation } from "~/i18n/Translation";

import { useAccount } from "~/hooks/useAccount";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { isMacNavigatorPlatform } from "~/lib/utils";
import { useAccountDialogStore } from "../account/accountDialogStore";
import { SegmentedPicker } from "../SegmentedPicker";
import { Button } from "../ui/button";
import { ConnectionsOtherComputers } from "./ConnectionsOtherComputers";
import { ConnectionsThisComputer } from "./ConnectionsThisComputer";
import { SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

type ConnectionsTab = "this" | "others" | "ssh";

export function ConnectionsSettingsPanel({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ConnectionsTab>("this");
  const account = useAccount();
  const openSignIn = useAccountDialogStore((store) => store.openSignIn);
  if (!active) return null;

  const capability = readExecutionContext()?.controller.capabilities;
  if (capability?.remoteConnections !== true)
    return (
      <SettingsSection title={t("settings:remote_connections_title")}>
        <SettingsListRow
          title={t("settings:remote_connections_unavailable_build")}
          description={
            capability?.remoteUnavailableReason ??
            t("settings:remote_connections_update_controller")
          }
        />
      </SettingsSection>
    );

  const signedIn = account.me !== null;
  if (!signedIn)
    return (
      <SettingsSection title={t("settings:remote_connections_title")}>
        <SettingsListRow
          title={t("settings:remote_connections_sign_in_devices")}
          description={t("settings:remote_connections_same_account_computer")}
          actions={
            <Button size="xs" shape="capsule" onClick={openSignIn}>
              {t("chat:providerModelPicker_signIn")}
            </Button>
          }
        />
      </SettingsSection>
    );

  const computerNoun = isMacNavigatorPlatform()
    ? "Mac"
    : t("settings:remote_connections_computer_noun");
  return (
    <div className="space-y-6">
      <SegmentedPicker<ConnectionsTab>
        ariaLabel={t("settings:remote_connections_title")}
        variant="buttons"
        value={tab}
        onValueChange={setTab}
        options={[
          {
            value: "this",
            label: t("settings:remote_connections_control_this", { computer: computerNoun }),
          },
          { value: "others", label: t("settings:remote_connections_control_other_devices") },
          { value: "ssh", label: t("settings:remote_connections_ssh") },
        ]}
      />
      <div>
        {tab === "this" ? (
          <ConnectionsThisComputer computerNoun={computerNoun} />
        ) : tab === "others" ? (
          <ConnectionsOtherComputers />
        ) : (
          <ConnectionsSsh />
        )}
      </div>
    </div>
  );
}

/** Only what exists today: device-code linking and a manual SSH forwarding port. */
function ConnectionsSsh() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <SettingsSection title={t("settings:remote_connections_ssh")}>
      <SettingsListRow
        title={t("settings:remote_connections_headless_machine")}
        description={t("settings:remote_connections_headless_description")}
        actions={
          <Button
            size="xs"
            shape="capsule"
            variant="subtle"
            onClick={() => void navigate({ to: "/link" })}
          >
            {t("settings:remote_connections_enter_code")}
          </Button>
        }
      />
      <SettingsListRow
        title={t("settings:remote_connections_port_forwarding")}
        description={
          <Translation
            message="settings:remote_connections_port_forwarding_description"
            components={{ command: <code className="font-mono text-ui-sm text-foreground" /> }}
          />
        }
      />
    </SettingsSection>
  );
}
