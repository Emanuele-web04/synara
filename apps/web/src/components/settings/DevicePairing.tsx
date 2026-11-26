// FILE: DevicePairing.tsx
// Purpose: The pairing flow behind "Connect a device": one single-use code per opening,
//          its countdown and replacement, and the requests that still need a manual
//          approval. Shared by the Connections dialog and the first-run onboarding so
//          both surfaces run the same state machine.
// Layer: Settings UI hooks and components
// Exports: useDevicePairing, PendingDeviceApprovalCard, PairingCode

import { useEffect, useRef, useState } from "react";

import { useAccount } from "~/hooks/useAccount";
import {
  activeTrustedDevices,
  callRemoteAccess,
  countdownLabel,
  pendingApprovals,
  remoteAccessErrorMessage,
  type RemoteHostState,
  type RemotePairingCode,
} from "~/lib/hosts/remoteAccess";
import { remotePairingLink } from "~/lib/remotePairingLink";
import { Button } from "../ui/button";
import { RemoteDeviceIcon } from "./ConnectionsRows";

export type PendingDeviceApproval = ReturnType<typeof pendingApprovals>[number];

/** Requests first (a new code would withdraw them), then a fresh join, then the code. */
export type DevicePairingView = "approval" | "joined" | "code" | "empty";

export const DEVICE_PAIRING_CARD_CLASS_NAME = "rounded-[20px] border border-border bg-muted/40";

export function useDevicePairing({
  createCode,
  state,
  loadError,
  onChanged,
}: {
  /** False when opened only to review pending requests. */
  createCode: boolean;
  state: RemoteHostState | null;
  loadError: string | null;
  onChanged: () => Promise<void>;
}) {
  const account = useAccount();
  const [invitation, setInvitation] = useState<RemotePairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeRequested, setCodeRequested] = useState(false);
  const [now, setNow] = useState(Date.now());
  const openedAt = useRef(Date.now());
  const mounted = useRef(true);
  const initialCodeRequested = useRef(false);

  const run = async (work: () => Promise<void>, failure: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (cause) {
      if (mounted.current) setError(remoteAccessErrorMessage(cause, failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const pending = pendingApprovals(state, now);
  const joined = activeTrustedDevices(state).filter(
    (device) => Date.parse(device.approvedAt) >= openedAt.current,
  );
  // A code someone already redeemed, or one withdrawn elsewhere, is spent.
  const shownStatus = invitation
    ? state?.invitations.find((entry) => entry.inviteId === invitation.inviteId)
    : undefined;
  const used = Boolean(
    shownStatus && (shownStatus.revoked || shownStatus.approved || shownStatus.pendingDevice),
  );
  const remaining = invitation && !used ? countdownLabel(invitation.expiresAt, now) : null;

  // A live code being replaced is withdrawn first so only the one on screen
  // stays redeemable; it leaves the screen before the new one is requested, so
  // a failure cannot keep showing a dead code.
  const newCode = () => {
    if (state === null) return onChanged();
    return run(async () => {
      if (invitation && remaining) {
        await callRemoteAccess({ operation: "cancel-invitation", inviteId: invitation.inviteId });
      }
      if (mounted.current) setInvitation(null);
      const result = await callRemoteAccess({ operation: "create-code" });
      if (mounted.current && result.kind === "pairing-code") setInvitation(result);
    }, "Could not create a pairing code.");
  };

  const approve = (entry: PendingDeviceApproval) =>
    run(async () => {
      await callRemoteAccess({
        operation: "approve",
        inviteId: entry.inviteId,
        deviceJkt: entry.pendingDevice.deviceJkt,
      });
    }, "Could not approve the device.");

  const reject = (entry: PendingDeviceApproval) =>
    run(async () => {
      await callRemoteAccess({ operation: "cancel-invitation", inviteId: entry.inviteId });
    }, "Could not reject the request.");

  useEffect(() => {
    mounted.current = true;
    const countdown = setInterval(() => setNow(Date.now()), 1_000);
    // Leaving keeps the code: people close this to type it on the phone. It
    // expires on its own and can be cancelled from Connections.
    return () => {
      mounted.current = false;
      clearInterval(countdown);
    };
  }, []);

  // Creating a code withdraws pending requests. Wait for the first host state
  // and let the owner review any waiting requests before creating a code.
  const hostStateLoaded = state !== null;
  const noPending = pending.length === 0;
  useEffect(() => {
    if (!createCode || !hostStateLoaded || !noPending || busy || initialCodeRequested.current)
      return;
    initialCodeRequested.current = true;
    setCodeRequested(true);
    void newCode();
    // `newCode` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createCode, hostStateLoaded, noPending, busy]);

  const qrLink =
    invitation && remaining
      ? remotePairingLink(
          account.status?.state === "signed-in" ? account.status.accountAuthority : undefined,
          invitation,
        )
      : null;

  const view: DevicePairingView = !noPending
    ? "approval"
    : joined.length > 0
      ? "joined"
      : createCode
        ? "code"
        : "empty";

  return {
    view,
    pending,
    joined,
    invitation,
    remaining,
    used,
    qrLink,
    email: account.me?.email ?? null,
    busy,
    error: error ?? (state === null ? loadError : null),
    codeRequested,
    newCode,
    approve,
    reject,
  };
}

export function PendingDeviceApprovalCard({
  entry,
  computerNoun,
  busy,
  onApprove,
  onReject,
}: {
  entry: PendingDeviceApproval;
  computerNoun: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className={`${DEVICE_PAIRING_CARD_CLASS_NAME} space-y-3.5 p-4`}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
          <RemoteDeviceIcon label={entry.pendingDevice.label} />
        </span>
        <div className="min-w-0">
          <p
            className="truncate text-ui font-medium text-foreground"
            title={entry.pendingDevice.label}
          >
            {entry.pendingDevice.label}
          </p>
          <p className="text-ui-sm text-muted-foreground">Wants to control this {computerNoun}</p>
        </div>
      </div>
      <div className="space-y-1.5 border-t border-border pt-3">
        <p className="text-ui-xs text-muted-foreground">The device should show this fingerprint</p>
        <code className="block font-mono text-ui-xs break-all text-foreground">
          {entry.pendingDevice.deviceJkt}
        </code>
      </div>
      <div className="flex gap-2">
        <Button
          shape="capsule"
          variant="subtle"
          className="flex-1"
          disabled={busy}
          onClick={onReject}
        >
          Reject
        </Button>
        <Button shape="capsule" className="flex-1" disabled={busy} onClick={onApprove}>
          Approve
        </Button>
      </div>
    </div>
  );
}

export function PairingCode({ code }: { code: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5">
      <span className="text-ui-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
        Pairing code
      </span>
      <span className="font-mono text-4xl font-medium tracking-[0.12em] text-foreground">
        {code}
      </span>
    </div>
  );
}
