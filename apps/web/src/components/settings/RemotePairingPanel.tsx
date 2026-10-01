import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RemoteAccessRequest, RemoteAccessResult } from "@synara/contracts";
import { readHostsApi } from "~/lib/hosts/api";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { ensureNativeApi } from "~/nativeApi";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { SettingsSection, SettingsListRow } from "./SettingsPanelPrimitives";

type HostState = Extract<RemoteAccessResult, { kind: "host-state" }>;
type PairingCode = Extract<RemoteAccessResult, { kind: "pairing-code" }>;
type Preview = Extract<RemoteAccessResult, { kind: "pairing-preview" }>;
const call = (request: RemoteAccessRequest) => {
  const access = readHostsApi()?.remoteAccess;
  return access
    ? access(request)
    : Promise.reject(new Error("Update the local controller to manage device pairing."));
};
const fingerprint = (value: string) => value.match(/.{1,8}/g)?.join(" ") ?? value;

export function RemotePairingPanel() {
  if (readExecutionContext()?.controller.capabilities.remoteConnections !== true) return null;
  return <EnabledRemotePairingPanel />;
}

function EnabledRemotePairingPanel() {
  const inputId = useId();
  const confirmationId = useId();
  const [state, setState] = useState<HostState | null>(null);
  const [invitation, setInvitation] = useState<PairingCode | null>(null);
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [compared, setCompared] = useState(false);
  const [deviceJkt, setDeviceJkt] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await call({ operation: "list" });
      if (mounted.current && sequence === refreshSequence.current && next.kind === "host-state")
        setState(next);
    } catch (cause) {
      if (mounted.current && sequence === refreshSequence.current)
        setError(cause instanceof Error ? cause.message : "Remote access unavailable.");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void call({ operation: "device-info" }).then(
      (info) => {
        if (mounted.current && info.kind === "device-info") setDeviceJkt(info.deviceJkt);
      },
      () => {},
    );
    const timer = setInterval(() => {
      void refresh();
    }, 3_000);
    const countdown = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      mounted.current = false;
      // Monotonic request generation, not a DOM element ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      refreshSequence.current++;
      clearInterval(timer);
      clearInterval(countdown);
    };
  }, [refresh]);
  const perform = async (request: RemoteAccessRequest) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    refreshSequence.current++;
    try {
      const result = await call(request);
      if (!mounted.current) return;
      if (result.kind === "pairing-code") setInvitation(result);
      if (result.kind === "pairing-preview") {
        setPreview(result);
        setCompared(false);
      }
      if (request.operation === "forget-host") {
        setCode("");
        setPreview(null);
        setCompared(false);
        setNotice("Saved pairing removed. Create a new code on the other computer to pair again.");
      }
      if (result.kind === "paired") {
        setCode("");
        setPreview(null);
        setNotice("Device approved. You can now connect to this computer.");
      }
      await refresh();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The request did not complete. Check the host before retrying.",
        );
    } finally {
      if (mounted.current) {
        setBusy(false);
        setWaiting(false);
      }
    }
  };
  const reset = async () => {
    const local = readExecutionContext()?.controller;
    if (
      !local ||
      !(await ensureNativeApi().dialogs.confirm(
        "Reset remote access on this computer? All device approvals and invitations will be revoked. Pair each device again. Your projects and chats stay here.",
      ))
    )
      return;
    await perform({ operation: "reset-identity", environmentId: local.environmentId });
  };
  const remaining = invitation
    ? Math.max(0, Math.ceil((Date.parse(invitation.expiresAt) - now) / 1_000))
    : 0;
  return (
    <>
      <SettingsSection title="Connect a device to this computer">
        <SettingsListRow
          title="Local approval required"
          description="Sign in to the same Synara account on both computers. Create a code here, then approve the requesting device."
          actions={
            <Button
              size="xs"
              disabled={busy}
              onClick={() => void perform({ operation: "create-code" })}
            >
              Create pairing code
            </Button>
          }
        />
        {invitation ? (
          <div className="space-y-2 p-3">
            <p className="text-ui-lg font-medium tracking-widest" aria-label="Pairing code">
              {remaining ? invitation.code : "Code expired"}
            </p>
            <p className="text-ui-sm text-muted-foreground">
              {remaining
                ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
                : "Create a new code to try again."}
            </p>
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={!remaining}
                onClick={() =>
                  void copyTextToClipboard(invitation.code).catch(() =>
                    setError("Could not copy the code."),
                  )
                }
              >
                Copy code
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void perform({ operation: "cancel-invitation", inviteId: invitation.inviteId });
                  setInvitation(null);
                }}
              >
                Cancel code
              </Button>
            </div>
          </div>
        ) : null}
        {state?.rootFingerprint ? (
          <div className="space-y-1 p-3">
            <p className="text-ui-sm text-muted-foreground">
              This computer’s identity — compare all groups on the other computer before requesting
              access.
            </p>
            <code className="block break-all text-ui-xs">{fingerprint(state.rootFingerprint)}</code>
          </div>
        ) : null}
        {state?.invitations
          .filter(
            (entry) =>
              !entry.revoked &&
              !entry.approved &&
              Date.parse(entry.expiresAt) > now &&
              entry.pendingDevice,
          )
          .map((entry) => (
            <SettingsListRow
              key={entry.inviteId}
              align="start"
              title={entry.pendingDevice!.label}
              description={
                <span className="flex flex-col gap-1">
                  <span>
                    Compare this device fingerprint with the requesting computer. Approve only if it
                    matches.
                  </span>
                  <code className="break-all text-ui-xs text-foreground">
                    {entry.pendingDevice!.deviceJkt}
                  </code>
                </span>
              }
              actions={
                <>
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      void perform({
                        operation: "approve",
                        inviteId: entry.inviteId,
                        deviceJkt: entry.pendingDevice!.deviceJkt,
                      })
                    }
                  >
                    Approve this device
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void perform({ operation: "cancel-invitation", inviteId: entry.inviteId })
                    }
                  >
                    Reject
                  </Button>
                </>
              }
            />
          ))}
        {state?.devices
          .filter((device) => !device.revokedAt)
          .map((device) => (
            <SettingsListRow
              key={device.deviceJkt}
              title={device.label}
              description={<code className="break-all text-ui-xs">{device.deviceJkt}</code>}
              actions={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={busy}
                  onClick={() =>
                    void perform({ operation: "revoke-device", deviceJkt: device.deviceJkt })
                  }
                >
                  Revoke on this host
                </Button>
              }
            />
          ))}
        {state?.rootNeedsRepair ? (
          <SettingsListRow
            title="Remote identity needs attention"
            description="If you previously paired devices, reset access and pair them again."
            actions={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void reset()}
              >
                Reset access
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title="Add a computer">
        <div className="space-y-3 p-3">
          <label htmlFor={inputId} className="block text-ui-sm font-medium">
            Pairing code from the other computer
          </label>
          <Input
            id={inputId}
            value={code}
            disabled={busy}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase());
              setPreview(null);
              setCompared(false);
            }}
            maxLength={9}
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCD-2345"
          />
          <Button
            size="sm"
            disabled={busy || code.replace(/[^A-Z2-9]/g, "").length !== 8 || !deviceJkt}
            onClick={() => void perform({ operation: "redeem-code", code })}
          >
            Find computer
          </Button>
          {preview ? (
            <div className="space-y-2">
              <p className="text-ui font-medium">{preview.label}</p>
              <p className="text-ui-sm text-muted-foreground">
                On that computer, compare its identity below. A successful code lookup alone does
                not verify its identity.
              </p>
              <code className="block break-all text-ui-xs">
                {fingerprint(preview.rootFingerprint)}
              </code>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={confirmationId}
                  checked={compared}
                  onCheckedChange={setCompared}
                  disabled={busy}
                />
                <label htmlFor={confirmationId} className="text-ui-sm">
                  All identity groups match on both computers
                </label>
              </div>
              <p className="text-ui-sm text-muted-foreground">
                This device’s fingerprint — compare it on the host before approval:
              </p>
              <code className="block break-all text-ui-xs">{deviceJkt}</code>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy || !compared || Date.parse(preview.expiresAt) <= now}
                  onClick={() => {
                    setWaiting(true);
                    void perform({
                      operation: "confirm-code",
                      inviteId: preview.inviteId,
                      rootFingerprint: preview.rootFingerprint,
                    });
                  }}
                >
                  {waiting ? "Waiting for host approval…" : "Request access"}
                </Button>
                {waiting ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void call({
                        operation: "forget-host",
                        environmentId: preview.environmentId,
                      }).then(
                        () => {
                          if (!mounted.current) return;
                          setCode("");
                          setPreview(null);
                          setCompared(false);
                          setError(null);
                          setNotice(
                            "Pairing cancelled on this computer. Reject the pending request on the host.",
                          );
                        },
                        () => setError("Could not cancel. Reject the invitation on the host."),
                      )
                    }
                  >
                    Cancel request
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      if (
                        await ensureNativeApi().dialogs.confirm(
                          `Forget the saved identity for ${preview.label}? Active connections will close.`,
                        )
                      )
                        await perform({
                          operation: "forget-host",
                          environmentId: preview.environmentId,
                        });
                    }}
                  >
                    Forget previous pairing
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>
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
    </>
  );
}
