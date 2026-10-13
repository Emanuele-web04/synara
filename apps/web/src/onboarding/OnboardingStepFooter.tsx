// FILE: OnboardingStepFooter.tsx
// Purpose: Shared footer for every welcome-tour step: progress dots, Skip, Back, primary.
//          No divider — space alone separates the footer from the body.
// Layer: Web UI component

import { Button } from "~/components/ui/button";
import { DialogFooter } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { ONBOARDING_INSET_CLASS_NAME } from "./layout";
import { ONBOARDING_STEPS, type OnboardingStep } from "./logic";
import { useTranslation } from "~/i18n";

const FOOTER_BUTTON_CLASS_NAME = "px-4 text-ui-lg sm:text-ui-lg";

export function OnboardingStepFooter(props: {
  step: OnboardingStep;
  onBack: () => void;
  onSkip: () => void;
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryBusy?: boolean;
  /** Blocks Back and Skip as well as the primary (a non-abortable operation is running). */
  navigationLocked?: boolean;
  /** Optional secondary action rendered next to the primary (e.g. "Skip for now"). */
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const { t } = useTranslation();

  const stepIndex = ONBOARDING_STEPS.indexOf(props.step);
  const showBack = props.step !== "welcome" && props.step !== "done";
  const showSkip = props.step !== "done";
  return (
    <DialogFooter
      variant="bare"
      className={cn("items-center gap-2 pt-5 pb-6", ONBOARDING_INSET_CLASS_NAME)}
    >
      <div className="flex flex-1 items-center gap-4">
        <div
          className="flex items-center gap-1.5"
          role="progressbar"
          aria-label={t("Setup progress")}
          aria-valuemin={1}
          aria-valuemax={ONBOARDING_STEPS.length}
          aria-valuenow={stepIndex + 1}
        >
          {ONBOARDING_STEPS.map((step, index) => (
            <span
              key={step}
              className={cn(
                "size-1.5 rounded-full transition-colors motion-reduce:transition-none",
                index === stepIndex
                  ? "bg-foreground"
                  : index < stepIndex
                    ? "bg-foreground/50"
                    : "bg-muted-foreground/30",
              )}
            />
          ))}
        </div>
        {showSkip ? (
          <Button
            variant="ghost"
            size="sm"
            shape="capsule"
            className="-ml-2 text-muted-foreground hover:text-foreground"
            disabled={props.navigationLocked}
            onClick={props.onSkip}
          >
            {t("Skip setup")}
          </Button>
        ) : null}
      </div>
      {showBack ? (
        <Button
          variant="ghost"
          shape="capsule"
          className={FOOTER_BUTTON_CLASS_NAME}
          disabled={props.navigationLocked}
          onClick={props.onBack}
        >
          {t("Back")}
        </Button>
      ) : null}
      {props.secondaryLabel && props.onSecondary ? (
        <Button
          variant="outline"
          shape="capsule"
          className={FOOTER_BUTTON_CLASS_NAME}
          onClick={props.onSecondary}
        >
          {props.secondaryLabel}
        </Button>
      ) : null}
      <Button
        variant="prominent"
        shape="capsule"
        className={cn(FOOTER_BUTTON_CLASS_NAME, "hover:scale-100")}
        disabled={props.primaryDisabled || props.primaryBusy || props.navigationLocked}
        onClick={props.onPrimary}
      >
        {props.primaryBusy ? t("Working…") : props.primaryLabel}
      </Button>
    </DialogFooter>
  );
}
