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
import { useTranslation } from "~/i18n";
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

type Translate = ReturnType<typeof useTranslation>["t"];

/** Counts up to ten read as words ("seven more"); larger ones stay digits. */
function numberWord(t: Translate, count: number, locale: string): string {
  return count >= 1 && count <= 10
    ? t(`onboarding:numberWord${count}`)
    : new Intl.NumberFormat(locale).format(count);
}

function capitalize(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
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
  const { t, formatLocale } = useTranslation();
  const onMac = isMacNavigatorPlatform();
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
        {t("onboarding:skipIntro")}
      </button>
    </header>
  );

  const providerNames = VISIBLE_PROVIDER_DESCRIPTORS.slice(0, 3).map((d) => d.displayName);
  const moreProviders = VISIBLE_PROVIDER_DESCRIPTORS.length - providerNames.length;
  const agentList = new Intl.ListFormat(formatLocale, { type: "conjunction" }).format(
    moreProviders > 0
      ? [
          ...providerNames,
          t("onboarding:welcomeMoreAgents", {
            count: moreProviders,
            amount: numberWord(t, moreProviders, formatLocale),
          }),
        ]
      : providerNames,
  );
  const readyAgents = providerSummary.connected;

  const screen = (() => {
    switch (step) {
      case "welcome":
        return (
          <OnboardingScreen
            lead={t("onboarding:welcomeLead", { app: APP_BASE_NAME })}
            statement={t("onboarding:welcomeStatement")}
            description={t(
              onMac
                ? remoteAvailable
                  ? "onboarding:welcomeDescriptionMacRemote"
                  : "onboarding:welcomeDescriptionMac"
                : remoteAvailable
                  ? "onboarding:welcomeDescriptionComputerRemote"
                  : "onboarding:welcomeDescriptionComputer",
              { agents: agentList },
            )}
            actionsPlacement="inline"
            primary={{ label: t("common:getStarted"), onClick: goNext }}
            secondary={{
              label: t("onboarding:importFromAnotherApp"),
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
            lead={t("onboarding:agentsLead")}
            statement={
              providerSummary.detecting > 0
                ? t(onMac ? "onboarding:agentsCheckingMac" : "onboarding:agentsCheckingComputer")
                : readyAgents > 0
                  ? t(onMac ? "onboarding:agentsReadyMac" : "onboarding:agentsReadyComputer", {
                      count: readyAgents,
                      amount: capitalize(numberWord(t, readyAgents, formatLocale), formatLocale),
                    })
                  : t("onboarding:agentsSetUp")
            }
            description={t("onboarding:agentsDescription")}
            secondary={{ label: t("common:app_back"), onClick: goBack }}
            primary={{ label: t("git:continue"), onClick: goNext }}
          >
            <ProvidersStep detection={providerDetection} />
          </OnboardingScreen>
        );
      case "tasks":
        return (
          <OnboardingScreen
            number={stepNumber}
            lead={t("onboarding:tasksLead")}
            statement={t("onboarding:tasksStatement")}
            description={t("onboarding:tasksDescription", { app: APP_BASE_NAME })}
            secondary={{ label: t("common:app_back"), onClick: goBack }}
            primary={{ label: t("git:continue"), onClick: goNext }}
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
            lead={t(onMac ? "onboarding:pocketLeadMac" : "onboarding:pocketLeadComputer")}
            statement={t("onboarding:pocketStatement")}
            description={t("onboarding:pocketDescription", { app: APP_BASE_NAME })}
            secondary={{ label: t("common:app_back"), onClick: goBack }}
            primary={{ label: t("git:continue"), onClick: goNext }}
            stageClassName="overflow-hidden"
          >
            <div className="size-full px-8 pt-10">
              <FitStage {...POCKET_STAGE_SIZE} align="bottom">
                <PocketIllustration
                  host={t(onMac ? "onboarding:pocketHostMac" : "onboarding:pocketHostComputer")}
                />
              </FitStage>
            </div>
          </OnboardingScreen>
        );
      case "account":
        if (signedIn && needsProfile && account.me) {
          return (
            <OnboardingScreen
              number={stepNumber}
              numberSuffix={t("onboarding:optional")}
              lead={t("onboarding:profileLead")}
              statement={t("onboarding:profileStatement")}
              description={t("onboarding:profileDescription")}
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
            numberSuffix={t("onboarding:optional")}
            lead={t("onboarding:accountLead")}
            statement={t("onboarding:accountStatement")}
            description={t("onboarding:accountDescription")}
            secondary={{ label: t("common:app_back"), onClick: goBack }}
            primary={signedIn ? { label: t("git:continue"), onClick: goNext } : undefined}
            actionsExtra={
              signedIn ? null : (
                <Button
                  shape="capsule"
                  size="lg"
                  variant="outline"
                  className="bg-background/70 px-4"
                  onClick={goNext}
                >
                  {t("common:notNow")}
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
                    {t("onboarding:signedInAs", { email: account.me?.email ?? "" })}
                  </span>
                </div>
              </div>
            ) : (
              <AccountStep
                onMac={onMac}
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
        return <PairStep number={stepNumber} onMac={onMac} onNext={goNext} onPaired={onPaired} />;
      case "ready": {
        const receipt: OnboardingReceiptRow[] = [
          {
            label: t("onboarding:receiptAgents"),
            value:
              providerSummary.detecting > 0
                ? t("settings:checking")
                : readyAgents > 0
                  ? t("onboarding:receiptAgentsReady", { count: readyAgents })
                  : t("onboarding:receiptNoneYet"),
            done: readyAgents > 0,
          },
        ];
        if (remoteAvailable) {
          const me = account.me;
          receipt.push({
            label: t("onboarding:receiptAccount"),
            value: me
              ? me.profile?.handle
                ? `@${me.profile.handle}`
                : me.email
              : t("onboarding:receiptNotSignedIn"),
            done: me !== null,
          });
          receipt.push({
            label: t("onboarding:receiptIphone"),
            value: pairedDevice ?? t("onboarding:receiptNotConnected"),
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
