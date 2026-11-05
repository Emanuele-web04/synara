// FILE: ConnectionsAddComputerDialog.tsx
// Purpose: "Add" on Control other devices — redeem another computer's pairing
//          code, compare its identity, and request access from it.
// Layer: Settings UI components
// Exports: ConnectionsAddComputerDialog

import { useEffect, useId, useRef, useState } from "react";

import { useTranslation } from "~/i18n";
import { Translation } from "~/i18n/Translation";

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
  const { t } = useTranslation();
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
        setNotice(t("settings:remote_connections_saved_pairing_removed"));
      }
      if (result.kind === "paired") {
        setPaired(preview?.label ?? t("settings:remote_connections_computer_fallback"));
        onPaired();
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          remoteAccessErrorMessage(cause, t("settings:remote_connections_request_incomplete")),
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
        setNotice(t("settings:remote_connections_request_cancelled"));
      },
      () => setError(t("settings:remote_connections_cancel_failed")),
    );
  };

  const forgetPrevious = async () => {
    if (!preview) return;
    if (
      await ensureNativeApi().dialogs.confirm(
        t("settings:remote_connections_forget_identity_confirm", { label: preview.label }),
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
        <DialogTitle>{t("settings:remote_connections_add_computer")}</DialogTitle>
        <DialogDescription>
          {t("settings:remote_connections_add_computer_instructions")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {paired ? (
          <p role="status" className="py-4 text-center text-ui text-foreground">
            {t("settings:remote_connections_computer_approved", { computer: paired })}
          </p>
        ) : !preview ? (
          <ShortCodeField
            label={t("settings:remote_connections_pairing_code")}
            value={code}
            codeLength={DEVICE_USER_CODE_LENGTH}
            groupSize={DEVICE_USER_CODE_GROUP_SIZE}
            placeholder={t("settings:remote_connections_pairing_code_placeholder")}
            disabled={busy}
            onValueChange={setCode}
            onSubmit={find}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-ui font-medium">{preview.label}</p>
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:remote_connections_verify_identity")}
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
                {t("settings:remote_connections_identity_matches")}
              </label>
            </div>
            {deviceJkt ? (
              <p className="text-ui-sm text-muted-foreground">
                <Translation
                  message="settings:remote_connections_approval_identity"
                  values={{ identity: deviceJkt }}
                  components={{
                    identity: <code className="break-all font-mono text-ui-xs text-foreground" />,
                  }}
                />
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
            {t("git:detail_done")}
          </Button>
        ) : preview ? (
          <>
            {waiting ? (
              <Button shape="capsule" variant="subtle" onClick={cancelRequest}>
                {t("settings:remote_connections_cancel_request")}
              </Button>
            ) : (
              <Button
                shape="capsule"
                variant="subtle"
                disabled={busy}
                onClick={() => void forgetPrevious()}
              >
                {t("settings:remote_connections_forget_pairing")}
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
              {waiting
                ? t("settings:remote_connections_waiting_approval")
                : t("settings:remote_connections_request_access")}
            </Button>
          </>
        ) : (
          <>
            <Button shape="capsule" variant="subtle" onClick={onClose}>
              {t("common:form_cancel")}
            </Button>
            <Button shape="capsule" disabled={busy || !complete || !deviceJkt} onClick={find}>
              {t("settings:remote_connections_find_computer")}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}
