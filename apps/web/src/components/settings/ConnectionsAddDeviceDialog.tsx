// FILE: ConnectionsAddDeviceDialog.tsx
// Purpose: "Add" on Control this computer — a single-use pairing code shown as a QR
//          for phones and as a short code for other computers, plus the requests
//          that still need a manual approval.
// Layer: Settings UI components
// Exports: ConnectionsAddDeviceDialog

import { useEffect, useRef, useState } from "react";

import { useTranslation } from "~/i18n";
import { Translation } from "~/i18n/Translation";

import { useAccount } from "~/hooks/useAccount";
import {
  activeTrustedDevices,
  callRemoteAccess,
  countdownLabel,
  pendingApprovals,
  remoteAccessErrorMessage,
  remoteDeviceKind,
  type RemoteHostState,
  type RemotePairingCode,
} from "~/lib/hosts/remoteAccess";
import { ClockIcon, RefreshCwIcon } from "~/lib/icons";
import { remotePairingLink } from "~/lib/remotePairingLink";
import { SegmentedPicker } from "../SegmentedPicker";
import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { type AddDeviceHeroVariant, ConnectionsAddDeviceHero } from "./ConnectionsAddDeviceHero";
import { RemoteDeviceIcon, RootFingerprint } from "./ConnectionsRows";
import { PairingQrCode } from "./PairingQrCode";

type DeviceTab = "phone" | "computer";

const DEVICE_TABS = [
  { value: "phone", label: "settings:remote_connections_device_phone_tablet" },
  { value: "computer", label: "settings:remote_connections_device_computer" },
] as const;

const CARD_CLASS_NAME = "rounded-[20px] border border-border bg-muted/40";
const HELP_TEXT_CLASS_NAME = "text-center text-ui-sm leading-relaxed text-muted-foreground";

export function ConnectionsAddDeviceDialog({
  open,
  onOpenChange,
  createCode,
  state,
  onChanged,
  computerNoun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False when opened only to review pending requests. */
  createCode: boolean;
  state: RemoteHostState | null;
  onChanged: () => Promise<void>;
  computerNoun: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AddDeviceDialogContent
          createCode={createCode}
          state={state}
          onChanged={onChanged}
          onClose={() => onOpenChange(false)}
          computerNoun={computerNoun}
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
  computerNoun,
}: {
  createCode: boolean;
  state: RemoteHostState | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
  computerNoun: string;
}) {
  const { t } = useTranslation();
  const account = useAccount();
  const [invitation, setInvitation] = useState<RemotePairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DeviceTab>("phone");
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
  const newCode = () =>
    run(async () => {
      if (invitation && remaining) {
        await callRemoteAccess({ operation: "cancel-invitation", inviteId: invitation.inviteId });
      }
      if (mounted.current) setInvitation(null);
      const result = await callRemoteAccess({ operation: "create-code" });
      if (mounted.current && result.kind === "pairing-code") setInvitation(result);
    }, t("settings:remote_connections_create_code_failed"));

  useEffect(() => {
    mounted.current = true;
    const countdown = setInterval(() => setNow(Date.now()), 1_000);
    // Closing keeps the code: people close this to type it on the phone. It
    // expires on its own and can be cancelled from Connections.
    return () => {
      mounted.current = false;
      clearInterval(countdown);
    };
  }, []);

  // Creating a code withdraws every request still waiting on this computer, so
  // mint one per opening only once those have been approved or rejected.
  const noPending = pending.length === 0;
  useEffect(() => {
    if (!createCode || !noPending || busy || initialCodeRequested.current) return;
    initialCodeRequested.current = true;
    setCodeRequested(true);
    void newCode();
    // `newCode` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createCode, noPending, busy]);

  const qrLink =
    invitation && remaining
      ? remotePairingLink(
          account.status?.state === "signed-in" ? account.status.accountAuthority : undefined,
          invitation,
        )
      : null;
  const email = account.me?.email ?? null;
  const firstPending = pending[0];

  // Requests come first: they are waiting on this computer, and a new code
  // would withdraw them.
  const view = !noPending
    ? "approval"
    : joined.length > 0
      ? "joined"
      : createCode
        ? "code"
        : "empty";
  const hero: AddDeviceHeroVariant =
    view === "joined"
      ? "linked"
      : view === "approval" && firstPending
        ? remoteDeviceKind(firstPending.pendingDevice.label) === "computer"
          ? "computer"
          : "phone"
        : view === "code" && tab === "computer"
          ? "computer"
          : "phone";
  const joinedNames = joined.map((device) => device.label).join(", ");

  return (
    <DialogPopup className="max-w-[440px] overflow-hidden">
      <ConnectionsAddDeviceHero variant={hero} computerNoun={computerNoun} />
      <DialogHeader className="items-center px-7 pt-5 text-center">
        {view === "approval" ? (
          <>
            <DialogTitle>
              {pending.length === 1
                ? t("settings:remote_connections_approve_device_question")
                : t("settings:remote_connections_approve_devices_question")}
            </DialogTitle>
            <DialogDescription>
              {pending.length === 1
                ? t("settings:remote_connections_approve_device_description")
                : t("settings:remote_connections_approve_devices_description")}
            </DialogDescription>
          </>
        ) : view === "joined" ? (
          <>
            <DialogTitle>
              {joined.length === 1
                ? t("settings:remote_connections_device_joined", { names: joinedNames })
                : t("settings:remote_connections_devices_joined", { names: joinedNames })}
            </DialogTitle>
            <DialogDescription>
              {joined.length === 1
                ? t("settings:remote_connections_device_can_control", { computer: computerNoun })
                : t("settings:remote_connections_devices_can_control", { computer: computerNoun })}
            </DialogDescription>
          </>
        ) : view === "code" ? (
          <>
            <DialogTitle>
              {t("settings:remote_connections_connect_device", { computer: computerNoun })}
            </DialogTitle>
            <DialogDescription>
              {email ? (
                <Translation
                  message="settings:remote_connections_same_account_email"
                  values={{ email }}
                  components={{ email: <span className="font-medium break-all text-foreground" /> }}
                />
              ) : (
                t("settings:remote_connections_same_account_devices")
              )}
            </DialogDescription>
          </>
        ) : (
          <>
            <DialogTitle>{t("settings:remote_connections_no_requests")}</DialogTitle>
            <DialogDescription>
              {t("settings:remote_connections_requests_description")}
            </DialogDescription>
          </>
        )}
      </DialogHeader>
      <DialogPanel className="space-y-4 px-7 pt-4! pb-7">
        {view === "approval"
          ? pending.map((entry) => (
              <div key={entry.inviteId} className={`${CARD_CLASS_NAME} space-y-3.5 p-4`}>
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
                    <p className="text-ui-sm text-muted-foreground">
                      {t("settings:remote_connections_wants_control", { computer: computerNoun })}
                    </p>
                  </div>
                </div>
                <div className="space-y-1.5 border-t border-border pt-3">
                  <p className="text-ui-xs text-muted-foreground">
                    {t("settings:remote_connections_device_fingerprint")}
                  </p>
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
                    onClick={() =>
                      void run(async () => {
                        await callRemoteAccess({
                          operation: "cancel-invitation",
                          inviteId: entry.inviteId,
                        });
                      }, t("settings:remote_connections_reject_request_failed"))
                    }
                  >
                    {t("settings:remote_connections_reject")}
                  </Button>
                  <Button
                    shape="capsule"
                    className="flex-1"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await callRemoteAccess({
                          operation: "approve",
                          inviteId: entry.inviteId,
                          deviceJkt: entry.pendingDevice.deviceJkt,
                        });
                      }, t("settings:remote_connections_approve_device_failed"))
                    }
                  >
                    {t("automation:approval_approve")}
                  </Button>
                </div>
              </div>
            ))
          : null}

        {view === "code" ? (
          <>
            <SegmentedPicker<DeviceTab>
              ariaLabel={t("settings:remote_connections_device_to_connect")}
              value={tab}
              onValueChange={setTab}
              options={DEVICE_TABS.map((option) => ({ ...option, label: t(option.label) }))}
            />
            <div className={`${CARD_CLASS_NAME} px-4 pt-4.5 pb-3`}>
              <div className="relative flex h-56 items-center justify-center">
                {invitation ? (
                  <div
                    className={
                      remaining
                        ? "flex w-full justify-center"
                        : "pointer-events-none flex w-full justify-center opacity-10 blur-[2px]"
                    }
                    aria-hidden={remaining ? undefined : true}
                  >
                    {tab === "phone" && qrLink ? (
                      <PairingQrCode
                        value={qrLink}
                        label={t("settings:remote_connections_scan_connect")}
                      />
                    ) : (
                      <PairingCode code={invitation.code} />
                    )}
                  </div>
                ) : error ? (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p role="alert" className="text-ui text-destructive">
                      {error}
                    </p>
                    <Button
                      shape="capsule"
                      variant="subtle"
                      disabled={busy}
                      onClick={() => void newCode()}
                    >
                      {t("chat:profile_tryAgain")}
                    </Button>
                  </div>
                ) : busy || !codeRequested ? (
                  <p className="flex items-center gap-2 text-ui text-muted-foreground">
                    <Spinner className="size-4" aria-hidden />
                    {t("settings:remote_connections_creating_code")}
                  </p>
                ) : (
                  <Button shape="capsule" variant="subtle" onClick={() => void newCode()}>
                    {t("settings:remote_connections_new_code")}
                  </Button>
                )}
                {invitation && !remaining ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center">
                    <p className="text-ui font-semibold text-foreground">
                      {used
                        ? t("settings:remote_connections_code_used")
                        : t("settings:remote_connections_code_expired")}
                    </p>
                    <p className="mb-2 text-ui-sm text-muted-foreground">
                      {used
                        ? t("settings:remote_connections_new_code_another_device")
                        : t("settings:remote_connections_new_code_retry")}
                    </p>
                    <Button
                      shape="capsule"
                      size="sm"
                      disabled={busy}
                      onClick={() => void newCode()}
                    >
                      {t("settings:remote_connections_new_code")}
                    </Button>
                  </div>
                ) : null}
              </div>
              {invitation && remaining ? (
                <div className="mt-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-ui-sm text-muted-foreground tabular-nums">
                    <ClockIcon className="size-3.5" aria-hidden />
                    {t("settings:remote_connections_expires_in", { remaining })}
                  </span>
                  <span className="flex items-center gap-0.5 text-muted-foreground">
                    <CopyTextButton
                      text={invitation.code}
                      label={t("settings:remote_connections_code")}
                      iconOnly
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t("settings:remote_connections_new_code")}
                      title={t("settings:remote_connections_new_code")}
                      disabled={busy}
                      onClick={() => void newCode()}
                    >
                      <RefreshCwIcon className="size-3" />
                    </Button>
                  </span>
                </div>
              ) : null}
            </div>
            {invitation && remaining && tab === "phone" ? (
              <p className={HELP_TEXT_CLASS_NAME}>
                {qrLink ? (
                  <Translation
                    message="settings:remote_connections_phone_enter_code_scan"
                    values={{ code: invitation.code }}
                    components={{
                      code: <span className="font-mono font-medium text-foreground" />,
                    }}
                  />
                ) : (
                  <Translation
                    message="settings:remote_connections_phone_enter_code"
                    values={{ code: invitation.code }}
                    components={{
                      code: <span className="font-mono font-medium text-foreground" />,
                    }}
                  />
                )}
              </p>
            ) : null}
            {invitation && remaining && tab === "computer" ? (
              <>
                <p className={HELP_TEXT_CLASS_NAME}>
                  <Translation
                    message="settings:remote_connections_computer_enter_code"
                    components={{
                      path: <span className="font-medium text-foreground" />,
                      action: <span className="font-medium text-foreground" />,
                    }}
                  />
                </p>
                <div className="space-y-1.5 rounded-[14px] border border-border py-2.5 ps-3.5 pe-2">
                  <p className="text-ui-xs text-muted-foreground">
                    {t("settings:remote_connections_check_fingerprint", { computer: computerNoun })}
                  </p>
                  <RootFingerprint value={invitation.rootFingerprint} className="text-foreground" />
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {error && !(view === "code" && !invitation) ? (
          <p role="alert" className="text-center text-ui text-destructive">
            {error}
          </p>
        ) : null}

        {view === "joined" || view === "empty" || (view === "approval" && !createCode) ? (
          <Button
            shape="capsule"
            variant={view === "approval" ? "subtle" : "default"}
            className="w-full"
            onClick={onClose}
          >
            {t("git:detail_done")}
          </Button>
        ) : null}
      </DialogPanel>
    </DialogPopup>
  );
}

function PairingCode({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2.5">
      <span className="text-ui-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {t("settings:remote_connections_pairing_code")}
      </span>
      <span className="font-mono text-4xl font-medium tracking-[0.12em] text-foreground">
        {code}
      </span>
    </div>
  );
}
