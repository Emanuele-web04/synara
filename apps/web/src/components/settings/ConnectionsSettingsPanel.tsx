// FILE: ConnectionsSettingsPanel.tsx
// Purpose: The Connections pane — three tabs: devices that control this computer,
//          computers this one controls, and SSH.
// Layer: Settings UI components
// Exports: ConnectionsSettingsPanel

import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

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
  const [tab, setTab] = useState<ConnectionsTab>("this");
  const account = useAccount();
  const openSignIn = useAccountDialogStore((store) => store.openSignIn);
  if (!active) return null;

  const capability = readExecutionContext()?.controller.capabilities;
  if (capability?.remoteConnections !== true)
    return (
      <SettingsSection title="Connections">
        <SettingsListRow
          title="Unavailable in this build"
          description={
            capability?.remoteUnavailableReason ??
            "Update the local controller to manage remote access."
          }
        />
      </SettingsSection>
    );

  const signedIn = account.me !== null;
  if (!signedIn)
    return (
      <SettingsSection title="Connections">
        <SettingsListRow
          title="Sign in to connect your devices"
          description="Use the same account on this computer and on the devices that control it."
          actions={
            <Button size="xs" shape="capsule" onClick={openSignIn}>
              Sign in
            </Button>
          }
        />
      </SettingsSection>
    );

  const computerNoun = isMacNavigatorPlatform() ? "Mac" : "computer";
  return (
    <div className="space-y-6">
      <SegmentedPicker<ConnectionsTab>
        ariaLabel="Connections"
        className="px-0"
        value={tab}
        onValueChange={setTab}
        options={[
          { value: "this", label: `Control this ${computerNoun}` },
          { value: "others", label: "Control other devices" },
          { value: "ssh", label: "SSH" },
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
  const navigate = useNavigate();
  return (
    <SettingsSection title="SSH">
      <SettingsListRow
        title="Link a headless machine"
        description="A machine without a browser prints a short code. Enter it here to link it to your account."
        actions={
          <Button
            size="xs"
            shape="capsule"
            variant="subtle"
            onClick={() => void navigate({ to: "/link" })}
          >
            Enter a code
          </Button>
        }
      />
      <SettingsListRow
        title="Port forwarding"
        description={
          <>
            Start Synara on the remote machine with{" "}
            <code className="font-mono text-ui-sm text-foreground">--ssh-forward-port</code>, then
            forward that port over SSH. Synara does not set up SSH keys or routes for you.
          </>
        }
      />
    </SettingsSection>
  );
}
