// FILE: PairStep.tsx
// Purpose: "Connect your iPhone" screen of the onboarding: a live single-use pairing code
//          (QR and short code) from the shared Connections flow, the approvals it may
//          need, and the iPhone's real scanner screen beside it.
// Layer: Web UI component

import { useEffect } from "react";

import {
  PairingCode,
  PendingDeviceApprovalCard,
  useDevicePairing,
} from "~/components/settings/DevicePairing";
import { PairingQrCode } from "~/components/settings/PairingQrCode";
import { Button } from "~/components/ui/button";
import { CopyTextButton } from "~/components/ui/copyTextButton";
import { Spinner } from "~/components/ui/spinner";
import { useRemoteHostState } from "~/hooks/useRemoteHostState";
import { CircleCheckIcon, RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { OnboardingScreen, OnboardingStatusChip } from "../OnboardingScreen";
import { IPHONE_HEIGHT, IPHONE_WIDTH, IosScannerScreen, IphoneMock } from "../stage/IphoneMock";
import { ONBOARDING_STAGE_CARD_CLASS_NAME } from "../stage/stageTokens";

const PHONE_SCALE = 0.52;

const PAIR_STEPS = [
  "Open Synara on your iPhone",
  "Point the scanner at this code",
  "Approve it here if asked",
] as const;

export function PairStep(props: {
  readonly number: string;
  readonly computerNoun: string;
  readonly onNext: () => void;
  readonly onPaired: (deviceName: string) => void;
}) {
  const { state, refresh } = useRemoteHostState();
  const pairing = useDevicePairing({ createCode: true, state, onChanged: refresh });
  const { view, pending, joined, invitation, remaining, used, qrLink, busy, error } = pairing;
  const joinedNames = joined.map((device) => device.label).join(", ");

  const { onPaired } = props;
  useEffect(() => {
    if (joinedNames) onPaired(joinedNames);
  }, [joinedNames, onPaired]);

  const chip =
    view === "joined" ? (
      <OnboardingStatusChip tone="success">{joinedNames} connected</OnboardingStatusChip>
    ) : view === "approval" ? (
      <OnboardingStatusChip tone="live">Approve on this {props.computerNoun}</OnboardingStatusChip>
    ) : invitation && remaining ? (
      <OnboardingStatusChip tone="live">Waiting for iPhone</OnboardingStatusChip>
    ) : null;

  return (
    <OnboardingScreen
      number={props.number}
      lead="Connect your iPhone."
      statement="One scan and you're paired"
      description="Follow tasks and answer approvals from your iPhone, on Wi-Fi or mobile data."
      secondary={view === "joined" ? undefined : { label: "Later", onClick: props.onNext }}
      primary={view === "joined" ? { label: "Continue", onClick: props.onNext } : undefined}
      actionsExtra={chip}
    >
      <div className="flex min-h-full items-center justify-center gap-16 px-8 py-10">
        <div
          className={cn("w-[480px] max-w-full overflow-hidden", ONBOARDING_STAGE_CARD_CLASS_NAME)}
        >
          <div className="flex items-center gap-3 border-b border-foreground/8 px-4 py-3">
            <span aria-hidden className="flex gap-1.5">
              {[0, 1, 2].map((dot) => (
                <span key={dot} className="size-2.5 rounded-full bg-foreground/15" />
              ))}
            </span>
            <span className="truncate text-ui-sm text-muted-foreground">
              Settings › Connections › Connect a device
            </span>
          </div>

          {view === "approval" ? (
            <div className="flex flex-col gap-3 p-5">
              <p className="text-ui text-muted-foreground">
                {pending.length === 1
                  ? "A device used your pairing code. Approve it only if you recognize it and its fingerprint matches."
                  : "Devices used your pairing codes. Approve each only if you recognize it and its fingerprint matches."}
              </p>
              {pending.map((entry) => (
                <PendingDeviceApprovalCard
                  key={entry.inviteId}
                  entry={entry}
                  computerNoun={props.computerNoun}
                  busy={busy}
                  onApprove={() => void pairing.approve(entry)}
                  onReject={() => void pairing.reject(entry)}
                />
              ))}
            </div>
          ) : view === "joined" ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <CircleCheckIcon className="size-8 text-success" aria-hidden />
              <p className="text-ui-lg text-foreground">
                {joinedNames} {joined.length === 1 ? "is" : "are"} connected
              </p>
              <p className="text-ui text-muted-foreground">
                {joined.length === 1 ? "It" : "They"} can now control this {props.computerNoun}.
              </p>
            </div>
          ) : (
            <>
              <div className="flex gap-5 p-5">
                <div className="relative flex size-[200px] shrink-0 items-center justify-center">
                  {invitation ? (
                    <div
                      className={
                        remaining ? undefined : "pointer-events-none opacity-10 blur-[2px]"
                      }
                      aria-hidden={remaining ? undefined : true}
                    >
                      {qrLink ? (
                        <PairingQrCode
                          value={qrLink}
                          label={`Scan to connect to this ${props.computerNoun}`}
                          pixelSize={172}
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
                        onClick={() => void pairing.newCode()}
                      >
                        Try again
                      </Button>
                    </div>
                  ) : (
                    <p className="flex items-center gap-2 text-ui text-muted-foreground">
                      <Spinner className="size-4" aria-hidden />
                      Creating a code…
                    </p>
                  )}
                  {invitation && !remaining ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center">
                      <p className="text-ui font-semibold text-foreground">
                        {used ? "This code was used" : "This code expired"}
                      </p>
                      <Button
                        shape="capsule"
                        size="sm"
                        disabled={busy}
                        onClick={() => void pairing.newCode()}
                      >
                        New code
                      </Button>
                    </div>
                  ) : null}
                </div>
                <ol className="flex min-w-0 flex-col gap-3 pt-2">
                  {PAIR_STEPS.map((label, index) => (
                    <li key={label} className="flex gap-3 text-ui text-foreground">
                      <span className="pt-px font-mono text-ui-sm text-muted-foreground tabular-nums">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      {label}
                    </li>
                  ))}
                  {invitation && remaining ? (
                    <li className="pt-2 text-ui-sm leading-relaxed text-muted-foreground">
                      Can’t scan? Tap Pair with Code and enter{" "}
                      <span className="font-mono font-medium text-foreground">
                        {invitation.code}
                      </span>
                    </li>
                  ) : null}
                </ol>
              </div>
              <div className="flex h-11 items-center justify-between border-t border-foreground/8 ps-5 pe-3 text-ui-sm text-muted-foreground">
                <span className="tabular-nums">
                  {invitation && remaining
                    ? `Single-use · expires in ${remaining}`
                    : "Single-use code"}
                </span>
                {invitation && remaining ? (
                  <span className="flex items-center gap-0.5">
                    <CopyTextButton text={invitation.code} label="code" iconOnly />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="New code"
                      title="New code"
                      disabled={busy}
                      onClick={() => void pairing.newCode()}
                    >
                      <RefreshCwIcon className="size-3" />
                    </Button>
                  </span>
                ) : null}
              </div>
            </>
          )}
          {error && invitation ? (
            <p role="alert" className="px-5 pb-4 text-ui text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <div
          className="relative hidden shrink-0 lg:block"
          style={{ width: IPHONE_WIDTH * PHONE_SCALE, height: IPHONE_HEIGHT * PHONE_SCALE }}
        >
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{ transform: `scale(${PHONE_SCALE})` }}
          >
            <IphoneMock>
              <IosScannerScreen
                viewfinder={
                  qrLink ? (
                    <span className="block scale-[0.95] opacity-90">
                      <PairingQrCode value={qrLink} label="" pixelSize={180} />
                    </span>
                  ) : null
                }
              />
            </IphoneMock>
          </div>
        </div>
      </div>
    </OnboardingScreen>
  );
}
