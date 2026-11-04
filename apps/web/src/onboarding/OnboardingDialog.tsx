// FILE: OnboardingDialog.tsx
// Purpose: First-run onboarding as a full-window experience: welcome → agents → tasks →
//          pocket → account → pair → ready, over the character-built landscape. Remote
//          steps appear only when this build can pair a phone; pairing only once signed in.
//          Owns step navigation and the per-run results the final receipt reads.
// Layer: Web UI overlay (mounted once from the root route)

import type { ProviderKind } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useAppSettings } from "~/appSettings";
import { APP_BASE_NAME } from "~/branding";
import { ProfileSetupForm } from "~/components/account/OnboardingDialog";
import { useAnnouncementSheetSlot } from "~/components/announcementSheetSlot";
import { CHAT_SURFACE_HEADER_HEIGHT_CLASS } from "~/components/chat/chatHeaderControls";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { isElectron } from "~/env";
import { useAccount } from "~/hooks/useAccount";
import { DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS } from "~/hooks/useDesktopTopBarGutter";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { CircleCheckIcon } from "~/lib/icons";
import { findProviderStatus } from "~/lib/providerAvailability";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../betaFeatures";
import {
  classifyProviderSetup,
  isOnboardingSetupStep,
  nextOnboardingStep,
  previousOnboardingStep,
  resolveOnboardingSteps,
  summarizeProviderSetup,
  type OnboardingStep,
} from "./logic";
import { OnboardingAsciiBackdrop } from "./OnboardingAsciiBackdrop";
import { useOnboardingDialogStore } from "./onboardingDialogStore";
import { OnboardingScreen } from "./OnboardingScreen";
import { FitStage } from "./stage/FitStage";
import { PROVIDER_RING_SIZE, ProviderRing } from "./stage/ProviderRing";
import {
  POCKET_STAGE_SIZE,
  PocketIllustration,
  TASKS_STAGE_SIZE,
  TasksIllustration,
} from "./stage/StageIllustrations";
import { ONBOARDING_STAGE_CARD_CLASS_NAME } from "./stage/stageTokens";
import { AccountStep } from "./steps/AccountStep";
import { PairStep } from "./steps/PairStep";
import { ProvidersStep } from "./steps/ProvidersStep";
import { type OnboardingReceiptRow, ReadyStep } from "./steps/ReadyStep";
import { useProviderDetection } from "./useProviderDetection";

const NUMBER_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function numberWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function OnboardingFlow(props: {
  surfaceRef: RefObject<HTMLDivElement | null>;
  onComplete: () => void;
  projectBusy: boolean;
  onProjectBusyChange: (busy: boolean) => void;
}) {
  const { settings } = useAppSettings();
  const account = useAccount();
  const statuses = useProviderStatusesForLocalConfig();
  const providerDetection = useProviderDetection();
  const openProjectImport = useProjectImportDialogStore((store) => store.openDialog);
  const markEngaged = useOnboardingDialogStore((store) => store.markEngaged);
  const computerNoun = isMacNavigatorPlatform() ? "Mac" : "computer";
  const remoteAvailable =
    readExecutionContext()?.controller.capabilities.remoteConnections === true;

  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [pairedDevice, setPairedDevice] = useState<string | null>(null);

  // Latched once the account status is known: signing in on the account step must not
  // pull that step out from under the user.
  const accountState = account.status?.state;
  const [offerAccount, setOfferAccount] = useState<boolean | null>(null);
  useEffect(() => {
    if (offerAccount === null && accountState !== undefined) {
      setOfferAccount(accountState !== "signed-in");
    }
  }, [accountState, offerAccount]);
  const signedIn = accountState === "signed-in";
  // A first sign-in still owes a profile; the account step collects it in place of the
  // old stacked modal.
  const needsProfile =
    account.profileSyncEnabled && account.me !== null && (account.me.profile ?? null) === null;
  const afterAccount: OnboardingStep = remoteAvailable ? "pair" : "ready";

  const steps = resolveOnboardingSteps({
    remoteAvailable,
    offerAccount: offerAccount ?? true,
    signedIn,
  });
  const goBack = () => setStep(previousOnboardingStep(steps, step));
  const goNext = () => setStep(nextOnboardingStep(steps, step));
  const stepIndex = Math.max(0, steps.indexOf(step));
  const stepNumber = String(stepIndex + 1).padStart(2, "0");

  // Once the user reaches a setup step the first-run gate must not auto-close the dialog.
  useEffect(() => {
    if (isOnboardingSetupStep(step)) markEngaged();
  }, [markEngaged, step]);

  const providerRows = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => ({
    provider: descriptor.kind,
    state: classifyProviderSetup({
      status: findProviderStatus(statuses, descriptor.kind),
      disabled: settings.disabledProviders.includes(descriptor.kind),
      detecting: providerDetection.detecting,
      detectionFailed: providerDetection.failed,
    }),
  }));
  const providerSummary = summarizeProviderSetup(providerRows);
  const liveProviderKey = providerRows
    .filter((row) => row.state === "connected")
    .map((row) => row.provider)
    .join(",");
  const liveProviders = useMemo<ReadonlySet<ProviderKind>>(
    () =>
      new Set(providerRows.filter((row) => row.state === "connected").map((row) => row.provider)),
    // Keyed by the connected set, not the rows array rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveProviderKey],
  );

  // A new project finishes the tour, once its creation has fully settled.
  const [finishAfterProject, setFinishAfterProject] = useState(false);
  const { onComplete, projectBusy } = props;
  useEffect(() => {
    if (finishAfterProject && !projectBusy) onComplete();
  }, [finishAfterProject, projectBusy, onComplete]);

  const onPaired = useCallback((deviceName: string) => setPairedDevice(deviceName), []);

  const header = (
    <header
      className={cn(
        "drag-region relative z-20 flex shrink-0 items-center gap-2.5 border-b border-foreground/8 bg-background ps-5 pe-6",
        CHAT_SURFACE_HEADER_HEIGHT_CLASS,
        isElectron && isMacNavigatorPlatform() && DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS,
      )}
    >
      <img src="/app-icons/dark.png" alt="" className="size-[26px] shrink-0" draggable={false} />
      <span className="text-ui-lg font-medium tracking-[-0.01em] text-foreground">
        {APP_BASE_NAME}
      </span>
      <span className="flex-1" />
      <span className="pe-4 text-ui-sm text-muted-foreground tabular-nums">
        {stepNumber} / {String(steps.length).padStart(2, "0")}
      </span>
      <button
        type="button"
        disabled={props.projectBusy}
        className="cursor-pointer text-ui text-foreground transition-opacity hover:opacity-70 disabled:opacity-50 motion-reduce:transition-none"
        onClick={props.onComplete}
      >
        Skip intro
      </button>
    </header>
  );

  const providerNames = VISIBLE_PROVIDER_DESCRIPTORS.slice(0, 3).map((d) => d.displayName);
  const moreProviders = VISIBLE_PROVIDER_DESCRIPTORS.length - providerNames.length;

  const screen = (() => {
    switch (step) {
      case "welcome":
        return (
          <OnboardingScreen
            lead={`Meet ${APP_BASE_NAME},`}
            statement="every agent in one workspace"
            description={`${providerNames.join(", ")}${moreProviders > 0 ? ` and ${numberWord(moreProviders)} more` : ""}, side by side on your ${computerNoun}${remoteAvailable ? " and on your phone" : ""}.`}
            actionsPlacement="inline"
            primary={{ label: "Get started", onClick: goNext }}
            secondary={{
              label: "Import from another app",
              onClick: () => {
                // Importing creates projects; keep the first-run gate from closing the tour.
                markEngaged();
                openProjectImport();
              },
            }}
            stageClassName="overflow-hidden"
          >
            <FitStage width={PROVIDER_RING_SIZE + 80} height={PROVIDER_RING_SIZE + 40}>
              <div className="flex size-full items-center justify-center">
                <ProviderRing live={liveProviders} />
              </div>
            </FitStage>
          </OnboardingScreen>
        );
      case "agents":
        return (
          <OnboardingScreen
            number={stepNumber}
            lead="Bring your agents."
            statement={
              providerSummary.detecting > 0
                ? `Checking this ${computerNoun}…`
                : providerSummary.connected > 0
                  ? `${capitalize(numberWord(providerSummary.connected))} ${providerSummary.connected === 1 ? "is" : "are"} ready on this ${computerNoun}`
                  : "Set up the ones you use"
            }
            description="Each keeps its own login, models and limits. Turn any off, or set up the rest later from Settings."
            secondary={{ label: "Back", onClick: goBack }}
            primary={{ label: "Continue", onClick: goNext }}
          >
            <ProvidersStep detection={providerDetection} />
          </OnboardingScreen>
        );
      case "tasks":
        return (
          <OnboardingScreen
            number={stepNumber}
            lead="Run them all at once."
            statement="Every task gets its own worktree"
            description={`Review the diff, run the tests and open the PR without leaving ${APP_BASE_NAME}.`}
            secondary={{ label: "Back", onClick: goBack }}
            primary={{ label: "Continue", onClick: goNext }}
            stageClassName="overflow-hidden"
          >
            <div className="size-full px-8 py-10">
              <FitStage {...TASKS_STAGE_SIZE}>
                <TasksIllustration />
              </FitStage>
            </div>
          </OnboardingScreen>
        );
      case "pocket":
        return (
          <OnboardingScreen
            number={stepNumber}
            lead={`Your ${computerNoun}, in your pocket.`}
            statement="Step away, keep going"
            description={`${APP_BASE_NAME} for iPhone picks up any task and answers approvals, wherever you are.`}
            secondary={{ label: "Back", onClick: goBack }}
            primary={{ label: "Continue", onClick: goNext }}
            stageClassName="overflow-hidden"
          >
            <div className="size-full px-8 pt-10">
              <FitStage {...POCKET_STAGE_SIZE} align="bottom">
                <PocketIllustration host={`My ${computerNoun === "Mac" ? "Mac" : "PC"}`} />
              </FitStage>
            </div>
          </OnboardingScreen>
        );
      case "account":
        if (signedIn && needsProfile && account.me) {
          return (
            <OnboardingScreen
              number={stepNumber}
              numberSuffix="optional"
              lead="You're signed in."
              statement="Now pick your handle"
              description="Your profile stays private until you publish it from Edit profile."
            >
              <div className="flex min-h-full items-start justify-center px-8 pt-14 pb-10">
                <div className={cn("w-[420px] max-w-full p-6", ONBOARDING_STAGE_CARD_CLASS_NAME)}>
                  <ProfileSetupForm
                    variant="embedded"
                    me={account.me}
                    onFinished={() => setStep(afterAccount)}
                  />
                </div>
              </div>
            </OnboardingScreen>
          );
        }
        return (
          <OnboardingScreen
            number={stepNumber}
            numberSuffix="optional"
            lead="Sign in to go remote."
            statement="Only needed for your iPhone"
            description="Everything else works without an account. You can sign in later from Settings."
            secondary={{ label: "Back", onClick: goBack }}
            primary={signedIn ? { label: "Continue", onClick: goNext } : undefined}
            actionsExtra={
              signedIn ? null : (
                <Button
                  shape="capsule"
                  size="lg"
                  variant="outline"
                  className="bg-background/70 px-4"
                  onClick={goNext}
                >
                  Not now
                </Button>
              )
            }
          >
            {signedIn ? (
              <div className="flex min-h-full items-start justify-center px-8 pt-14">
                <div
                  className={cn(
                    "flex w-[420px] max-w-full items-center gap-3 p-6",
                    ONBOARDING_STAGE_CARD_CLASS_NAME,
                  )}
                >
                  <CircleCheckIcon className="size-5 shrink-0 text-success" aria-hidden />
                  <span className="min-w-0 truncate text-ui text-foreground">
                    Signed in as {account.me?.email}
                  </span>
                </div>
              </div>
            ) : (
              <AccountStep
                computerNoun={computerNoun}
                onSignedIn={(status) => {
                  if (status.state !== "signed-in") return;
                  // A new account stays here for its profile; otherwise go pair the phone.
                  const owesProfile =
                    account.profileSyncEnabled && (status.me.profile ?? null) === null;
                  if (!owesProfile) setStep(afterAccount);
                }}
              />
            )}
          </OnboardingScreen>
        );
      case "pair":
        return (
          <PairStep
            number={stepNumber}
            computerNoun={computerNoun}
            onNext={goNext}
            onPaired={onPaired}
          />
        );
      case "ready": {
        const receipt: OnboardingReceiptRow[] = [
          {
            label: "Agents",
            value:
              providerSummary.detecting > 0
                ? "Checking…"
                : providerSummary.connected > 0
                  ? `${providerSummary.connected} ready`
                  : "None yet",
            done: providerSummary.connected > 0,
          },
        ];
        if (remoteAvailable) {
          const me = account.me;
          receipt.push({
            label: "Account",
            value: me ? (me.profile?.handle ? `@${me.profile.handle}` : me.email) : "Not signed in",
            done: me !== null,
          });
          receipt.push({
            label: "iPhone",
            value: pairedDevice ?? "Not connected",
            done: pairedDevice !== null,
          });
        }
        return (
          <ReadyStep
            receipt={receipt}
            live={liveProviders}
            onProjectAdded={() => setFinishAfterProject(true)}
            onExplore={props.onComplete}
            onBusyChange={props.onProjectBusyChange}
          />
        );
      }
    }
  })();

  return (
    <div
      ref={props.surfaceRef}
      className="relative flex min-h-0 flex-1 flex-col outline-none"
      tabIndex={-1}
    >
      <OnboardingAsciiBackdrop />
      {/* Keeps the hero copy legible over the landscape. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[400px] bg-linear-to-b from-background/90 via-background/80 via-65% to-transparent"
      />
      {header}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">{screen}</div>
    </div>
  );
}

export function OnboardingDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  // The first-run gate already decides eligibility. Replays remain available after
  // a startup handoff, but still share the slot with any surface currently showing.
  const { open } = useAnnouncementSheetSlot(props.open, true, false);
  // Project creation cannot be aborted: closing the tour mid-create would report a skip
  // while a project still appears afterwards, so dismissal waits for it to settle.
  const [projectBusy, setProjectBusy] = useState(false);
  // Focus the surface, not the first control ("Skip intro"), so Enter means "continue".
  const surfaceRef = useRef<HTMLDivElement>(null);
  const handleOpenChange = (open: boolean) => {
    if (!open && projectBusy) return;
    props.onOpenChange(open);
  };
  const complete = () => {
    if (projectBusy) return;
    props.onComplete();
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup
        fullScreen
        showCloseButton={false}
        initialFocus={surfaceRef}
        className="overflow-hidden bg-background"
      >
        {/* Remount per open so a replay from Settings starts at the first step. */}
        {open ? (
          <OnboardingFlow
            surfaceRef={surfaceRef}
            onComplete={complete}
            projectBusy={projectBusy}
            onProjectBusyChange={setProjectBusy}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
