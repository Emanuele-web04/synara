// FILE: ConnectionsAddComputerDialog.tsx
// Purpose: "Add" on Control other devices — redeem another computer's pairing
//          code, compare its identity, and request access from it.
// Layer: Settings UI components
// Exports: ConnectionsAddComputerDialog

import { useEffect, useId, useRef, useState } from "react";

import {
  DEVICE_USER_CODE_GROUP_SIZE,
  DEVICE_USER_CODE_LENGTH,
  formatUnambiguousCode,
} from "~/lib/hosts/enrollment";
import {
  callRemoteAccess,
  remoteAccessErrorMessage,
  type RemotePairingPreview,
} from "~/lib/hosts/remoteAccess";
import type { RemoteAccessRequest } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { ShortCodeField } from "../hosts/ShortCodeField";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RootFingerprint } from "./ConnectionsRows";

export function ConnectionsAddComputerDialog({
  open,
  onOpenChange,
  onPaired,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaired: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AddComputerDialogContent onClose={() => onOpenChange(false)} onPaired={onPaired} />
      ) : null}
    </Dialog>
  );
}

function AddComputerDialogContent({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  onPaired: () => void;
}) {
  const confirmationId = useId();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<RemotePairingPreview | null>(null);
  const [compared, setCompared] = useState(false);
  const [deviceJkt, setDeviceJkt] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [paired, setPaired] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void callRemoteAccess({ operation: "device-info" }).then(
      (info) => {
        if (mounted.current && info.kind === "device-info") setDeviceJkt(info.deviceJkt);
      },
      () => {},
    );
    return () => {
      mounted.current = false;
    };
  }, []);

  const perform = async (request: RemoteAccessRequest) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await callRemoteAccess(request);
      if (!mounted.current) return;
      if (result.kind === "pairing-preview") {
        setPreview(result);
        setCompared(false);
      }
      if (request.operation === "forget-host") {
        setPreview(null);
        setCompared(false);
        setNotice("Saved pairing removed. Create a new code on the other computer to pair again.");
      }
      if (result.kind === "paired") {
        setPaired(preview?.label ?? "The computer");
        onPaired();
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          remoteAccessErrorMessage(
            cause,
            "The request did not complete. Check the other computer before retrying.",
          ),
        );
    } finally {
      if (mounted.current) {
        setBusy(false);
        setWaiting(false);
      }
    }
  };

  const cancelRequest = () => {
    if (!preview) return;
    void callRemoteAccess({ operation: "forget-host", environmentId: preview.environmentId }).then(
      () => {
        if (!mounted.current) return;
        setPreview(null);
        setCompared(false);
        setError(null);
        setNotice("Request cancelled here. Reject it on the other computer too.");
      },
      () => setError("Could not cancel. Reject the request on the other computer."),
    );
  };

  const forgetPrevious = async () => {
    if (!preview) return;
    if (
      await ensureNativeApi().dialogs.confirm(
        `Forget the saved identity for ${preview.label}? Active connections will close.`,
      )
    )
      await perform({ operation: "forget-host", environmentId: preview.environmentId });
  };

  const complete = code.length === DEVICE_USER_CODE_LENGTH;
  const find = () => {
    if (!complete || !deviceJkt) return;
    void perform({
      operation: "redeem-code",
      code: formatUnambiguousCode(code, DEVICE_USER_CODE_GROUP_SIZE),
    });
  };

  return (
    <DialogPopup className="max-w-md">
      <DialogHeader>
        <DialogTitle>Add a computer</DialogTitle>
        <DialogDescription>
          On the other computer, open Settings → Connections and click Add. Enter the code it shows.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {paired ? (
          <p role="status" className="py-4 text-center text-ui text-foreground">
            {paired} approved this computer. You can connect to it now.
          </p>
        ) : !preview ? (
          <ShortCodeField
            label="Pairing code"
            value={code}
            codeLength={DEVICE_USER_CODE_LENGTH}
            groupSize={DEVICE_USER_CODE_GROUP_SIZE}
            placeholder="ABCD-2345"
            disabled={busy}
            onValueChange={setCode}
            onSubmit={find}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-ui font-medium">{preview.label}</p>
            <p className="text-ui-sm text-muted-foreground">
              Check that the other computer shows this identity. Finding it by code alone does not
              verify it.
            </p>
            <RootFingerprint
              value={preview.rootFingerprint}
              className="rounded-xl border border-[color:var(--color-border)] px-3 py-2"
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id={confirmationId}
                checked={compared}
                onCheckedChange={setCompared}
                disabled={busy || waiting}
              />
              <label htmlFor={confirmationId} className="text-ui-sm">
                The identity matches on both computers
              </label>
            </div>
            {deviceJkt ? (
              <p className="text-ui-sm text-muted-foreground">
                If asked to approve, this computer appears as{" "}
                <code className="break-all font-mono text-ui-xs text-foreground">{deviceJkt}</code>
              </p>
            ) : null}
          </div>
        )}
        {error ? (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-ui text-foreground">
            {notice}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {paired ? (
          <Button shape="capsule" onClick={onClose}>
            Done
          </Button>
        ) : preview ? (
          <>
            {waiting ? (
              <Button shape="capsule" variant="subtle" onClick={cancelRequest}>
                Cancel request
              </Button>
            ) : (
              <Button
                shape="capsule"
                variant="subtle"
                disabled={busy}
                onClick={() => void forgetPrevious()}
              >
                Forget previous pairing
              </Button>
            )}
            <Button
              shape="capsule"
              disabled={busy || !compared || Date.parse(preview.expiresAt) <= Date.now()}
              onClick={() => {
                setWaiting(true);
                void perform({
                  operation: "confirm-code",
                  inviteId: preview.inviteId,
                  rootFingerprint: preview.rootFingerprint,
                });
              }}
            >
              {waiting ? "Waiting for approval…" : "Request access"}
            </Button>
          </>
        ) : (
          <>
            <Button shape="capsule" variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button shape="capsule" disabled={busy || !complete || !deviceJkt} onClick={find}>
              Find computer
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}
