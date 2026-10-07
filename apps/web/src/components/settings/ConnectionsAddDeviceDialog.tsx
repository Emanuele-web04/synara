// FILE: ConnectionsAddDeviceDialog.tsx
// Purpose: "Add" on Control this computer — a single-use pairing code shown as a QR
//          and a short code, plus the requests that still need a manual approval.
// Layer: Settings UI components
// Exports: ConnectionsAddDeviceDialog

import { QRCodeSVG } from "qrcode.react";
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
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RemoteDeviceIcon, RootFingerprint } from "./ConnectionsRows";

export function ConnectionsAddDeviceDialog({
  open,
  onOpenChange,
  createCode,
  state,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False when opened only to review pending requests. */
  createCode: boolean;
  state: RemoteHostState | null;
  onChanged: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AddDeviceDialogContent
          createCode={createCode}
          state={state}
          onChanged={onChanged}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function AddDeviceDialogContent({
  createCode,
  state,
  onChanged,
  onClose,
}: {
  createCode: boolean;
  state: RemoteHostState | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const account = useAccount();
  const [invitation, setInvitation] = useState<RemotePairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
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

  const newCode = () =>
    run(async () => {
      const result = await callRemoteAccess({ operation: "create-code" });
      if (mounted.current && result.kind === "pairing-code") setInvitation(result);
    }, "Could not create a pairing code.");

  useEffect(() => {
    mounted.current = true;
    if (createCode && !initialCodeRequested.current) {
      initialCodeRequested.current = true;
      void newCode();
    }
    const countdown = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      mounted.current = false;
      clearInterval(countdown);
    };
    // Mint one code per opening; `newCode` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pending = pendingApprovals(state, now);
  const joined = activeTrustedDevices(state).filter(
    (device) => Date.parse(device.approvedAt) >= openedAt.current,
  );
  const remaining = invitation ? countdownLabel(invitation.expiresAt, now) : null;
  const qrLink =
    invitation && remaining
      ? remotePairingLink(
          account.status?.state === "signed-in" ? account.status.accountAuthority : undefined,
          invitation,
        )
      : null;

  const cancel = async () => {
    if (invitation && remaining && joined.length === 0) {
      await callRemoteAccess({ operation: "cancel-invitation", inviteId: invitation.inviteId })
        .then(() => onChanged())
        .catch(() => {});
    }
    onClose();
  };

  return (
    <DialogPopup className="max-w-sm">
      <DialogHeader>
        <DialogTitle>Add a device</DialogTitle>
        <DialogDescription>
          Scan with Synara on your iPhone or iPad. Sign in with the same account and it connects
          automatically.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {pending.length > 0 ? (
          <div className="space-y-2 pt-2">
            <p className="text-ui-sm font-medium text-muted-foreground">Waiting for approval</p>
            {pending.map((entry) => (
              <div
                key={entry.inviteId}
                className="space-y-1.5 rounded-xl border border-[color:var(--color-border)] px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    <RemoteDeviceIcon label={entry.pendingDevice.label} />
                  </span>
                  <p
                    className="min-w-0 flex-1 truncate text-ui font-medium"
                    title={entry.pendingDevice.label}
                  >
                    {entry.pendingDevice.label}
                  </p>
                  <Button
                    size="xs"
                    shape="capsule"
                    variant="subtle"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await callRemoteAccess({
                          operation: "cancel-invitation",
                          inviteId: entry.inviteId,
                        });
                      }, "Could not reject the request.")
                    }
                  >
                    Reject
                  </Button>
                  <Button
                    size="xs"
                    shape="capsule"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await callRemoteAccess({
                          operation: "approve",
                          inviteId: entry.inviteId,
                          deviceJkt: entry.pendingDevice.deviceJkt,
                        });
                      }, "Could not approve the device.")
                    }
                  >
                    Approve
                  </Button>
                </div>
                <p className="text-ui-xs text-muted-foreground">
                  Approve only if the device shows this fingerprint:{" "}
                  <code className="break-all font-mono text-foreground">
                    {entry.pendingDevice.deviceJkt}
                  </code>
                </p>
              </div>
            ))}
          </div>
        ) : null}

        {joined.length > 0 ? (
          <p role="status" className="text-center text-ui text-foreground">
            {joined.map((device) => device.label).join(", ")} can now control this computer.
          </p>
        ) : invitation ? (
          <div className="flex flex-col items-center gap-3 pt-1">
            {qrLink ? (
              <div className="rounded-2xl bg-white p-3">
                <QRCodeSVG
                  value={qrLink}
                  size={208}
                  marginSize={0}
                  title="Scan to connect to this computer"
                />
              </div>
            ) : null}
            <p
              className="font-mono text-2xl font-medium tracking-[0.2em] text-foreground"
              aria-label="Pairing code"
            >
              {remaining ? invitation.code : "Code expired"}
            </p>
            <p className="text-ui-sm text-muted-foreground">
              {remaining ? `Expires in ${remaining}` : "Create a new code to try again."}
            </p>
            {remaining ? (
              <div className="w-full">
                <button
                  type="button"
                  className="mx-auto flex cursor-pointer items-center gap-1.5 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
                  aria-expanded={identityOpen}
                  onClick={() => setIdentityOpen((value) => !value)}
                >
                  <DisclosureChevron open={identityOpen} />
                  Adding a computer instead?
                </button>
                <DisclosureRegion open={identityOpen}>
                  <div className="space-y-2 pt-2 text-center">
                    <p className="text-ui-sm text-muted-foreground">
                      Enter the code on the other computer, then check that it shows this identity.
                    </p>
                    <RootFingerprint
                      value={invitation.rootFingerprint}
                      className="text-foreground"
                    />
                  </div>
                </DisclosureRegion>
              </div>
            ) : null}
          </div>
        ) : !createCode ? (
          pending.length === 0 ? (
            <p className="py-6 text-center text-ui text-muted-foreground">
              No devices are waiting for approval.
            </p>
          ) : null
        ) : !error ? (
          <p className="py-8 text-center text-ui text-muted-foreground">Creating a code…</p>
        ) : null}

        {error ? (
          <p role="alert" className="text-center text-ui text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {joined.length > 0 || !createCode ? (
          <Button shape="capsule" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            {invitation && !remaining ? (
              <Button
                shape="capsule"
                variant="subtle"
                disabled={busy}
                onClick={() => void newCode()}
              >
                New code
              </Button>
            ) : null}
            <Button shape="capsule" variant="subtle" onClick={() => void cancel()}>
              Cancel
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}
